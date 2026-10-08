import { randomBytes } from "node:crypto";
import pg from "pg";
import Cursor from "pg-cursor";
import { config, requiredEnv } from "../config.ts";
import { friendlyError, lineCol } from "./errors.ts";
import { classify, splitStatements } from "./split.ts";

/**
 * SQL practice sandbox.
 *
 * Every run gets a fresh connection (as the restricted `learner` role) and one transaction that
 * is never committed: the dataset is replayed into a random throwaway schema, learner SQL runs
 * inside it, then the connection closes and PostgreSQL discards everything. Learner BEGIN /
 * COMMIT / ROLLBACK are emulated with savepoints, so nothing a learner sends can end the outer
 * transaction. A watchdog terminates the backend if a session outlives its budget (a learner
 * could raise statement_timeout from inside plpgsql).
 */

export type Cell = string | null;
export type TypeCategory = "number" | "text" | "boolean" | "date" | "json" | "other";
export interface Column {
  name: string;
  type: TypeCategory;
}
export interface ResultSet {
  command: string;
  columns: Column[];
  rows: Cell[][];
  rowCount: number;
  truncated: boolean;
}
export type RunStatus = "ok" | "error" | "timeout" | "unsafe";
export interface RunResult {
  status: RunStatus;
  results: ResultSet[];
  message?: string;
  hint?: string;
  position?: { line: number; col: number };
  notices: string[];
}

export class SandboxUnavailableError extends Error {}
export class DatasetError extends Error {}

const CATEGORY: Record<number, TypeCategory> = {
  16: "boolean",
  20: "number", 21: "number", 23: "number", 26: "number", 700: "number", 701: "number", 790: "number", 1700: "number",
  25: "text", 1042: "text", 1043: "text", 18: "text", 19: "text", 2950: "text",
  1082: "date", 1083: "date", 1114: "date", 1184: "date", 1186: "date", 1266: "date",
  114: "json", 3802: "json",
};

// Keep PostgreSQL's canonical text for every value: comparisons and display stay faithful.
const RAW_TYPES = { getTypeParser: () => (value: string) => value } as unknown as pg.CustomTypesConfig;

export class SandboxSession {
  readonly notices: string[] = [];
  timedOut = false;
  private inUserTx = false;
  private readonly txSavepoint = `dsa_tx_${randomBytes(4).toString("hex")}`;

  private readonly client: pg.Client;
  readonly tables: string[];

  constructor(client: pg.Client, tables: string[] = []) {
    this.client = client;
    this.tables = tables;
  }

  /** Trusted, multi-statement SQL (simple protocol). */
  async exec(sql: string) {
    await this.client.query(sql);
  }

  /** Trusted single statement, read through a row-limited cursor. */
  query(text: string, maxRows = config.sql.maxCompareRows): Promise<ResultSet> {
    const cursor = this.client.query(new Cursor(text, [], { rowMode: "array", types: RAW_TYPES }));
    return new Promise((resolve, reject) => {
      cursor.read(maxRows + 1, (err, rows: Cell[][], result) => {
        if (err) return reject(err);
        const columns = (result.fields ?? []).map((f) => ({ name: f.name, type: CATEGORY[f.dataTypeID] ?? "other" }));
        const truncated = rows.length > maxRows;
        cursor.close(() =>
          resolve({
            command: result.command ?? (columns.length ? "SELECT" : ""),
            columns,
            rows: truncated ? rows.slice(0, maxRows) : rows,
            rowCount: result.rowCount ?? rows.length,
            truncated,
          }),
        );
      });
    });
  }

  /** Learner SQL: allow-listed statements only, stops at the first error. */
  async run(source: string, maxRows = config.sql.maxRows): Promise<RunResult> {
    const results: ResultSet[] = [];
    const done = (status: RunStatus, extra: Partial<RunResult> = {}): RunResult => ({ status, results, notices: this.notices, ...extra });
    if (source.length > config.sql.maxSqlLength) return done("unsafe", { message: `Your SQL is too long (maximum ${config.sql.maxSqlLength} characters).` });
    const statements = splitStatements(source);
    if (!statements.length) return done("error", { message: "There is no SQL to run yet." });
    if (statements.length > config.sql.maxStatements) return done("unsafe", { message: `Too many statements (maximum ${config.sql.maxStatements}).` });
    for (const s of statements) {
      const c = classify(s.text);
      if (c.kind === "blocked")
        return done("unsafe", {
          message: `${c.keyword} statements are not available in the practice sandbox.`,
          hint: "Allowed: SELECT, WITH, INSERT, UPDATE, DELETE, MERGE, CREATE, ALTER, DROP, TRUNCATE, EXPLAIN, SHOW, CALL, DO and BEGIN/COMMIT/ROLLBACK/SAVEPOINT.",
        });
    }

    for (const s of statements) {
      const c = classify(s.text);
      try {
        if (c.kind === "begin") {
          if (this.inUserTx) this.notices.push("WARNING: there is already a transaction in progress");
          else await this.exec(`SAVEPOINT ${this.txSavepoint}`);
          this.inUserTx = true;
          results.push(commandOnly("BEGIN"));
        } else if (c.kind === "commit" || c.kind === "rollback") {
          if (!this.inUserTx) this.notices.push("WARNING: there is no transaction in progress");
          else if (c.kind === "commit") await this.exec(`RELEASE SAVEPOINT ${this.txSavepoint}`);
          else await this.exec(`ROLLBACK TO SAVEPOINT ${this.txSavepoint}; RELEASE SAVEPOINT ${this.txSavepoint}`);
          this.inUserTx = false;
          results.push(commandOnly(c.kind === "commit" ? "COMMIT" : "ROLLBACK"));
        } else results.push(await this.query(s.text, maxRows));
      } catch (e) {
        const err = e as pg.DatabaseError;
        if (this.timedOut || err.code === "57014" || err.code === "57P01")
          return done("timeout", {
            message: `Query timed out. Maximum execution time: ${config.sql.statementTimeoutMs / 1000} seconds.`,
            hint: "A missing JOIN condition multiplies rows; check your joins and filters.",
          });
        if (!err.code) throw new SandboxUnavailableError(err.message);
        const friendly = friendlyError(err, this.tables);
        const position = err.position ? lineCol(source, s.start + Number(err.position) - 1) : undefined;
        return done("error", { ...friendly, position });
      }
    }
    return done("ok");
  }

