import { describe, expect, it } from "vitest";
import { earned, type AchievementStats } from "../../src/lib/achievements.ts";
import { levelFor, nextStreak, xpFor, xpForLevel } from "../../src/lib/progress.ts";

describe("levels", () => {
  it("starts at level 1 with no XP", () => {
    expect(levelFor(0)).toEqual({ level: 1, xpInto: 0, xpForNext: 100 });
  });

  it("levels up exactly at the threshold", () => {
    expect(xpForLevel(2)).toBe(100);
    expect(levelFor(99).level).toBe(1);
    expect(levelFor(100).level).toBe(2);
    expect(levelFor(299).level).toBe(2);
    expect(levelFor(300).level).toBe(3);
  });

  it("reports progress inside the current level", () => {
    expect(levelFor(150)).toEqual({ level: 2, xpInto: 50, xpForNext: 200 });
  });

  it("never goes backwards as XP grows", () => {
    let last = 0;
    for (let xp = 0; xp < 5000; xp += 37) {
      const { level } = levelFor(xp);
      expect(level).toBeGreaterThanOrEqual(last);
      last = level;
    }
  });
});

describe("XP for an exercise", () => {
  it("gives the full amount for an unaided solve", () => {
    expect(xpFor(20, 0, false)).toBe(20);
  });

  it("reduces it when hints were used", () => {
    expect(xpFor(20, 1, false)).toBe(15);
    expect(xpFor(20, 3, false)).toBe(15);
  });

  it("reduces it hard when the solution was revealed", () => {
    expect(xpFor(20, 0, true)).toBe(5);
    expect(xpFor(20, 2, true)).toBe(5);
  });
});

describe("streaks", () => {
  it("starts at one on the first day", () => {
    expect(nextStreak(0, 0, null, "2026-10-02")).toEqual({ current: 1, longest: 1, lastActiveDate: "2026-10-02", changed: true });
  });

  it("continues across consecutive days", () => {
    expect(nextStreak(3, 5, "2026-10-01", "2026-10-02")).toMatchObject({ current: 4, longest: 5 });
  });

  it("raises the longest streak when the current one passes it", () => {
    expect(nextStreak(5, 5, "2026-10-01", "2026-10-02")).toMatchObject({ current: 6, longest: 6 });
  });

  it("resets after a missed day", () => {
    expect(nextStreak(9, 9, "2026-09-29", "2026-10-02")).toMatchObject({ current: 1, longest: 9 });
  });

  it("does nothing twice on the same day", () => {
    expect(nextStreak(4, 7, "2026-10-02", "2026-10-02")).toEqual({ current: 4, longest: 7, lastActiveDate: "2026-10-02", changed: false });
  });

  it("handles month and year boundaries", () => {
    expect(nextStreak(2, 2, "2026-09-30", "2026-10-01")).toMatchObject({ current: 3 });
    expect(nextStreak(2, 2, "2025-12-31", "2026-01-01")).toMatchObject({ current: 3 });
  });
});

const stats = (over: Partial<AchievementStats> = {}): AchievementStats => ({
  completedExercises: { SQL: 0, LINUX: 0 },
  completedChallenges: 0,
  completedTopics: { SQL: 0, LINUX: 0 },
  completedModules: new Set(),
  firstTryCorrect: 0,
  streakDays: 0,
  level: 1,
  ...over,
});

describe("achievement criteria", () => {
  it("counts exercises per course and in total", () => {
    const s = stats({ completedExercises: { SQL: 60, LINUX: 10 } });
    expect(earned({ type: "exercises", count: 50, kind: "SQL" }, s)).toBe(true);
    expect(earned({ type: "exercises", count: 50, kind: "LINUX" }, s)).toBe(false);
    expect(earned({ type: "exercises", count: 70 }, s)).toBe(true);
  });

  it("matches modules by course-qualified slug", () => {
    const s = stats({ completedModules: new Set(["sql/joins"]) });
    expect(earned({ type: "module", slug: "sql/joins" }, s)).toBe(true);
    expect(earned({ type: "module", slug: "linux/joins" }, s)).toBe(false);
  });

  it("checks streaks, levels, challenges and first-try solves", () => {
    const s = stats({ streakDays: 7, level: 5, completedChallenges: 3, firstTryCorrect: 10 });
    expect(earned({ type: "streak", days: 7 }, s)).toBe(true);
    expect(earned({ type: "streak", days: 30 }, s)).toBe(false);
    expect(earned({ type: "level", level: 5 }, s)).toBe(true);
    expect(earned({ type: "challenges", count: 3 }, s)).toBe(true);
    expect(earned({ type: "firstTry", count: 10 }, s)).toBe(true);
    expect(earned({ type: "firstTry", count: 11 }, s)).toBe(false);
  });
});
