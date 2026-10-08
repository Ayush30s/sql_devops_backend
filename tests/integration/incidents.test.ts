import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../src/lib/db.ts";

/**
 * The incidents played through the API the way a learner plays them, against a running dev server:
 * access, hidden answers, the story clock, evidence, a wrong fix, the right fix and closing; then
 * hints, confirmations, giving up, the score, the history and its reports; and every incident's
 * walkthrough, which must bring its system back and score full marks.
 */

const BASE = process.env.APP_URL ?? "http://localhost:3000";
const email = `inc-${randomUUID()}@dsa.test`;
const otherEmail = `inc-${randomUUID()}@dsa.test`;
const password = "a-long-enough-test-password";
const C = "/api/incidents/INC-1001";
/** Never in what a learner is sent before the incident is resolved. */
const HIDDEN = ["answer", "probe", "machineSetup", "databaseSql", "model", "setupScript", "walkthrough", "scoring", "report\":{"];
/** Starting is limited to 10 a minute per learner, so the walkthroughs are shared between two. */
const walkerEmails = [`inc-${randomUUID()}@dsa.test`, `inc-${randomUUID()}@dsa.test`];

interface Report {
  runId: string;
  outcome: "resolved" | "gave-up";
  score: number;
  scoreDetail: { total: number; parts: { label: string; points: number }[]; penalties: { label: string; points: number }[] };
  rootCause: string;
  timeline: { at: string; text: string; kind: string; tags?: string[] }[];
  resolution: { yourDiagnosis: string | null; yourChanges: { kind: string; text: string }[]; fix: string };
  yourPrevention: string | null;
}

let cookie = "";
let otherCookie = "";
let walkers: string[] = [];

const api = async (path: string, init: RequestInit = {}, jar = cookie) => {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...(jar ? { cookie: jar } : {}), origin: BASE, ...init.headers },
    redirect: "manual",
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
};

const register = async (mail: string) => {
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ name: "Incident Test", email: mail, password }),
  });
  if (!res.ok) throw new Error(`register failed: ${await res.text()}`);
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
};

const leaks = (body: unknown) => HIDDEN.filter((k) => JSON.stringify(body).includes(k.includes("{") ? k : `"${k}"`));
const run = (command: string, jar = cookie, confirmed?: boolean) => api(`${C}/terminal/command`, { method: "POST", body: JSON.stringify({ command, confirmed }) }, jar);
const out = async (command: string) => String((await run(command)).body.stdout).trim();
const sql = (q: string, jar = cookie) => api(`${C}/sql`, { method: "POST", body: JSON.stringify({ sql: q }) }, jar);
const rows = async (q: string) => {
  const results = (await sql(q)).body.results as { columns: unknown[]; rows: (string | null)[][] }[];
  return [...results].reverse().find((r) => r.columns.length)?.rows;
};
const resolve = (answer: string, prevention?: string, jar = cookie) => api(`${C}/resolve`, { method: "POST", body: JSON.stringify({ answer, prevention }) }, jar);

beforeAll(async () => {
  const ping = await fetch(`${BASE}/api/auth/me`).catch(() => null);
  if (!ping) throw new Error(`The dev server must be running at ${BASE} for these tests.`);
  cookie = await register(email);
  otherCookie = await register(otherEmail);
  walkers = [await register(walkerEmails[0]), await register(walkerEmails[1])];
});

afterAll(async () => {
  await db.user.deleteMany({ where: { email: { in: [email, otherEmail, ...walkerEmails] } } });
  await db.$disconnect();
});

