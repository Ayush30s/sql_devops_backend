export interface SqlStatement {
  text: string;
  /** Offset of `text` inside the original source (for error positions). */
  start: number;
}

/** Index just past a (possibly nested) block comment starting at `i`. */
function skipBlockComment(sql: string, i: number): number {
  let depth = 0;
  while (i < sql.length) {
    if (sql.startsWith("/*", i)) {
      depth++;
      i += 2;
    } else if (sql.startsWith("*/", i)) {
      depth--;
      i += 2;
      if (depth === 0) return i;
    } else i++;
  }
  return sql.length;
}

/** Splits SQL into statements, respecting quotes, E'' strings, dollar quoting and comments. */
export function splitStatements(sql: string): SqlStatement[] {
  const out: SqlStatement[] = [];
  let start = 0;
  let i = 0;
  const push = (end: number) => {
    const raw = sql.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    if (firstKeyword(raw)) out.push({ text: raw.trim(), start: start + lead });
  };
  while (i < sql.length) {
    const c = sql[i];
    if (sql.startsWith("--", i)) {
      const nl = sql.indexOf("\n", i);
      i = nl < 0 ? sql.length : nl + 1;
    } else if (sql.startsWith("/*", i)) {
      i = skipBlockComment(sql, i);
    } else if (c === "'") {
      const backslashEscapes = /[eE]/.test(sql[i - 1] ?? "") && !/[\w$]/.test(sql[i - 2] ?? "");
      i++;
      while (i < sql.length) {
        if (backslashEscapes && sql[i] === "\\") i += 2;
        else if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") break;
        else i++;
      }
      i++;
    } else if (c === '"') {
      i++;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') i += 2;
        else if (sql[i] === '"') break;
        else i++;
      }
      i++;
    } else if (c === "$" && !/[\w$]/.test(sql[i - 1] ?? "")) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        i = end < 0 ? sql.length : end + tag.length;
      } else i++;
    } else if (c === ";") {
      push(i);
      start = ++i;
    } else i++;
  }
  push(sql.length);
  return out;
}

/** Leading keywords of a statement, upper-cased, skipping comments and opening parentheses. */
export function leadingWords(stmt: string, count = 3): string[] {
  let i = 0;
  for (;;) {
    while (i < stmt.length && /[\s(]/.test(stmt[i])) i++;
    if (stmt.startsWith("--", i)) {
      const nl = stmt.indexOf("\n", i);
      i = nl < 0 ? stmt.length : nl + 1;
    } else if (stmt.startsWith("/*", i)) i = skipBlockComment(stmt, i);
    else break;
  }
  return (stmt.slice(i).match(/[A-Za-z_]+/g) ?? []).slice(0, count).map((w) => w.toUpperCase());
}

export const firstKeyword = (stmt: string) => leadingWords(stmt, 1)[0] ?? "";

const ALLOWED = new Set([
  "SELECT", "WITH", "VALUES", "TABLE", "SHOW", "EXPLAIN",
  "INSERT", "UPDATE", "DELETE", "MERGE",
  "CREATE", "ALTER", "DROP", "TRUNCATE", "COMMENT", "REFRESH", "CALL", "DO", "ANALYZE", "LOCK",
]);

/**
 * Server-wide objects, even though the learner role may not create them anyway.
 * Blocking them here keeps the refusal message honest instead of a permission error.
 */
const BLOCKED_OBJECTS = new Set(["EXTENSION", "ROLE", "USER", "DATABASE", "TABLESPACE", "SERVER", "SUBSCRIPTION", "PUBLICATION", "LANGUAGE", "SYSTEM"]);

export type Classified =
  | { kind: "run" }
  | { kind: "begin" | "commit" | "rollback" }
  | { kind: "blocked"; keyword: string };

/**
 * Allow-list classification. Transaction control is emulated with savepoints by the
 * sandbox so a learner can never end the outer (always rolled back) transaction.
 */
export function classify(stmt: string): Classified {
  const [a, b] = leadingWords(stmt, 2);
  switch (a) {
    case "BEGIN":
    case "START":
      return { kind: "begin" };
    case "COMMIT":
    case "END":
      return b === "PREPARED" ? { kind: "blocked", keyword: "COMMIT PREPARED" } : { kind: "commit" };
    case "ROLLBACK":
    case "ABORT":
      if (b === "PREPARED") return { kind: "blocked", keyword: "ROLLBACK PREPARED" };
      return b === "TO" ? { kind: "run" } : { kind: "rollback" };
    case "SAVEPOINT":
    case "RELEASE":
      return { kind: "run" };
  }
  if (!ALLOWED.has(a)) return { kind: "blocked", keyword: a || "?" };
  if ((a === "CREATE" || a === "ALTER" || a === "DROP") && b && BLOCKED_OBJECTS.has(b)) return { kind: "blocked", keyword: `${a} ${b}` };
  return { kind: "run" };
}
