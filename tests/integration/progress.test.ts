import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analytics } from "../../src/lib/analytics.ts";
import { createSession, destroySession, hashPassword, verifyPassword } from "../../src/lib/auth.ts";
import { learnerAnalytics } from "../../src/lib/learner-analytics.ts";
import { db } from "../../src/lib/db.ts";
import { courseProgress, recordAttempt, recordHint, recordReveal, refreshAchievements, reviewItems, xpFor, xpTotal } from "../../src/lib/progress.ts";

/**
 * The progress pipeline against the real database: attempts, XP, topic completion,
 * badges, the review queue and the recommendation, plus password and session handling.
 */

let userId: string;
const email = `test-${randomUUID()}@dsa.test`;

const exerciseIn = async (where: object) => {
  const row = await db.exercise.findFirst({ where, orderBy: { position: "asc" } });
  if (!row) throw new Error("No exercise in the database matched.");
  return row;
};

beforeAll(async () => {
  const user = await db.user.create({
    data: { email, name: "Test Learner", passwordHash: await hashPassword("a-long-test-password"), profile: { create: {} }, streak: { create: {} } },
  });
  userId = user.id;
});

afterAll(async () => {
  await db.user.deleteMany({ where: { email } });
  await db.$disconnect();
});

describe("passwords", () => {
  it("verifies the right password and rejects the wrong one", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(await verifyPassword("Correct horse battery staple", stored)).toBe(false);
  });

  it("produces a different hash every time (salted)", async () => {
    expect(await hashPassword("same")).not.toBe(await hashPassword("same"));
  });

  it("never stores the password itself", async () => {
    const stored = await hashPassword("plaintext-should-not-appear");
    expect(stored).not.toContain("plaintext-should-not-appear");
    expect(stored.startsWith("scrypt$")).toBe(true);
  });
});