describe("incident access", () => {
  it("needs a session", async () => {
    expect((await api("/api/incidents", {}, "")).status).toBe(401);
    expect((await api(`${C}/start`, { method: "POST", body: "{}" }, "")).status).toBe(401);
  });

  it("lists the incidents, and shows the alert, never the answer", async () => {
    const list = await api("/api/incidents");
    expect((list.body.incidents as { code: string }[]).find((i) => i.code === "INC-1001")).toMatchObject({ level: 1, severity: "SEV-2", run: null });
    const one = await api(C);
    expect(one.body).toMatchObject({ code: "INC-1001", run: null, report: null });
    expect(String(one.body.alert)).toContain("PRODUCTION ALERT");
    expect((one.body.diagnosis as { options: unknown[] }).options.length).toBeGreaterThan(2);
    expect(leaks(list.body)).toEqual([]);
    expect(leaks(one.body)).toEqual([]);
  });

  it("answers 404 for incidents that do not exist, and 409 before one is started", async () => {
    expect((await api("/api/incidents/INC-9999")).status).toBe(404);
    expect((await api("/api/incidents/users")).status).toBe(404);
    expect((await run("date")).status).toBe(409);
    expect((await sql("SELECT 1")).status).toBe(409);
  });

  it("refuses cross-site requests", async () => {
    const res = await fetch(`${BASE}${C}/start`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example", cookie }, body: "{}" });
    expect(res.status).toBe(403);
  });
});

describe("INC-1001, investigated and fixed", () => {
  beforeAll(async () => {
    const started = await api(`${C}/start`, { method: "POST", body: "{}" });
    expect(started.status).toBe(200);
    expect(leaks(started.body)).toEqual([]);
    expect(started.body.run).toMatchObject({ status: "INVESTIGATING", hints: [], hintsLeft: 3, score: null });
  });

  it("starts at the alert: the server and the database both live at 02:13", async () => {
    expect(((await api(C)).body.run as { alerts: string[] }).alerts[0]).toContain("8.3%");
    expect(await out("date -u +%H:%M")).toMatch(/^02:1\d$/);
    expect((await rows("SELECT to_char(now(), 'HH24:MI')"))?.[0][0]).toMatch(/^02:1\d$/);
  });

  it("has the evidence where an engineer would look", async () => {
    expect(await out("systemctl is-active webapp")).toBe("active");
    expect(Number(await out("grep -c PricingError /var/log/webapp/app.log"))).toBeGreaterThan(5);
    expect(await out("curl -s localhost/api/health")).toContain('"ok"');
    const order = (id: number) => out(`curl -s -o /dev/null -w '%{http_code}' -X POST localhost/api/orders -d '{"customer_id": 7, "items": [{"product_id": ${id}, "quantity": 1}]}'`);
    expect(await order(7)).toBe("500");
    expect(await order(12)).toBe("201");
    expect(await rows("SELECT count(*) FROM products WHERE price = NULL")).toEqual([["0"]]);
    expect(await rows("SELECT count(*) FROM products WHERE price IS NULL")).toEqual([["37"]]);
  });

  it("keeps changes to the database, and the system follows them: a wrong fix shows", async () => {
    const zero = await sql("UPDATE products SET price = 0 WHERE price IS NULL");
    expect(zero.body.status).toBe("ok");
    const incident = zero.body.incident as { alerts: string[]; changes: string[] };
    expect(incident.changes).toHaveLength(1);
    expect(incident.alerts[0]).toMatch(/Revenue anomaly: 37 products/);
    expect(await rows("SELECT count(*) FROM products WHERE price = 0")).toEqual([["37"]]);
    expect((await resolve("price-sync-nulls")).body).toMatchObject({ resolved: false, reason: "not-recovered" });
  });

  it("rolls back a transaction left open, keeping nothing of it", async () => {
    const open = await sql("BEGIN; UPDATE products SET price = 999 WHERE id = 12");
    expect((open.body.notices as string[]).join(" ")).toMatch(/rolled back/);
    expect((await rows("SELECT price FROM products WHERE id = 12"))?.[0][0]).not.toBe("999.00");
  });

  it("closes only once the system has recovered, and only with the right root cause", async () => {
    const fix = await sql(`UPDATE products p SET price = h.price
      FROM (SELECT DISTINCT ON (product_id) product_id, price FROM price_history WHERE price IS NOT NULL ORDER BY product_id, valid_from DESC) h
      WHERE p.id = h.product_id AND p.price = 0`);
    expect((fix.body.incident as { alerts: string[] }).alerts).toEqual([]);
    expect((await resolve("backup-cpu")).body).toMatchObject({ resolved: false, reason: "wrong-cause" });
    const done = await resolve("price-sync-nulls", "validate");
    expect(done.body.resolved).toBe(true);
    const incident = done.body.incident as { report: Report; run: { status: string; score: number } };
    expect(incident.run.status).toBe("RESOLVED");
    expect(incident.report.rootCause).toContain("NULL");
    expect(incident.report.outcome).toBe("resolved");
    expect(incident.report.resolution.yourDiagnosis).toMatch(/price sync/);
    expect(incident.report.yourPrevention).toMatch(/Validate the feed/);
    // the wrong fix on the way (prices given away) halves the safe fix; two wrong conclusions cost 5 each
    expect(incident.report.scoreDetail.parts.find((p) => p.label === "Safe fix")?.points).toBe(10);
    expect(incident.report.scoreDetail.penalties.find((p) => p.label === "Wrong conclusions")?.points).toBe(-10);
    expect(incident.report.score).toBe(incident.run.score);
    expect(incident.report.timeline.some((t) => t.kind === "state" && t.tags?.includes("harmful"))).toBe(true);
    expect(incident.report.resolution.yourChanges.map((c) => c.text)).toContain("UPDATE products SET price = 0 WHERE price IS NULL");
  });

  it("is the learner's own: anyone else sees no run and cannot act on it", async () => {
    expect((await api(C, {}, otherCookie)).body).toMatchObject({ run: null, report: null });
    expect((await run("date", otherCookie)).status).toBe(409);
    expect((await sql("SELECT 1", otherCookie)).status).toBe(409);
  });
});

describe("INC-1001 again: hints, confirmations, giving up, the history", () => {
  let firstRun = "";
  let secondRun = "";

  beforeAll(async () => {
    firstRun = ((await api(C)).body.run as { id: string }).id;
    const started = await api(`${C}/start`, { method: "POST", body: "{}" });
    secondRun = (started.body.run as { id: string }).id;
  });

  it("starts a new run once the last one is finished, and keeps the finished one", () => {
    expect(secondRun).toMatch(/^[0-9a-f-]{36}$/);
    expect(secondRun).not.toBe(firstRun);
  });

  it("gives the hints one at a time, concept first, and never more than there are", async () => {
    const first = (await api(`${C}/hint`, { method: "POST", body: "{}" })).body.run as { hints: { level: number; kind: string; text: string }[]; hintsLeft: number };
    expect(first.hints).toHaveLength(1);
    expect(first.hints[0]).toMatchObject({ level: 1, kind: "concept" });
    expect(first.hintsLeft).toBe(2);
    for (let i = 0; i < 3; i++) await api(`${C}/hint`, { method: "POST", body: "{}" });
    const all = (await api(C)).body.run as { hints: { kind: string }[]; hintsLeft: number };
    expect(all.hints.map((h) => h.kind)).toEqual(["concept", "direction", "command"]);
    expect(all.hintsLeft).toBe(0);
  });

  it("asks before a production action, and does nothing until it is confirmed", async () => {
    const asked = await run("sudo systemctl stop webapp");
    expect(asked.status).toBe(200);
    expect((asked.body.confirm as { reason: string }).reason).toMatch(/service/);
    expect(asked.body.stdout).toBeUndefined();
    expect(await out("systemctl is-active webapp")).toBe("active");
    const done = await run("sudo systemctl stop webapp", cookie, true);
    expect(done.body.confirm).toBeUndefined();
    expect((done.body.incident as { alerts: string[] }).alerts[0]).toMatch(/502/);
    await run("sudo systemctl start webapp", cookie, true);
    expect(await out("systemctl is-active webapp")).toBe("active");
  });

  it("asks before SQL that can wipe out a table, and changes nothing until it is confirmed", async () => {
    const asked = await sql("UPDATE products SET price = 0");
    expect((asked.body.confirm as { reason: string }).reason).toMatch(/WHERE/);
    expect(await rows("SELECT count(*) FROM products WHERE price = 0")).toEqual([["0"]]);
    const confirmed = await api(`${C}/sql`, { method: "POST", body: JSON.stringify({ sql: "UPDATE products SET price = price", confirmed: true }) });
    expect(confirmed.body).toMatchObject({ status: "ok" });
    expect((confirmed.body.incident as { changes: string[] }).changes).toEqual(["UPDATE products SET price = price"]);
  });

  it("gives up: the run closes with its report, and the answer is no longer hidden", async () => {
    const view = (await api(`${C}/give-up`, { method: "POST", body: "{}" })).body as { run: { status: string; score: number }; report: Report };
    expect(view.run.status).toBe("GAVE_UP");
    expect(view.report).toMatchObject({ runId: secondRun, outcome: "gave-up" });
    expect(view.report.rootCause).toContain("NULL");
    expect(view.report.scoreDetail.penalties.map((p) => p.label)).toEqual(expect.arrayContaining(["Hints", "Gave up"]));
    expect(view.run.score).toBe(view.report.score);
    // a finished run takes no more hints or answers
    expect(((await api(`${C}/hint`, { method: "POST", body: "{}" })).body.run as { hints: unknown[] }).hints).toHaveLength(3);
  });

  it("lists the finished runs, newest first, with the best score in the queue", async () => {
    const history = (await api("/api/incidents/history")).body.runs as { runId: string; code: string; outcome: string; score: number }[];
    expect(history.map((r) => r.runId)).toEqual([secondRun, firstRun]);
    expect(history.map((r) => r.outcome)).toEqual(["gave-up", "resolved"]);
    const queue = (await api("/api/incidents")).body.incidents as { code: string; bestScore: number | null; attempts: number }[];
    expect(queue.find((i) => i.code === "INC-1001")).toMatchObject({ bestScore: history[1].score, attempts: 2 });
  });

  it("shows a report only to its owner", async () => {
    const mine = await api(`/api/incidents/reports/${firstRun}`);
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({ runId: firstRun, outcome: "resolved" });
    expect((await api(`/api/incidents/reports/${firstRun}`, {}, otherCookie)).status).toBe(404);
    expect((await api(`/api/incidents/reports/${firstRun}`, {}, "")).status).toBe(401);
    expect((await api("/api/incidents/reports/not-a-run")).status).toBe(404);
    expect((await api(`/api/incidents/reports/${randomUUID()}`)).status).toBe(404);
    expect(((await api("/api/incidents/history", {}, otherCookie)).body.runs as unknown[]).length).toBe(0);
  });
});

const scenarios = await db.incidentScenario.findMany({ orderBy: { code: "asc" }, select: { code: true, solution: true, diagnosis: true } });

describe("every incident's walkthrough brings its system back and scores full marks", () => {
  it("has the beginner incidents", () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(10);
  });

  it.each(scenarios.map((s, i) => [s.code, s, i] as const))("%s", async (code, s, i) => {
    const jar = walkers[i % 2];
    const at = `/api/incidents/${code}`;
    const steps = (s.solution as { walkthrough: { kind: "command" | "sql"; text: string }[] }).walkthrough;
    const { answer, prevention } = s.diagnosis as { answer: string; prevention?: { answer: string } };

    const started = await api(`${at}/start`, { method: "POST", body: "{}" }, jar);
    expect(started.status).toBe(200);
    expect((started.body.run as { alerts: string[] }).alerts.length).toBeGreaterThan(0);
    for (const step of steps) {
      const res =
        step.kind === "command"
          ? await api(`${at}/terminal/command`, { method: "POST", body: JSON.stringify({ command: step.text, confirmed: true }) }, jar)
          : await api(`${at}/sql`, { method: "POST", body: JSON.stringify({ sql: step.text, confirmed: true }) }, jar);
      expect(res.status, step.text).toBe(200);
      if (step.kind === "sql") expect(res.body.status, step.text).toBe("ok");
    }
    expect(((await api(at, {}, jar)).body.run as { alerts: string[] }).alerts).toEqual([]);
    const done = await api(`${at}/resolve`, { method: "POST", body: JSON.stringify({ answer, prevention: prevention?.answer }) }, jar);
    expect(done.body.resolved).toBe(true);
    const report = (done.body.incident as { report: Report }).report;
    expect(report.scoreDetail.penalties).toEqual([]);
    expect(report.score).toBe(100);
  });
});
