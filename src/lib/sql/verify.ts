import { config } from "../config.ts";
import type { Cell, ResultSet, RunResult } from "./sandbox.ts";
import { lastResultSet, withSandbox } from "./sandbox.ts";

export type Verification = "EXACT_RESULT" | "UNORDERED_RESULT" | "ORDERED_RESULT" | "ROW_COUNT" | "SCHEMA" | "CUSTOM";

export interface Verdict {
  pass: boolean;
  message: string;
}

const NUMERIC = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;

/** Canonical form of a cell: numbers compare by value (12.50 = 12.5), text exactly, NULL as null. */
export function normalizeCell(value: Cell, decimals?: number): string | null {
  if (value === null) return null;
  if (!NUMERIC.test(value.trim())) return value;
  const n = Number(value);
  if (decimals !== undefined) return n.toFixed(decimals);
  return String(Number(n.toPrecision(12)));
}

const rowKey = (row: Cell[], decimals?: number) => JSON.stringify(row.map((v) => normalizeCell(v, decimals)));

/** Elements of `a` not matched one-for-one in `b`. */
function missingFrom(a: string[], b: string[]): string[] {
  const pool = new Map<string, number>();
  for (const k of b) pool.set(k, (pool.get(k) ?? 0) + 1);
  return a.filter((k) => {
    const n = pool.get(k);
    if (!n) return true;
    pool.set(k, n - 1);
    return false;
  });
}

const sameMultiset = (a: string[], b: string[]) => a.length === b.length && missingFrom(a, b).length === 0;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const show = (key: string) => `(${(JSON.parse(key) as (string | null)[]).map((v) => (v === null ? "NULL" : v)).join(", ")})`;
const pass = (): Verdict => ({ pass: true, message: "Correct!" });
const fail = (message: string): Verdict => ({ pass: false, message });

export function compareResults(expected: ResultSet, actual: ResultSet, mode: Verification): Verdict {
  if (mode === "ROW_COUNT")
    return actual.rows.length === expected.rows.length
      ? pass()
      : fail(`Expected ${plural(expected.rows.length, "row")}, but your query returned ${actual.rows.length}.`);

  const eNames = expected.columns.map((c) => c.name.toLowerCase());
  const aNames = actual.columns.map((c) => c.name.toLowerCase());
  if (aNames.length !== eNames.length)
    return fail(
      `Expected ${plural(eNames.length, "column")} (${eNames.join(", ")}), but your query returned ${aNames.length}` +
        (aNames.length ? ` (${aNames.join(", ")}).` : "."),
    );

  let order = aNames.map((_, i) => i);
  if (mode === "EXACT_RESULT") {
    const i = eNames.findIndex((n, j) => n !== aNames[j]);
    if (i >= 0) return fail(`Column ${i + 1} should be named "${eNames[i]}", but yours is "${aNames[i]}". Rename it with AS ${eNames[i]}.`);
    const t = expected.columns.findIndex((c, j) => c.type !== actual.columns[j].type && c.type !== "other" && actual.columns[j].type !== "other");
    if (t >= 0) return fail(`Column "${eNames[t]}" should hold ${expected.columns[t].type} values, but yours holds ${actual.columns[t].type} values.`);
  } else if (new Set(aNames).size === aNames.length && eNames.every((n) => aNames.includes(n))) {
    // Same column names in a different order: compare by name.
    order = eNames.map((n) => aNames.indexOf(n));
  }

  const aligned = actual.rows.map((r) => order.map((i) => r[i]));
  const ek = expected.rows.map((r) => rowKey(r));
  const ak = aligned.map((r) => rowKey(r));
  const ordered = mode === "ORDERED_RESULT" || mode === "EXACT_RESULT";
  if (sameMultiset(ek, ak)) {
    if (!ordered || ek.every((k, i) => k === ak[i])) return pass();
    return fail("Your query returned the correct rows, but in the wrong order. Check your ORDER BY.");
  }

  const unique = [...new Set(ak)];
  if (unique.length < ak.length && sameMultiset(ek, unique))
    return fail("Your result contains duplicate rows. DISTINCT, or a more precise JOIN condition, would remove them.");

  const rounded = (rows: Cell[][]) => rows.map((r) => rowKey(r, 2));
  if (sameMultiset(rounded(expected.rows), rounded(aligned)))
    return fail("Your numbers are slightly off. Check the rounding the question asks for, e.g. ROUND(value, 2).");

  const notes: string[] = [];
  if (ak.length !== ek.length) {
    notes.push(`Expected ${plural(ek.length, "row")}, but your query returned ${ak.length}.`);
    notes.push(
      ak.length < ek.length
        ? "Fewer rows usually means a filter is too strict, or an INNER JOIN dropped rows that have no match."
        : "More rows usually means a missing filter or JOIN condition.",
    );
  } else {
    const columnDiff = eNames.filter((_, j) => {
      const col = (rows: Cell[][]) => rows.map((r) => JSON.stringify(normalizeCell(r[j])));
      return !sameMultiset(col(expected.rows), col(aligned));
    });
    notes.push(
      columnDiff.length && columnDiff.length < eNames.length
        ? `The values in column${columnDiff.length > 1 ? "s" : ""} ${columnDiff.map((c) => `"${c}"`).join(", ")} don't match.`
        : "Some rows don't match the expected result.",
    );
  }
  const missing = missingFrom(ek, ak)[0];
  const extra = missingFrom(ak, ek)[0];
  if (missing) notes.push(`Missing row, for example: ${show(missing)}`);
  if (extra) notes.push(`Unexpected row, for example: ${show(extra)}`);
  return fail(notes.join("\n"));
}