  /** Forget learner transaction state (after rolling back to an outer savepoint). */
  resetUserTx() {
    this.inUserTx = false;
  }

  /** Whether the learner's SQL left a BEGIN without its COMMIT or ROLLBACK. */
  get inTransaction() {
    return this.inUserTx;
  }
}

const commandOnly = (command: string): ResultSet => ({ command, columns: [], rows: [], rowCount: 0, truncated: false });

/** The result set a learner would look at: the last statement that produced columns. */
export function lastResultSet(run: RunResult): ResultSet | undefined {
  return [...run.results].reverse().find((r) => r.columns.length) ?? run.results.at(-1);
}

async function terminate(pid: number) {
  const supervisor = new pg.Client({ connectionString: requiredEnv("SANDBOX_SUPERVISOR_URL"), connectionTimeoutMillis: 3000 });
  try {
    await supervisor.connect();
    await supervisor.query("SELECT pg_terminate_backend($1)", [pid]);
  } catch (e) {
    console.error("sandbox watchdog failed", e);
  } finally {
    await supervisor.end().catch(() => {});
  }
}

export async function withSandbox<T>(setupSql: string, fn: (s: SandboxSession) => Promise<T>, tables: string[] = []): Promise<T> {
  const client = new pg.Client({
    connectionString: requiredEnv("SANDBOX_DATABASE_URL"),
    connectionTimeoutMillis: 5000,
    application_name: "dsa-sandbox",
  });
  client.on("error", () => {}); // a terminated backend surfaces as a query error instead
  try {
    await client.connect();
  } catch (e) {
    const code = (e as pg.DatabaseError).code;
    if (code === "53300") throw new SandboxUnavailableError("busy");
    throw new SandboxUnavailableError((e as Error).message);
  }
  const session = new SandboxSession(client, tables);
  client.on("notice", (n) => {
    if (session.notices.length < 20) session.notices.push(`${n.severity ?? "NOTICE"}: ${n.message}`);
  });
  const pid: number = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  const watchdog = setTimeout(() => {
    session.timedOut = true;
    void terminate(pid);
  }, config.sql.sessionTimeoutMs);
  try {
    const schema = `run_${randomBytes(8).toString("hex")}`;
    await client.query(
      `BEGIN; SET LOCAL statement_timeout = ${config.sql.statementTimeoutMs}; SET LOCAL lock_timeout = 1000; ` +
        `SET LOCAL TimeZone = 'UTC'; CREATE SCHEMA ${schema}; SET LOCAL search_path = ${schema};`,
    );
    try {
      if (setupSql.trim()) await client.query(setupSql);
    } catch (e) {
      throw new DatasetError((e as Error).message);
    }
    session.notices.length = 0;
    return await fn(session);
  } finally {
    clearTimeout(watchdog);
    await client.end().catch(() => {}); // closing the connection discards the transaction
  }
}

export const runQuery = (setupSql: string, sql: string, tables: string[] = []) => withSandbox(setupSql, (s) => s.run(sql), tables);

export interface TableInfo {
  name: string;
  rowCount: number;
  columns: { name: string; type: string; nullable: boolean; key?: "PK" | "FK"; references?: string }[];
}

/** Tables, columns, keys and row counts of a dataset (for the schema browser). */
export function describeDataset(setupSql: string): Promise<TableInfo[]> {
  return withSandbox(setupSql, async (s) => {
    const cols = await s.query(
      `SELECT c.relname, a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull::text, a.attnum::text
         FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
        WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind IN ('r','v','m','p')
          AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY c.oid, a.attnum`,
    );
    const keys = await s.query(
      `SELECT c.conrelid::regclass::text, c.contype::text, k.attnum::text, c.confrelid::regclass::text, f.attname
         FROM pg_constraint c
         CROSS JOIN LATERAL unnest(c.conkey, c.confkey) AS k(attnum, fnum)
         LEFT JOIN pg_attribute f ON f.attrelid = c.confrelid AND f.attnum = k.fnum
        WHERE c.connamespace = current_schema()::regnamespace AND c.contype IN ('p','f')`,
    );
    const tables = new Map<string, TableInfo>();
    for (const [table, column, type, notNull, attnum] of cols.rows as string[][]) {
      if (!tables.has(table)) tables.set(table, { name: table, rowCount: 0, columns: [] });
      const key = keys.rows.find((k) => k[0] === table && k[2] === attnum);
      tables.get(table)!.columns.push({
        name: column,
        type,
        nullable: notNull !== "true",
        ...(key && { key: key[1] === "p" ? ("PK" as const) : ("FK" as const) }),
        ...(key?.[1] === "f" && { references: `${key[3]}.${key[4]}` }),
      });
    }
    if (tables.size) {
      const counts = await s.query(`SELECT ${[...tables.keys()].map((t) => `(SELECT count(*) FROM "${t.replace(/"/g, '""')}")`).join(", ")}`);
      [...tables.values()].forEach((t, i) => (t.rowCount = Number(counts.rows[0][i])));
    }
    return [...tables.values()];
  });
}
