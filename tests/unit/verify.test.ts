import { describe, expect, it } from "vitest";
import type { ResultSet } from "../../src/lib/sql/sandbox.ts";
import { compareResults, normalizeCell } from "../../src/lib/sql/verify.ts";
import { classify, splitStatements } from "../../src/lib/sql/split.ts";

const rs = (columns: string[], rows: (string | null)[][]): ResultSet => ({
  command: "SELECT",
  columns: columns.map((name) => ({ name, type: "text" as const })),
  rows,
  rowCount: rows.length,
  truncated: false,
});

describe("cell normalization", () => {
  it("keeps NULL distinct from the empty string", () => {
    expect(normalizeCell(null)).toBeNull();
    expect(normalizeCell("")).toBe("");
  });

  it("compares numbers by value, not by spelling", () => {
    expect(normalizeCell("10.00")).toBe(normalizeCell("10"));
    expect(normalizeCell("1e2")).toBe(normalizeCell("100"));
    expect(normalizeCell("-0")).toBe(normalizeCell("0"));
  });

  it("compares text exactly, because the data is the answer", () => {
    expect(normalizeCell(" Mumbai ")).not.toBe(normalizeCell("Mumbai"));
    expect(normalizeCell("mumbai")).not.toBe(normalizeCell("Mumbai"));
  });

  it("rounds to a fixed number of decimals when asked", () => {
    expect(normalizeCell("12.344", 2)).toBe(normalizeCell("12.34", 2));
    expect(normalizeCell("12.344", 2)).not.toBe(normalizeCell("12.35", 2));
  });
});

describe("result comparison", () => {
  const expected = rs(["name", "total"], [["Rahul", "300"], ["Priya", "200"]]);

  it("accepts the same rows in another order when order doesn't matter", () => {
    const actual = rs(["name", "total"], [["Priya", "200.00"], ["Rahul", "300"]]);
    expect(compareResults(expected, actual, "UNORDERED_RESULT").pass).toBe(true);
  });

  it("rejects a different order when the exercise asked for one", () => {
    const actual = rs(["name", "total"], [["Priya", "200"], ["Rahul", "300"]]);
    const verdict = compareResults(expected, actual, "ORDERED_RESULT");
    expect(verdict.pass).toBe(false);
    expect(verdict.message.toLowerCase()).toContain("order");
  });

  it("explains a row-count difference", () => {
    const actual = rs(["name", "total"], [["Rahul", "300"]]);
    const verdict = compareResults(expected, actual, "UNORDERED_RESULT");
    expect(verdict.pass).toBe(false);
    expect(verdict.message).toMatch(/1 row|2 rows/);
  });

  it("notices missing and extra columns", () => {
    const actual = rs(["name"], [["Rahul"], ["Priya"]]);
    const verdict = compareResults(expected, actual, "UNORDERED_RESULT");
    expect(verdict.pass).toBe(false);
    expect(verdict.message).toContain("total");
  });

  it("requires the column names too for EXACT_RESULT", () => {
    const same = rs(["name", "total"], [["Rahul", "300"], ["Priya", "200"]]);
    expect(compareResults(expected, same, "EXACT_RESULT").pass).toBe(true);
    const renamed = rs(["customer", "total"], [["Rahul", "300"], ["Priya", "200"]]);
    const verdict = compareResults(expected, renamed, "EXACT_RESULT");
    expect(verdict.pass).toBe(false);
    expect(verdict.message).toContain("AS name");
  });

  it("matches columns by name when they come back in another order", () => {
    const swapped = rs(["total", "name"], [["300", "Rahul"], ["200", "Priya"]]);
    expect(compareResults(expected, swapped, "UNORDERED_RESULT").pass).toBe(true);
  });

  it("only counts rows for ROW_COUNT", () => {
    const actual = rs(["anything"], [["x"], ["y"]]);
    expect(compareResults(expected, actual, "ROW_COUNT").pass).toBe(true);
    expect(compareResults(expected, rs(["anything"], [["x"]]), "ROW_COUNT").pass).toBe(false);
  });

  it("detects duplicated rows", () => {
    const actual = rs(["name", "total"], [["Rahul", "300"], ["Rahul", "300"], ["Priya", "200"]]);
    const verdict = compareResults(expected, actual, "UNORDERED_RESULT");
    expect(verdict.pass).toBe(false);
    expect(verdict.message.toLowerCase()).toMatch(/duplicate|row/);
  });
});

describe("statement splitting and the allow-list", () => {
  it("splits on semicolons outside strings and comments", () => {
    const sql = "SELECT ';' AS a; -- comment;\nSELECT 2;";
    expect(splitStatements(sql)).toHaveLength(2);
  });

  it("allows the statements a learner needs", () => {
    for (const sql of ["SELECT 1", "WITH x AS (SELECT 1) SELECT * FROM x", "INSERT INTO t VALUES (1)", "CREATE TABLE t (id int)", "EXPLAIN SELECT 1"])
      expect(classify(sql).kind, sql).toBe("run");
  });

  it("recognises transaction control so it can be emulated", () => {
    expect(classify("BEGIN").kind).toBe("begin");
    expect(classify("COMMIT").kind).toBe("commit");
    expect(classify("ROLLBACK").kind).toBe("rollback");
  });

  it("blocks everything that could escape the sandbox", () => {
    for (const sql of [
      "COPY t FROM '/etc/passwd'",
      "GRANT ALL ON t TO learner",
      "SET ROLE postgres",
      "CREATE EXTENSION dblink",
      "CREATE ROLE hacker SUPERUSER",
      "ALTER DATABASE sandbox SET log_statement='all'",
      "DROP DATABASE sandbox",
      "VACUUM FULL",
      "ALTER SYSTEM SET log_statement='all'",
      "COMMIT PREPARED 'x'",
    ])
      expect(classify(sql).kind, sql).toBe("blocked");
  });
});
