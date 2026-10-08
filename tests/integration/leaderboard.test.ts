import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../src/lib/db.ts";
import { leaderboard } from "../../src/lib/leaderboard.ts";

/** Ranking, ties, the opt-out and "where do I stand", against the real database. */

const tag = randomUUID().slice(0, 8);
const made: { id: string; name: string }[] = [];

/** A learner with a known score: `xp` XP spread over `solved` completed exercises. */
async function learner(name: string, xp: number, solved: number, streak: number, onLeaderboard = true) {
  const user = await db.user.create({
    data: {
      email: `lb-${tag}-${name}@dsa.test`,
      name: `${name}-${tag}`,
      passwordHash: "x",
      profile: { create: { onLeaderboard } },
      streak: { create: { current: streak, longest: streak } },
    },
  });
  const exercises = await db.exercise.findMany({ take: solved, orderBy: { slug: "asc" }, select: { id: true } });
  if (exercises.length < solved) throw new Error("Not enough exercises in the database.");
  for (const [i, e] of exercises.entries())
    await db.exerciseProgress.create({
      data: {
        userId: user.id,
        exerciseId: e.id,
        status: "COMPLETED",
        attempts: 1,
        correctAttempts: 1,
        // The last row carries the remainder so the total is exactly `xp`.
        xpEarned: i === solved - 1 ? xp - Math.floor(xp / solved) * (solved - 1) : Math.floor(xp / solved),
        completedAt: new Date(),
      },
    });
  made.push({ id: user.id, name: user.name });
  return user;
}

let alice: { id: string };
let bob: { id: string };
let carol: { id: string };
let hidden: { id: string };

beforeAll(async () => {
  alice = await learner("alice", 300, 3, 5);
  bob = await learner("bob", 200, 4, 9);
  carol = await learner("carol", 200, 2, 1);
  hidden = await learner("hidden", 900, 5, 30, false);
});

afterAll(async () => {
  await db.user.deleteMany({ where: { email: { contains: `lb-${tag}-` } } });
  await db.$disconnect();
});

const rowsOf = (board: Awaited<ReturnType<typeof leaderboard>>) => board.rows.filter((r) => r.name.endsWith(tag));

describe("ranking", () => {
  it("orders by XP and keeps the numbers that produced the order", async () => {
    const board = await leaderboard("xp", alice.id, 500);
    const mine = rowsOf(board);
    expect(mine.map((r) => r.name.split("-")[0])).toEqual(["alice", "bob", "carol"]);
    expect(mine[0]).toMatchObject({ xp: 300, solved: 3, streak: 5, me: true });
    expect(mine[1]).toMatchObject({ xp: 200, solved: 4, streak: 9 });
  });

  it("gives tied scores the same rank, and the next learner their true position", async () => {
    const board = await leaderboard("xp", null, 500);
    const bobRow = board.rows.find((r) => r.userId === bob.id)!;
    const carolRow = board.rows.find((r) => r.userId === carol.id)!;
    expect(bobRow.xp).toBe(carolRow.xp);
    expect(bobRow.rank).toBe(carolRow.rank);

    // Competition ranking: after two learners sharing rank N, the next distinct score is N+2.
    const sorted = [...board.rows].sort((a, b) => a.rank - b.rank);
    for (const [i, row] of sorted.entries()) {
      const ahead = sorted.filter((r) => r.xp > row.xp).length;
      expect(row.rank, `${row.name} ranked ${row.rank}`).toBe(ahead + 1);
      void i;
    }
  });

  it("re-sorts by exercises solved and by streak", async () => {
    const bySolved = rowsOf(await leaderboard("solved", null, 500));
    expect(bySolved.map((r) => r.name.split("-")[0])).toEqual(["bob", "alice", "carol"]);

    const byStreak = rowsOf(await leaderboard("streak", null, 500));
    expect(byStreak.map((r) => r.name.split("-")[0])).toEqual(["bob", "alice", "carol"]);
  });

  it("splits completions between the two courses", async () => {
    const board = await leaderboard("xp", null, 500);
    for (const row of rowsOf(board)) expect(row.sqlSolved + row.linuxSolved).toBe(row.solved);
  });
});

describe("privacy and your own position", () => {
  it("leaves out anyone who opted out, however high their score", async () => {
    const board = await leaderboard("xp", hidden.id, 500);
    expect(board.rows.some((r) => r.userId === hidden.id)).toBe(false);
    expect(board.you).toBeNull();
    // 900 XP would have been first; the top is unaffected.
    expect(board.rows[0]?.userId).not.toBe(hidden.id);
  });

  it("still reports your row when you fall outside the visible top", async () => {
    const board = await leaderboard("xp", carol.id, 1);
    expect(board.rows).toHaveLength(1);
    expect(board.rows[0].userId).not.toBe(carol.id);
    expect(board.you?.userId).toBe(carol.id);
    expect(board.you?.rank).toBeGreaterThan(1);
    expect(board.total).toBeGreaterThanOrEqual(3);
  });

  it("omits learners who have done nothing at all", async () => {
    const idle = await db.user.create({
      data: { email: `lb-${tag}-idle@dsa.test`, name: `idle-${tag}`, passwordHash: "x", profile: { create: {} }, streak: { create: {} } },
    });
    const board = await leaderboard("xp", idle.id, 500);
    expect(board.rows.some((r) => r.userId === idle.id)).toBe(false);
    expect(board.you).toBeNull();
  });
});