export interface SqlExerciseSpec {
  solution: string;
  verification: Verification;
  checkSql?: string | null;
}

export interface SubmissionCheck {
  status: "CORRECT" | "INCORRECT" | "ERROR" | "TIMEOUT" | "UNSAFE";
  feedback: string;
  run: RunResult;
}

const STATUS = { error: "ERROR", timeout: "TIMEOUT", unsafe: "UNSAFE" } as const;

/** Runs the canonical solution and the learner's SQL on identical data and compares the results. */
export function checkSubmission(setupSql: string, ex: SqlExerciseSpec, userSql: string, tables: string[] = []): Promise<SubmissionCheck> {
  return withSandbox(
    setupSql,
    async (s) => {
      await s.exec("SAVEPOINT dsa_clean");
      const solution = await s.run(ex.solution, config.sql.maxCompareRows);
      if (solution.status !== "ok") throw new Error(`Exercise solution failed: ${solution.message}`);
      const expected = ex.checkSql && ex.verification !== "CUSTOM" ? await s.query(ex.checkSql) : lastResultSet(solution);
      await s.exec("ROLLBACK TO SAVEPOINT dsa_clean");
      s.resetUserTx();
      s.notices.length = 0;

      const run = await s.run(userSql, config.sql.maxCompareRows);
      if (run.status !== "ok") return { status: STATUS[run.status], feedback: run.message ?? "", run };

      let actual: ResultSet | undefined;
      if (ex.checkSql) {
        try {
          actual = await s.query(ex.checkSql);
        } catch (e) {
          return { status: "INCORRECT", feedback: `Your SQL ran, but the result could not be checked: ${(e as Error).message}.`, run };
        }
        if (ex.verification === "CUSTOM") {
          const [ok, message] = actual.rows[0] ?? [];
          return ok === "t" || ok === "true"
            ? { status: "CORRECT", feedback: "Correct!", run }
            : { status: "INCORRECT", feedback: message ?? "Not quite: the database is not in the expected state yet.", run };
        }
      } else actual = lastResultSet(run);

      if (!actual?.columns.length)
        return { status: "INCORRECT", feedback: "Your SQL ran, but it didn't return any rows to check. End with a SELECT.", run };
      const verdict = compareResults(expected!, actual, ex.verification === "SCHEMA" ? "UNORDERED_RESULT" : ex.verification);
      return { status: verdict.pass ? "CORRECT" : "INCORRECT", feedback: verdict.message, run };
    },
    tables,
  );
}