describe("sessions", () => {
  it("stores only a hash of the token, and deleting the session invalidates it", async () => {
    const { token } = await createSession(userId, "vitest");
    const rows = await db.session.findMany({ where: { userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).not.toBe(token);
    expect(rows[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
    await destroySession(token);
    expect(await db.session.count({ where: { userId } })).toBe(0);
  });
});

describe("recording attempts", () => {
  it("awards XP once, counts attempts, and completes the topic when everything in it is done", async () => {
    const topic = await db.topic.findFirst({
      where: { module: { course: { slug: "sql" } }, exercises: { some: {} } },
      include: { exercises: { orderBy: { position: "asc" } } },
      orderBy: [{ module: { position: "asc" } }, { position: "asc" } ],
    });
    if (!topic) throw new Error("No topics in the database.");

    const first = topic.exercises[0];
    const wrong = await recordAttempt(userId, first, { status: "INCORRECT", feedback: "no", code: "SELECT 1", durationMs: 5 });
    expect(wrong.correct).toBe(false);
    expect(wrong.xpEarned).toBe(0);

    const right = await recordAttempt(userId, first, { status: "CORRECT", feedback: "yes", code: first.solution, durationMs: 5, timeSpentSec: 30 });
    expect(right.correct).toBe(true);
    expect(right.xpEarned).toBe(first.xp);
    expect(right.firstCompletion).toBe(true);
    expect(right.streak).toBeGreaterThanOrEqual(1);

    // Solving it again must not pay twice.
    const again = await recordAttempt(userId, first, { status: "CORRECT", feedback: "yes", code: first.solution, durationMs: 5 });
    expect(again.xpEarned).toBe(0);
    expect(await xpTotal(userId)).toBe(first.xp);

    // Getting it wrong afterwards is counted, but never un-solves it.
    await recordAttempt(userId, first, { status: "INCORRECT", feedback: "no", code: "SELECT 1", durationMs: 5 });

    const progress = await db.exerciseProgress.findUnique({ where: { userId_exerciseId: { userId, exerciseId: first.id } } });
    expect(progress).toMatchObject({ attempts: 4, correctAttempts: 2, incorrectAttempts: 2, status: "COMPLETED" });
    expect(progress?.timeSpentSec).toBe(30);

    // The topic only completes once every exercise in it is done.
    expect(right.topicCompleted).toBe(topic.exercises.length === 1);
    for (const ex of topic.exercises.slice(1)) await recordAttempt(userId, ex, { status: "CORRECT", feedback: "", code: ex.solution, durationMs: 1 });
    const tp = await db.topicProgress.findUnique({ where: { userId_topicId: { userId, topicId: topic.id } } });
    expect(tp?.completedAt).toBeTruthy();
  });

  it("charges XP for the solution only before solving: afterwards it, and the hints, are free", async () => {
    const [early, late] = await db.exercise.findMany({ where: { kind: "SQL", progress: { none: { userId } } }, orderBy: { slug: "asc" }, take: 2 });

    // asked for before solving: the solution costs most of the XP
    await recordReveal(userId, early.id);
    const paid = await recordAttempt(userId, early, { status: "CORRECT", feedback: "", code: early.solution, durationMs: 1 });
    expect(paid.xpEarned).toBe(xpFor(early.xp, 0, true));

    // asked for after solving: nothing is recorded against it
    const solved = await recordAttempt(userId, late, { status: "CORRECT", feedback: "", code: late.solution, durationMs: 1 });
    await recordReveal(userId, late.id);
    await recordHint(userId, late.id, 0);
    const row = await db.exerciseProgress.findUnique({ where: { userId_exerciseId: { userId, exerciseId: late.id } } });
    expect(row).toMatchObject({ solutionRevealed: false, hintsUsed: 0, xpEarned: late.xp });
    expect(solved.xpEarned).toBe(late.xp);
  });

  it("clamps an absurd client-reported time", async () => {
    const ex = await exerciseIn({ kind: "LINUX" });
    await recordAttempt(userId, ex, { status: "INCORRECT", feedback: "", code: "ls", durationMs: 1, timeSpentSec: 999_999 });
    const row = await db.exerciseProgress.findUnique({ where: { userId_exerciseId: { userId, exerciseId: ex.id } } });
    expect(row?.timeSpentSec).toBeLessThanOrEqual(3600);
  });
});

describe("derived views", () => {
  it("reports course progress and a deterministic next topic", async () => {
    const course = await courseProgress("sql", userId);
    expect(course).not.toBeNull();
    expect(course!.totals.exercises).toBeGreaterThan(100);
    expect(course!.totals.exercisesCompleted).toBeGreaterThan(0);
    expect(course!.next?.topicSlug).toBeTruthy();
    // Two calls with the same data must recommend the same thing.
    expect((await courseProgress("sql", userId))!.next).toEqual(course!.next);
  });

  it("puts unfinished work in the review queue", async () => {
    const items = await reviewItems(userId);
    expect(items.some((i) => i.reason === "unsolved")).toBe(true);
  });

  it("grants badges as the work happens, and only once", async () => {
    // recordAttempt already granted these; a later refresh must find nothing new.
    const mine = await db.userAchievement.findMany({ where: { userId }, include: { achievement: { select: { slug: true } } } });
    expect(mine.map((m) => m.achievement.slug)).toContain("first-query");
    expect(await refreshAchievements(userId)).toEqual([]);
    expect(await db.userAchievement.count({ where: { userId } })).toBe(mine.length);
  });

  it("shows nothing completed for a signed-out visitor", async () => {
    const course = await courseProgress("sql", null);
    expect(course!.totals.exercisesCompleted).toBe(0);
    expect(course!.next?.reason).toBe("next");
  });
});

describe("the learner's own analytics", () => {
  it("counts their work, their pace and nobody else's", async () => {
    const me = await learnerAnalytics(userId);

    expect(me.days).toHaveLength(56);
    expect(me.days.at(-1)!.day).toBe(new Date().toISOString().slice(0, 10));
    expect(me.days.at(-1)!.solved).toBeGreaterThan(0);
    expect(me.totals.completed).toBeGreaterThan(0);
    expect(me.totals.attempts).toBe(me.days.reduce((n, d) => n + d.attempts, 0));
    expect(me.totals.accuracy).toBeGreaterThan(0);
    expect(me.totals.accuracy).toBeLessThanOrEqual(100);
    expect(me.totals.activeDays).toBe(1);
    expect(me.pace.last7).toBe(me.totals.completed);
    expect(me.pace.bestDay?.solved).toBe(me.pace.last7);

    // Someone else's numbers never leak in.
    const stranger = await db.user.create({ data: { email: `solo-${randomUUID()}@dsa.test`, name: "Solo", passwordHash: "x", profile: { create: {} } } });
    const empty = await learnerAnalytics(stranger.id);
    expect(empty.totals).toMatchObject({ attempts: 0, completed: 0, accuracy: null, activeDays: 0 });
    expect(empty.courses.every((c) => c.completed === 0 && c.weeksLeft === null)).toBe(true);
    await db.user.delete({ where: { id: stranger.id } });
  });

  it("projects a finish date only when the pace makes it meaningful", async () => {
    const me = await learnerAnalytics(userId);
    for (const c of me.courses) {
      expect(c.completed).toBeLessThanOrEqual(c.exercises);
      expect(c.remaining).toBe(c.exercises - c.completed);
      // A couple of exercises in one day is not a pace worth extrapolating from.
      if (c.weeksLeft !== null) expect(c.weeksLeft).toBeLessThanOrEqual(52);
    }
  });
});

describe("completion analytics", () => {
  it("counts a topic as completed only when every exercise in it is done", async () => {
    const a = await analytics();
    const topics = a.topicCompletion;
    expect(topics.length).toBeGreaterThan(70);

    // The topic this suite finished above shows up; a topic nobody touched does not.
    const finished = topics.find((t) => t.completed > 0);
    expect(finished, "at least one topic has a completion").toBeTruthy();
    expect(finished!.started).toBeGreaterThanOrEqual(finished!.completed);

    const untouched = topics.find((t) => t.started === 0);
    expect(untouched?.completed ?? 0).toBe(0);

    // A learner who solved only part of a topic never counts as completing it.
    const partial = await db.topicProgress.findMany({ where: { userId, completedAt: null }, select: { topicId: true } });
    for (const row of partial) {
      const all = await db.exercise.count({ where: { topicId: row.topicId } });
      const done = await db.exerciseProgress.count({ where: { userId, status: "COMPLETED", exercise: { topicId: row.topicId } } });
      expect(done).toBeLessThan(all);
    }
  });

  it("reports course completion as a share of the whole course, with learners bucketed once each", async () => {
    const a = await analytics();
    for (const course of a.courses) {
      expect(course.exercises).toBeGreaterThan(100);
      expect(course.avgExercisePct).toBeGreaterThanOrEqual(0);
      expect(course.avgExercisePct).toBeLessThanOrEqual(100);
      expect(course.buckets.reduce((n, b) => n + b.count, 0)).toBe(course.learners);
      expect(course.buckets.at(-1)!.count).toBe(course.finished);
      // Nobody here has finished a whole course, so the average must be well under 100%.
      expect(course.avgExercisePct).toBeLessThan(100);
    }
    const sql = a.courses.find((c) => c.slug === "sql")!;
    expect(sql.learners).toBeGreaterThan(0);
    expect(sql.exercisesCompleted).toBeGreaterThan(0);
  });
});
