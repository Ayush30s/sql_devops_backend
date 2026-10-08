import { db } from "./db.ts";
import { courseProgress } from "./progress.ts";

/**
 * Analytics for the learner themself: pace, accuracy, where the time goes and what is left.
 * Nothing here compares them to anyone else — only to their own last few weeks.
 */

export interface LearnerDay {
  day: string;
  solved: number;
  attempts: number;
}

export interface LearnerCourse {
  slug: string;
  title: string;
  exercises: number;
  completed: number;
  pct: number;
  topics: number;
  topicsCompleted: number;
  attempts: number;
  correct: number;
  accuracy: number | null;
  remaining: number;
  /**
   * Weeks left at the current pace — only when the pace is real (at least one exercise a week)
   * and the answer is within a year. "255 weeks left" helps nobody.
   */
  weeksLeft: number | null;
}

export interface LearnerAnalytics {
  /** Last 56 days, oldest first — the practice calendar. */
  days: LearnerDay[];
  totals: {
    attempts: number;
    correct: number;
    accuracy: number | null;
    completed: number;
    firstTry: number;
    firstTryRate: number | null;
    hintsUsed: number;
    solutionsRevealed: number;
    minutes: number;
    minutesPerExercise: number | null;
    activeDays: number;
  };
  pace: { last7: number; last28: number; perWeek: number; bestDay: LearnerDay | null };
  courses: LearnerCourse[];
}

const DAYS = 56;
const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000);

export async function learnerAnalytics(userId: string): Promise<LearnerAnalytics> {
  const since = daysAgo(DAYS - 1);

  const [attemptsByDay, solvedByDay, progress, attemptTotals, perCourse, sql, linux] = await Promise.all([
    db.$queryRaw<{ day: Date; attempts: bigint; correct: bigint }[]>`
      SELECT date_trunc('day', "createdAt") AS day,
             count(*) AS attempts,
             count(*) FILTER (WHERE status::text = 'CORRECT') AS correct
        FROM exercise_attempts
       WHERE "userId" = ${userId}::uuid AND "createdAt" >= ${since}
       GROUP BY 1`,
    db.$queryRaw<{ day: Date; solved: bigint }[]>`
      SELECT date_trunc('day', "completedAt") AS day, count(*) AS solved
        FROM exercise_progress
       WHERE "userId" = ${userId}::uuid AND "completedAt" >= ${since}
       GROUP BY 1`,
    db.exerciseProgress.aggregate({
      where: { userId },
      _sum: { hintsUsed: true, timeSpentSec: true },
      _count: { _all: true },
    }),
    db.exerciseAttempt.groupBy({ by: ["status"], where: { userId }, _count: { _all: true } }),
    db.$queryRaw<{ course: string; attempts: bigint; correct: bigint }[]>`
      SELECT c.slug AS course,
             count(*) AS attempts,
             count(*) FILTER (WHERE a.status::text = 'CORRECT') AS correct
        FROM exercise_attempts a
        JOIN exercises e ON e.id = a."exerciseId"
        JOIN topics t ON t.id = e."topicId"
        JOIN modules m ON m.id = t."moduleId"
        JOIN courses c ON c.id = m."courseId"
       WHERE a."userId" = ${userId}::uuid
       GROUP BY 1`,
    courseProgress("sql", userId),
    courseProgress("linux", userId),
  ]);

  const [completed, firstTry, revealed] = await Promise.all([
    db.exerciseProgress.count({ where: { userId, status: "COMPLETED" } }),
    db.exerciseProgress.count({ where: { userId, status: "COMPLETED", attempts: 1, hintsUsed: 0, solutionRevealed: false } }),
    db.exerciseProgress.count({ where: { userId, solutionRevealed: true } }),
  ]);

  const attemptsMap = new Map(attemptsByDay.map((r) => [dayKey(r.day), Number(r.attempts)]));
  const solvedMap = new Map(solvedByDay.map((r) => [dayKey(r.day), Number(r.solved)]));
  const days: LearnerDay[] = Array.from({ length: DAYS }, (_, i) => {
    const day = dayKey(daysAgo(DAYS - 1 - i));
    return { day, solved: solvedMap.get(day) ?? 0, attempts: attemptsMap.get(day) ?? 0 };
  });

  const solvedWithin = (n: number) => days.slice(-n).reduce((sum, d) => sum + d.solved, 0);
  const last28 = solvedWithin(28);
  const attempts = attemptTotals.reduce((n, r) => n + r._count._all, 0);
  const correct = attemptTotals.find((r) => r.status === "CORRECT")?._count._all ?? 0;
  const minutes = Math.round((progress._sum.timeSpentSec ?? 0) / 60);
  const byCourse = new Map(perCourse.map((r) => [r.course, { attempts: Number(r.attempts), correct: Number(r.correct) }]));
  const perWeek = last28 / 4;

  const courses: LearnerCourse[] = [sql, linux].filter((c) => c !== null).map((c) => {
    const stats = byCourse.get(c.slug) ?? { attempts: 0, correct: 0 };
    const remaining = c.totals.exercises - c.totals.exercisesCompleted;
    return {
      slug: c.slug,
      title: c.title,
      exercises: c.totals.exercises,
      completed: c.totals.exercisesCompleted,
      pct: c.totals.exercises ? Math.round((c.totals.exercisesCompleted / c.totals.exercises) * 1000) / 10 : 0,
      topics: c.totals.topics,
      topicsCompleted: c.totals.topicsCompleted,
      attempts: stats.attempts,
      correct: stats.correct,
      accuracy: stats.attempts ? Math.round((stats.correct / stats.attempts) * 100) : null,
      remaining,
      weeksLeft: perWeek >= 1 && remaining > 0 && remaining / perWeek <= 52 ? Math.ceil(remaining / perWeek) : null,
    };
  });

  return {
    days,
    totals: {
      attempts,
      correct,
      accuracy: attempts ? Math.round((correct / attempts) * 100) : null,
      completed,
      firstTry,
      firstTryRate: completed ? Math.round((firstTry / completed) * 100) : null,
      hintsUsed: progress._sum.hintsUsed ?? 0,
      solutionsRevealed: revealed,
      minutes,
      minutesPerExercise: completed ? Math.round((minutes / completed) * 10) / 10 : null,
      activeDays: days.filter((d) => d.attempts > 0).length,
    },
    pace: {
      last7: solvedWithin(7),
      last28,
      perWeek: Math.round(perWeek * 10) / 10,
      bestDay: days.reduce<LearnerDay | null>((best, d) => (d.solved > (best?.solved ?? 0) ? d : best), null),
    },
    courses,
  };
}
