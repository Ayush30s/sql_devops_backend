import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../src/lib/db.ts";

/**
 * Topic likes, topic reviews and the admin analytics, against a running dev server.
 * These touch other learners' content, so authorization matters as much as the maths.
 */

const BASE = process.env.APP_URL ?? "http://localhost:3000";
const TOPIC = "sql/what-is-sql";
const emails = [`fb-${randomUUID()}@dsa.test`, `fb-${randomUUID()}@dsa.test`];
const admin = `fb-admin-${randomUUID()}@dsa.test`;
const password = "a-long-enough-test-password";
const jars: string[] = [];
let adminJar = "";

const register = async (mail: string) => {
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ name: `Reviewer ${mail.slice(3, 7)}`, email: mail, password }),
  });
  if (!res.ok) throw new Error(`register failed: ${await res.text()}`);
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
};

const api = async (path: string, init: RequestInit = {}, jar = jars[0]) => {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...(jar ? { cookie: jar } : {}), origin: BASE, ...init.headers },
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
};

const topic = (payload: unknown, jar?: string) => api(`/api/topics/${TOPIC}`, { method: "POST", body: JSON.stringify(payload) }, jar);

beforeAll(async () => {
  if (!(await fetch(`${BASE}/api/auth/me`).catch(() => null))) throw new Error(`The dev server must be running at ${BASE}.`);
  for (const mail of emails) jars.push(await register(mail));
  adminJar = await register(admin);
  await db.user.update({ where: { email: admin }, data: { role: "ADMIN" } });
});

afterAll(async () => {
  await db.user.deleteMany({ where: { email: { in: [...emails, admin] } } });
  await db.$disconnect();
});

describe("likes", () => {
  it("toggles on and off, and counts each learner once", async () => {
    const first = await topic({ action: "like", liked: true });
    expect(first.status).toBe(200);
    expect(first.body.liked).toBe(true);
    const baseline = first.body.likes as number;

    // Liking twice must not count twice.
    expect((await topic({ action: "like", liked: true })).body.likes).toBe(baseline);

    const second = await topic({ action: "like", liked: true }, jars[1]);
    expect(second.body.likes).toBe(baseline + 1);

    const off = await topic({ action: "like", liked: false });
    expect(off.body.liked).toBe(false);
    expect(off.body.likes).toBe(baseline);
  });

  it("needs a session", async () => {
    expect((await topic({ action: "like", liked: true }, "")).status).toBe(401);
  });

  it("rejects a cross-site request", async () => {
    const res = await fetch(`${BASE}/api/topics/${TOPIC}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example", cookie: jars[0] },
      body: JSON.stringify({ action: "like", liked: true }),
    });
    expect(res.status).toBe(403);
  });
});

describe("reviews", () => {
  it("writes one review per learner, and writing again edits it", async () => {
    const posted = await topic({ action: "review", body: "Clear and well paced.", rating: 5 });
    expect(posted.status).toBe(200);
    expect(posted.body.rating).toBe(5);

    const edited = await topic({ action: "review", body: "Clearer after a second read.", rating: 4 });
    expect(edited.body.id).toBe(posted.body.id);

    const rows = await db.topicReview.findMany({ where: { user: { email: emails[0] } } });
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe("Clearer after a second read.");
    expect(rows[0].rating).toBe(4);
  });

  it("shows every review with its author, and marks your own", async () => {
    await topic({ action: "review", body: "Useful, wanted more examples.", rating: 3 }, jars[1]);
    const view = await api(`/api/topics/${TOPIC}`, {}, jars[0]);
    const reviews = view.body.reviews as { author: string; mine: boolean; body: string; rating: number }[];
    expect(reviews.length).toBeGreaterThanOrEqual(2);
    expect(reviews[0].mine).toBe(true); // your own comes first
    expect(reviews.every((r) => typeof r.author === "string" && r.author.length > 0)).toBe(true);
    expect(reviews.filter((r) => r.mine)).toHaveLength(1);
    // The average covers every rating, not just yours.
    expect(view.body.averageRating).toBeGreaterThan(0);
  });

  it("validates the input", async () => {
    expect((await topic({ action: "review", body: "   " })).status).toBe(400);
    expect((await topic({ action: "review", body: "x".repeat(2001) })).status).toBe(400);
    expect((await topic({ action: "review", body: "ok", rating: 9 })).status).toBe(400);
    expect((await topic({ action: "nonsense" })).status).toBe(400);
  });

  it("only ever deletes your own review", async () => {
    await topic({ action: "delete-review" });
    expect(await db.topicReview.count({ where: { user: { email: emails[0] } } })).toBe(0);
    expect(await db.topicReview.count({ where: { user: { email: emails[1] } } })).toBe(1);
  });

  it("404s for a topic that doesn't exist", async () => {
    const res = await api("/api/topics/sql/not-a-topic", { method: "POST", body: JSON.stringify({ action: "like", liked: true }) });
    expect(res.status).toBe(404);
  });
});

describe("live users", () => {
  it("counts each signed-in learner once and needs a session", async () => {
    expect((await api("/api/presence", { method: "POST", body: "{}" }, "")).status).toBe(401);

    const first = await api("/api/presence", { method: "POST", body: "{}" }, jars[0]);
    expect(first.status).toBe(200);
    expect(first.body.live).toBeGreaterThanOrEqual(1);

    // The same learner pinging again does not add to the count.
    const again = await api("/api/presence", { method: "POST", body: "{}" }, jars[0]);
    expect(again.body.live).toBe(first.body.live);

    // A second learner does.
    const second = await api("/api/presence", { method: "POST", body: "{}" }, jars[1]);
    expect(second.body.live).toBe((first.body.live as number) + 1);

    // And reading it back agrees.
    const read = await api("/api/presence", {}, jars[0]);
    expect(read.body.live).toBe(second.body.live);
  });

  it("rejects a cross-site heartbeat", async () => {
    const res = await fetch(`${BASE}/api/presence`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example", cookie: jars[0] },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });
});

describe("admin analytics", () => {
  it("is closed to ordinary learners", async () => {
    expect((await api("/api/admin/analytics")).status).toBe(403);
    expect((await api("/api/admin/analytics", {}, "")).status).toBe(401);
  });

  it("reports usage, work, funnel and feedback", async () => {
    const res = await api("/api/admin/analytics", {}, adminJar);
    expect(res.status).toBe(200);
    const a = res.body as unknown as import("../../src/lib/analytics.ts").Analytics;

    expect(a.learners.total).toBeGreaterThanOrEqual(3);
    expect(a.active.last30).toBeGreaterThan(0);
    expect(a.activity).toHaveLength(30);
    expect(a.activity.at(-1)?.signups).toBeGreaterThanOrEqual(3);
    expect(a.work.attempts).toBeGreaterThanOrEqual(0);

    // The funnel never grows as it narrows.
    const counts = a.funnel.map((f) => f.count);
    expect(counts[0]).toBe(a.learners.total);
    expect(counts[1]).toBeLessThanOrEqual(counts[0]);
    expect(counts[3]).toBeLessThanOrEqual(counts[2]);

    expect(a.courses.map((c) => c.slug).sort()).toEqual(["linux", "sql"]);
    expect(a.feedback.reviews).toBeGreaterThanOrEqual(1);
    expect(a.feedback.recent[0]).toHaveProperty("author");
  });
});
