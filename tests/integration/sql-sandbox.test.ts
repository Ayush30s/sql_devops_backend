import pg from "pg";
import { describe, expect, it } from "vitest";
import { describeDataset, runQuery, withSandbox } from "../../src/lib/sql/sandbox.ts";
import { checkSubmission } from "../../src/lib/sql/verify.ts";

const SETUP = `
CREATE TABLE customers (id int PRIMARY KEY, name text NOT NULL, city text);
INSERT INTO customers VALUES (1, 'Rahul', 'Ahmedabad'), (2, 'Priya', 'Mumbai'), (3, 'Amit', 'Delhi'), (4, 'Neha', NULL);
CREATE TABLE orders (id int PRIMARY KEY, customer_id int REFERENCES customers(id), amount numeric(10,2));
INSERT INTO orders VALUES (1, 1, 250.50), (2, 1, 100), (3, 2, 75.25);
`;

describe("SQL sandbox", () => {
  it("runs queries against the dataset", async () => {
    const r = await runQuery(SETUP, "SELECT name FROM customers WHERE city = 'Ahmedabad'");
    expect(r.status).toBe("ok");
    expect(r.results[0].rows).toEqual([["Rahul"]]);
  });

  it("describes datasets for the schema browser", async () => {
    const tables = await describeDataset(SETUP);
    expect(tables.map((t) => [t.name, t.rowCount])).toEqual([["customers", 4], ["orders", 3]]);
    expect(tables[1].columns.find((c) => c.name === "customer_id")).toMatchObject({ key: "FK", references: "customers.id" });
  });

  it("explains syntax errors with typo hints and positions", async () => {
    const r = await runQuery(SETUP, "SELECT name\nFORM customers");
    expect(r.status).toBe("error");
    expect(r.message).toBe('Syntax error near "customers".');
    const r2 = await runQuery(SETUP, "SELECT name FROM customers WHERE city = \"Mumbai\"");
    expect(r2.hint).toContain("single quotes");
  });

  it("emulates BEGIN/ROLLBACK/COMMIT with savepoints", async () => {
    const r = await runQuery(
      SETUP,
      "BEGIN; DELETE FROM orders; ROLLBACK; BEGIN; UPDATE customers SET city = 'Pune' WHERE id = 4; COMMIT; SELECT count(*), (SELECT city FROM customers WHERE id = 4) FROM orders",
    );
    expect(r.status).toBe("ok");
    expect(r.results.at(-1)!.rows).toEqual([["3", "Pune"]]);
  });

  it("never persists anything, even after a learner COMMIT", async () => {
    await runQuery(SETUP, "CREATE TABLE leak (x int); COMMIT; INSERT INTO leak VALUES (1); COMMIT");
    const r = await runQuery("", "SELECT count(*) FROM pg_tables WHERE tablename = 'leak'");
    expect(r.results[0].rows).toEqual([["0"]]);
  });

  it.each([
    ["SET statement_timeout = 0", "unsafe"],
    ["COPY customers TO '/tmp/x'", "unsafe"],
    ["PREPARE TRANSACTION 'x'", "unsafe"],
    ["VACUUM customers", "unsafe"],
    ["GRANT ALL ON customers TO PUBLIC", "unsafe"],
    ["SELECT set_config('statement_timeout', '0', false)", "error"],
    ["SELECT pg_terminate_backend(1)", "error"],
    ["SELECT pg_cancel_backend(1)", "error"],
    ["SELECT * FROM pg_stat_activity", "error"],
    ["SELECT pg_read_file('postgresql.conf')", "error"],
    ["DO $$ BEGIN COMMIT; END $$", "error"],
    ["CREATE DATABASE evil", "unsafe"],
    ["CREATE EXTENSION dblink", "unsafe"],
    ["CREATE ROLE evil SUPERUSER", "unsafe"],
    ["ALTER SYSTEM SET work_mem = '1GB'", "unsafe"],
  ])("blocks %s", async (sql, status) => {
    const r = await runQuery(SETUP, sql);
    expect(r.status).toBe(status);
  });

  it("times out slow statements", async () => {
    const r = await runQuery(SETUP, "SELECT pg_sleep(10)");
    expect(r.status).toBe("timeout");
  });

  it("terminates sessions that disable their own timeout", async () => {
    const started = Date.now();
    const r = await runQuery(
      SETUP,
      "CREATE FUNCTION slow() RETURNS void LANGUAGE plpgsql SET statement_timeout = 0 AS $$ BEGIN PERFORM pg_sleep(60); END $$; SELECT slow()",
    );
    expect(r.status).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(30_000);
  });

  it("limits rows returned to the app", async () => {
    const r = await runQuery("", "SELECT generate_series(1, 1000000)");
    expect(r.status).toBe("ok");
    expect(r.results[0].rows.length).toBe(500);
    expect(r.results[0].truncated).toBe(true);
  });

  it("cannot connect to the application database", async () => {
    const url = new URL(process.env.SANDBOX_DATABASE_URL!);
    url.port = new URL(process.env.DATABASE_URL!).port;
    url.pathname = new URL(process.env.DATABASE_URL!).pathname;
    const client = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 3000 });
    await expect(client.connect()).rejects.toThrow();
  });

  it("keeps runs isolated from each other", async () => {
    const [a, b] = await Promise.all([
      withSandbox(SETUP, (s) => s.run("DELETE FROM orders; DELETE FROM customers; SELECT count(*) FROM customers")),
      withSandbox(SETUP, (s) => s.run("SELECT count(*) FROM customers")),
    ]);
    expect(a.results.at(-1)!.rows).toEqual([["0"]]);
    expect(b.results.at(-1)!.rows).toEqual([["4"]]);
  });
});

