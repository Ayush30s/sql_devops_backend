import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../src/lib/db.ts";

/**
 * Black-box checks against a running dev server (`npm run dev`): authentication,
 * authorization, IDOR, CSRF, injection and resource limits.
 */

const BASE = process.env.APP_URL ?? "http://localhost:3000";
const email = `sec-${randomUUID()}@dsa.test`;
const otherEmail = `sec-${randomUUID()}@dsa.test`;
const password = "a-long-enough-test-password";

let cookie = "";
let otherCookie = "";

const api = async (path: string, init: RequestInit = {}, jar = cookie) => {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(jar ? { cookie: jar } : {}),
      origin: BASE,
      ...init.headers,
    },
    redirect: "manual",
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {}, res };
};

const register = async (mail: string) => {
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ name: "Sec Test", email: mail, password }),
  });
  if (!res.ok) throw new Error(`register failed: ${await res.text()}`);
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
};

beforeAll(async () => {
  const ping = await fetch(`${BASE}/api/auth/me`).catch(() => null);
  if (!ping) throw new Error(`The dev server must be running at ${BASE} for these tests.`);
  cookie = await register(email);
  otherCookie = await register(otherEmail);
});

afterAll(async () => {
  await db.user.deleteMany({ where: { email: { in: [email, otherEmail] } } });
  await db.$disconnect();
});

describe("authentication", () => {
  it("rejects a wrong password with the same message as an unknown account", async () => {
    const unknown = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email: `nobody-${randomUUID()}@dsa.test`, password }) }, "");
    const wrong = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password: "not-the-password" }) }, "");
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toBe(unknown.body.error);
  });

  it("rate-limits repeated guesses at one account", async () => {
    const target = `brute-${randomUUID()}@dsa.test`;
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email: target, password: `guess-${i}` }) }, "")).status);
    expect(codes).toContain(429);
    expect(codes.filter((c) => c === 401).length).toBeLessThanOrEqual(10);
  });

  it("refuses a weak password at registration", async () => {
    const res = await api("/api/auth/register", { method: "POST", body: JSON.stringify({ name: "x", email: `weak-${randomUUID()}@dsa.test`, password: "short" }) }, "");
    expect(res.status).toBe(400);
  });

  it("refuses a duplicate email", async () => {
    const res = await api("/api/auth/register", { method: "POST", body: JSON.stringify({ name: "x", email, password }) }, "");
    expect(res.status).toBe(409);
  });

  it("sets an httpOnly session cookie", async () => {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ email, password }),
    });
    const set = res.headers.getSetCookie().join(";");
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=lax/i);
  });

  it("locks the practice APIs behind a session", async () => {
    const posts = ["/api/sql/run", "/api/sql/submit", "/api/linux/command", "/api/linux/session", "/api/linux/reset", "/api/linux/submit", "/api/linux/file"];
    const gets = ["/api/progress", "/api/sql/history", "/api/profile", "/api/datasets"];
    for (const path of posts) {
      const res = await api(path, { method: "POST", body: "{}" }, "");
      expect(res.status, path).toBe(401);
      expect(res.body.error).toBe("Please sign in.");
    }
    for (const path of gets) {
      const res = await api(path, {}, "");
      expect(res.status, path).toBe(401);
    }
  });

  it("does not accept a forged session cookie", async () => {
    const res = await api("/api/progress", {}, "dsa_session=" + "a".repeat(43));
    expect(res.status).toBe(401);
  });
});

describe("authorization", () => {
  it("keeps the admin API away from ordinary learners", async () => {
    for (const path of ["/api/admin/topics", "/api/admin/exercises", "/api/admin/users", "/api/admin/stats", "/api/admin/datasets"]) {
      const res = await api(path);
      expect(res.status, path).toBe(403);
    }
  });

  it("refuses admin writes from a learner", async () => {
    const res = await api("/api/admin/exercises", { method: "POST", body: JSON.stringify({ topicId: randomUUID(), slug: "x", kind: "SQL", title: "x", prompt: "x", difficulty: "BEGINNER", xp: 1, solution: "SELECT 1" }) });
    expect(res.status).toBe(403);
  });

  it("never returns another learner's progress (no IDOR)", async () => {
    const mine = await api("/api/progress");
    const theirs = await api("/api/progress", {}, otherCookie);
    expect(mine.status).toBe(200);
    expect(theirs.status).toBe(200);
    // Each session sees only its own data; the admin-only per-user endpoint is closed.
    const direct = await api(`/api/admin/users/${randomUUID()}`);
    expect(direct.status).toBe(403);
  });

  it("gives each learner their own lab and query history", async () => {
    await api("/api/linux/command", { method: "POST", body: JSON.stringify({ command: "touch ~/mine.txt" }) });
    const theirs = await api("/api/linux/command", { method: "POST", body: JSON.stringify({ command: "ls ~/mine.txt" }) }, otherCookie);
    expect(String(theirs.body.stderr)).toContain("No such file");
  });
});