describe("SQL verification", () => {
  const top = { solution: "SELECT c.name, SUM(o.amount) AS total FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY c.name ORDER BY total DESC", verification: "ORDERED_RESULT" as const };

  it("accepts different SQL with the same result", async () => {
    const r = await checkSubmission(SETUP, top, "SELECT name, (SELECT SUM(amount) FROM orders WHERE customer_id = customers.id) s FROM customers WHERE id IN (SELECT customer_id FROM orders) ORDER BY 2 DESC");
    expect(r.status).toBe("CORRECT");
  });

  it("reports wrong ordering", async () => {
    const r = await checkSubmission(SETUP, top, "SELECT c.name, SUM(o.amount) FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY c.name ORDER BY 2");
    expect(r.status).toBe("INCORRECT");
    expect(r.feedback).toContain("wrong order");
  });

  it("checks database state for DML exercises", async () => {
    const spec = { solution: "UPDATE orders SET amount = amount * 1.1", verification: "SCHEMA" as const, checkSql: "SELECT id, amount FROM orders" };
    expect((await checkSubmission(SETUP, spec, "UPDATE orders SET amount = amount + amount / 10")).status).toBe("CORRECT");
    expect((await checkSubmission(SETUP, spec, "UPDATE orders SET amount = amount * 1.2")).status).toBe("INCORRECT");
  });

  it("supports custom boolean checks", async () => {
    const spec = {
      solution: "CREATE INDEX ON orders (customer_id)",
      verification: "CUSTOM" as const,
      checkSql: "SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexdef LIKE '%(customer_id)%'), 'No index on orders(customer_id) yet.'",
    };
    expect((await checkSubmission(SETUP, spec, "CREATE INDEX idx_orders_customer ON orders(customer_id)")).status).toBe("CORRECT");
    const wrong = await checkSubmission(SETUP, spec, "CREATE INDEX ON orders(amount)");
    expect(wrong).toMatchObject({ status: "INCORRECT", feedback: "No index on orders(customer_id) yet." });
  });
});