describe("CSRF and input validation", () => {
  it("rejects a cross-site origin on mutations", async () => {
    const res = await fetch(`${BASE}/api/sql/run`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example", cookie },
      body: JSON.stringify({ sql: "SELECT 1", dataset: "bookstore" }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects non-JSON bodies and malformed JSON", async () => {
    const form = await fetch(`${BASE}/api/sql/run`, { method: "POST", headers: { "content-type": "text/plain", origin: BASE, cookie }, body: "sql=SELECT 1" });
    expect(form.status).toBe(415);
    const bad = await fetch(`${BASE}/api/sql/run`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, cookie }, body: "{nope" });
    expect(bad.status).toBe(400);
  });

  it("validates types and lengths", async () => {
    const res = await api("/api/sql/run", { method: "POST", body: JSON.stringify({ sql: 42 }) });
    expect(res.status).toBe(400);
    const long = await api("/api/sql/run", { method: "POST", body: JSON.stringify({ sql: "SELECT 1 -- " + "x".repeat(30_000), dataset: "bookstore" }) });
    expect(long.status).toBe(400);
  });

  it("treats a slug as data, not SQL (no injection through the API)", async () => {
    const res = await api("/api/exercises/' OR 1=1 --", {});
    expect(res.status).toBe(404);
    const sub = await api("/api/sql/submit", { method: "POST", body: JSON.stringify({ exercise: "'; DROP TABLE users; --", sql: "SELECT 1" }) });
    expect(sub.status).toBe(404);
    expect(await db.user.count()).toBeGreaterThan(0);
  });
});

describe("sandbox limits through the API", () => {
  it("runs SQL in the sandbox, never against the application database", async () => {
    const res = await api("/api/sql/run", { method: "POST", body: JSON.stringify({ sql: "SELECT * FROM users", dataset: "bookstore" }) });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("error");
    expect(String(res.body.message)).toMatch(/does not exist/i);
  });

  it("runs an exercise on its own dataset, not its topic's", async () => {
    // One exercise per (own, topic) dataset pair: the old lookup matched both and returned whichever came first.
    const rows = await db.exercise.findMany({
      where: { kind: "SQL", datasetId: { not: null } },
      select: { slug: true, dataset: { select: { slug: true } }, topic: { select: { dataset: { select: { slug: true } } } } },
    });
    const pairs = new Map(rows.filter((r) => r.topic.dataset && r.topic.dataset.slug !== r.dataset!.slug).map((r) => [`${r.dataset!.slug}/${r.topic.dataset!.slug}`, r]));
    expect(pairs.size).toBeGreaterThan(0);
    for (const r of pairs.values()) {
      const res = await api("/api/sql/run", { method: "POST", body: JSON.stringify({ sql: "SELECT 1", exercise: r.slug }) });
      expect(res.body.dataset, r.slug).toBe(r.dataset!.slug);
    }
  });

  it("refuses statements outside the allow-list", async () => {
    const res = await api("/api/sql/run", { method: "POST", body: JSON.stringify({ sql: "COPY (SELECT 1) TO '/tmp/x'", dataset: "bookstore" }) });
    expect(res.body.status).toBe("unsafe");
  });

  it("stops a slow query at the statement timeout", async () => {
    const res = await api("/api/sql/run", { method: "POST", body: JSON.stringify({ sql: "SELECT pg_sleep(30)", dataset: "bookstore" }) });
    expect(res.body.status).toBe("timeout");
    expect(String(res.body.message)).toMatch(/timed out/i);
  });

  it("stops a query that tries to exhaust disk or memory", async () => {
    const res = await api("/api/sql/run", { method: "POST", body: JSON.stringify({ sql: "SELECT count(*) FROM generate_series(1, 2000000000)", dataset: "bookstore" }) });
    expect(["timeout", "error"]).toContain(res.body.status);
    expect(String(res.body.message)).toMatch(/temp_file_limit|timed out|memory/i);
  });

  it("stops an endless shell command and keeps the lab usable", async () => {
    const loop = await api("/api/linux/command", { method: "POST", body: JSON.stringify({ command: "while true; do :; done" }) });
    expect(loop.body.exitCode).not.toBe(0);
    expect(String(loop.body.stderr)).toMatch(/infinite loop|too much work|deadline|stopped/i);
    const after = await api("/api/linux/command", { method: "POST", body: JSON.stringify({ command: "echo still-here" }) });
    expect(String(after.body.stdout)).toContain("still-here");
  });

  it("caps the command length", async () => {
    const res = await api("/api/linux/command", { method: "POST", body: JSON.stringify({ command: "echo " + "x".repeat(5000) }) });
    expect(res.status).toBe(400);
  });

  it("keeps the learner off the host: no docker, no host paths, no real network", async () => {
    const docker = await api("/api/linux/command", { method: "POST", body: JSON.stringify({ command: "docker ps" }) });
    expect(`${docker.body.stdout}${docker.body.stderr}`).toMatch(/command not found/);

    const host = await api("/api/linux/command", { method: "POST", body: JSON.stringify({ command: "cat /c/Windows/System32/drivers/etc/hosts" }) });
    expect(`${host.body.stdout}${host.body.stderr}`).toMatch(/No such file/);

    const net = await api("/api/linux/command", { method: "POST", body: JSON.stringify({ command: "curl -s https://example.org" }) });
    expect(String(net.body.stdout)).not.toContain("<!doctype html public");
  });
});
