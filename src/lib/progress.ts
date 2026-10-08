import type { AttemptStatus, CourseKind, Exercise, Prisma } from "@prisma/client";
import type { AchievementStats, Criteria } from "./achievements.ts";
import { earned } from "./achievements.ts";
import { db } from "./db.ts";

// ---- levels ---------------------------------------------------------------------------------

/** Level L starts at 50·L·(L−1) XP: 0, 100, 300, 600, 1000, 1500, … */
export const xpForLevel = (level: number) => 50 * level * (level - 1);

export function levelFor(xp: number) {
  let level = 1;
  while (xpForLevel(level + 1) <= xp) level++;
  return { level, xpInto: xp - xpForLevel(level), xpForNext: xpForLevel(level + 1) - xpForLevel(level) };
}

/** Hints and revealed solutions reduce the XP, so the number means something. */
export function xpFor(exerciseXp: number, hintsUsed: number, solutionRevealed: boolean) {
  if (solutionRevealed) return Math.round(exerciseXp * 0.25);
  return Math.round(exerciseXp * (hintsUsed > 0 ? 0.75 : 1));
}

// ---- streaks --------------------------------------------------------------------------------

export const today = (timezone = "UTC") => new Date().toLocaleDateString("en-CA", { timeZone: timezone });

/** YYYY-MM-DD strings compare as dates; a gap of exactly one day continues the streak. */
export function nextStreak(current: number, longest: number, lastActiveDate: string | null, day: string) {
  if (lastActiveDate === day) return { current, longest, lastActiveDate: day, changed: false };
  const yesterday = new Date(`${day}T00:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const next = lastActiveDate === yesterday.toISOString().slice(0, 10) ? current + 1 : 1;
  return { current: next, longest: Math.max(longest, next), lastActiveDate: day, changed: true };
}

// ---- recording an attempt -------------------------------------------------------------------

export interface AttemptOutcome {
  status: AttemptStatus;
  feedback: string;
  code: string;
  durationMs: number;
  /** Seconds the learner spent on the exercise page, as reported by the client (clamped). */
  timeSpentSec?: number;
}

export interface AttemptRecord {
  correct: boolean;
  firstCompletion: boolean;
  xpEarned: number;
  totalXp: number;
  level: number;
  leveledUp: boolean;
  streak: number;
  topicCompleted: boolean;
  newAchievements: { slug: string; title: string; description: string }[];
}

/**
 * Writes one attempt and everything derived from it: exercise progress, XP, topic progress,
 * the streak and any newly earned badges. XP is only ever granted on the first completion.
 */
export async function recordAttempt(userId: string, exercise: Exercise, outcome: AttemptOutcome): Promise<AttemptRecord> {
  const correct = outcome.status === "CORRECT";
  const now = new Date();
  const before = await db.exerciseProgress.findUnique({ where: { userId_exerciseId: { userId, exerciseId: exercise.id } } });
  const firstCompletion = correct && !before?.completedAt;
  const xpEarned = firstCompletion ? xpFor(exercise.xp, before?.hintsUsed ?? 0, before?.solutionRevealed ?? false) : 0;
  const timeSpentSec = Math.min(Math.max(outcome.timeSpentSec ?? 0, 0), 3600);

  await db.$transaction([
    db.exerciseAttempt.create({
      data: { userId, exerciseId: exercise.id, code: outcome.code.slice(0, 20000), status: outcome.status, feedback: outcome.feedback.slice(0, 2000), durationMs: outcome.durationMs },
    }),
    db.exerciseProgress.upsert({
      where: { userId_exerciseId: { userId, exerciseId: exercise.id } },
      create: {
        userId,
        exerciseId: exercise.id,
        status: correct ? "COMPLETED" : "IN_PROGRESS",
        attempts: 1,
        correctAttempts: correct ? 1 : 0,
        incorrectAttempts: correct ? 0 : 1,
        xpEarned,
        timeSpentSec,
        firstAttemptAt: now,
        lastAttemptAt: now,
        completedAt: correct ? now : null,
      },
      update: {
        status: correct || before?.status === "COMPLETED" ? "COMPLETED" : "IN_PROGRESS",
        attempts: { increment: 1 },
        correctAttempts: { increment: correct ? 1 : 0 },
        incorrectAttempts: { increment: correct ? 0 : 1 },
        xpEarned: { increment: xpEarned },
        timeSpentSec: { increment: timeSpentSec },
        lastAttemptAt: now,
        ...(firstCompletion && { completedAt: now }),
      },
    }),
    db.topicProgress.upsert({
      where: { userId_topicId: { userId, topicId: exercise.topicId } },
      create: { userId, topicId: exercise.topicId, lastActivityAt: now, timeSpentSec },
      update: { lastActivityAt: now, timeSpentSec: { increment: timeSpentSec } },
    }),
  ]);

  const topicCompleted = firstCompletion ? await refreshTopicCompletion(userId, exercise.topicId) : false;
  const streak = await touchStreak(userId);
  const totals = await xpTotal(userId);
  const level = levelFor(totals).level;
  const leveledUp = xpEarned > 0 && level > levelFor(totals - xpEarned).level;
  const newAchievements = await refreshAchievements(userId);
  return { correct, firstCompletion, xpEarned, totalXp: totals, level, leveledUp, streak, topicCompleted, newAchievements };
}

export const xpTotal = async (userId: string) =>
  (await db.exerciseProgress.aggregate({ where: { userId }, _sum: { xpEarned: true } }))._sum.xpEarned ?? 0;

/** A topic counts as completed when every exercise in it is completed. */
async function refreshTopicCompletion(userId: string, topicId: string) {
  const [total, done, progress] = await Promise.all([
    db.exercise.count({ where: { topicId } }),
    db.exerciseProgress.count({ where: { userId, status: "COMPLETED", exercise: { topicId } } }),
    db.topicProgress.findUnique({ where: { userId_topicId: { userId, topicId } } }),
  ]);
  if (total === 0 || done < total || progress?.completedAt) return false;
  await db.topicProgress.update({ where: { userId_topicId: { userId, topicId } }, data: { completedAt: new Date() } });
  return true;
}

export async function markLessonRead(userId: string, topicId: string) {
  const now = new Date();
  await db.topicProgress.upsert({
    where: { userId_topicId: { userId, topicId } },
    create: { userId, topicId, lessonCompletedAt: now, lastActivityAt: now },
    update: { lessonCompletedAt: now, lastActivityAt: now },
  });
  await touchStreak(userId);
}

/** Once an exercise is solved, its hints and solution are free: asking afterwards is never held against it. */
const isSolved = async (userId: string, exerciseId: string) =>
  (await db.exerciseProgress.findUnique({ where: { userId_exerciseId: { userId, exerciseId } }, select: { status: true } }))?.status === "COMPLETED";

export async function recordHint(userId: string, exerciseId: string, hintIndex: number) {
  if (await isSolved(userId, exerciseId)) return;
  const now = new Date();
  await db.exerciseProgress.upsert({
    where: { userId_exerciseId: { userId, exerciseId } },
    create: { userId, exerciseId, hintsUsed: hintIndex + 1, firstAttemptAt: now, lastAttemptAt: now },
    update: { hintsUsed: { set: hintIndex + 1 }, lastAttemptAt: now },
  });
}

export async function recordReveal(userId: string, exerciseId: string) {
  if (await isSolved(userId, exerciseId)) return;
  const now = new Date();
  await db.exerciseProgress.upsert({
    where: { userId_exerciseId: { userId, exerciseId } },
    create: { userId, exerciseId, solutionRevealed: true, firstAttemptAt: now, lastAttemptAt: now },
    update: { solutionRevealed: true, lastAttemptAt: now },
  });
}

export async function touchStreak(userId: string) {
  const profile = await db.profile.findUnique({ where: { userId }, select: { timezone: true } });
  const day = today(profile?.timezone ?? "UTC");
  const streak = await db.streak.findUnique({ where: { userId } });
  const next = nextStreak(streak?.current ?? 0, streak?.longest ?? 0, streak?.lastActiveDate ?? null, day);
  if (!next.changed) return next.current;
  await db.streak.upsert({
    where: { userId },
    create: { userId, current: next.current, longest: next.longest, lastActiveDate: day },
    update: { current: next.current, longest: next.longest, lastActiveDate: day },
  });
  return next.current;
}

// ---- achievements ---------------------------------------------------------------------------

export async function achievementStats(userId: string): Promise<AchievementStats> {
  const [completed, challenges, topics, firstTry, streak, xp, modules] = await Promise.all([
    db.exerciseProgress.groupBy({ by: ["exerciseId"], where: { userId, status: "COMPLETED" } }).then(async (rows) => {
      if (!rows.length) return { SQL: 0, LINUX: 0 };
      const kinds = await db.exercise.groupBy({ by: ["kind"], where: { id: { in: rows.map((r) => r.exerciseId) } }, _count: { _all: true } });
      return { SQL: kinds.find((k) => k.kind === "SQL")?._count._all ?? 0, LINUX: kinds.find((k) => k.kind === "LINUX")?._count._all ?? 0 };
    }),
    db.exerciseProgress.count({ where: { userId, status: "COMPLETED", exercise: { isChallenge: true } } }),
    db.topicProgress.findMany({ where: { userId, completedAt: { not: null } }, select: { topic: { select: { module: { select: { course: { select: { kind: true } } } } } } } }),
    db.exerciseProgress.count({ where: { userId, status: "COMPLETED", attempts: 1, hintsUsed: 0, solutionRevealed: false } }),
    db.streak.findUnique({ where: { userId } }),
    xpTotal(userId),
    completedModuleSlugs(userId),
  ]);
  return {
    completedExercises: completed,
    completedChallenges: challenges,
    completedTopics: {
      SQL: topics.filter((t) => t.topic.module.course.kind === "SQL").length,
      LINUX: topics.filter((t) => t.topic.module.course.kind === "LINUX").length,
    },
    completedModules: modules,
    firstTryCorrect: firstTry,
    streakDays: streak?.current ?? 0,
    level: levelFor(xp).level,
  };
}

/** "<course slug>/<module slug>" for every module whose exercises are all completed. */
export async function completedModuleSlugs(userId: string) {
  const [all, done] = await Promise.all([
    db.module.findMany({ select: { id: true, slug: true, course: { select: { slug: true } }, topics: { select: { exercises: { select: { id: true } } } } } }),
    db.exerciseProgress.findMany({ where: { userId, status: "COMPLETED" }, select: { exercise: { select: { topic: { select: { moduleId: true } } } } } }),
  ]);
  const byModule = new Map<string, number>();
  for (const row of done) byModule.set(row.exercise.topic.moduleId, (byModule.get(row.exercise.topic.moduleId) ?? 0) + 1);
  const complete = new Set<string>();
  for (const m of all) {
    const total = m.topics.reduce((n, t) => n + t.exercises.length, 0);
    if (total > 0 && (byModule.get(m.id) ?? 0) >= total) complete.add(`${m.course.slug}/${m.slug}`);
  }
  return complete;
}

/** Grants every badge whose criteria now hold. Returns the ones granted by this call. */
export async function refreshAchievements(userId: string) {
  const [all, mine, stats] = await Promise.all([
    db.achievement.findMany({ orderBy: { position: "asc" } }),
    db.userAchievement.findMany({ where: { userId }, select: { achievementId: true } }),
    achievementStats(userId),
  ]);
  const have = new Set(mine.map((m) => m.achievementId));
  const fresh = all.filter((a) => !have.has(a.id) && earned(a.criteria as Criteria, stats));
  if (fresh.length)
    await db.userAchievement.createMany({ data: fresh.map((a) => ({ userId, achievementId: a.id })), skipDuplicates: true });
  return fresh.map((a) => ({ slug: a.slug, title: a.title, description: a.description }));
}

// ---- course progress and recommendations ----------------------------------------------------

export interface TopicProgressView {
  slug: string;
  title: string;
  summary: string;
  difficulty: string;
  moduleSlug: string;
  moduleTitle: string;
  exercises: number;
  completed: number;
  attempted: number;
  accuracy: number | null;
  lessonRead: boolean;
  completedAt: string | null;
  lastActivityAt: string | null;
  /** Prerequisite topics that are not finished yet; empty means the topic is open. */
  locked: string[];
}

export interface CourseProgressView {
  slug: string;
  kind: CourseKind;
  title: string;
  description: string;
  topics: TopicProgressView[];
  modules: { slug: string; title: string; description: string; topics: string[] }[];
  totals: { topics: number; topicsCompleted: number; exercises: number; exercisesCompleted: number; xp: number };
  /** The one obvious next thing to do. */
  next: { topicSlug: string; reason: "continue" | "next" | "review" | "done" } | null;
  strong: string[];
  needsPractice: string[];
}

const courseInclude = {
  modules: {
    orderBy: { position: "asc" },
    include: {
      topics: {
        orderBy: { position: "asc" },
        include: { exercises: { select: { id: true } }, prerequisites: { select: { slug: true } } },
      },
    },
  },
} satisfies Prisma.CourseInclude;

/**
 * Everything the home page, the sidebar and the progress page need for one course.
 * The "next" topic is deterministic: finish what you started, else the first open topic.
 */
export async function courseProgress(courseSlug: string, userId: string | null): Promise<CourseProgressView | null> {
  const course = await db.course.findUnique({ where: { slug: courseSlug }, include: courseInclude });
  if (!course) return null;

  const topicRows = course.modules.flatMap((m) => m.topics.map((t) => ({ module: m, topic: t })));
  const exerciseIds = topicRows.flatMap(({ topic }) => topic.exercises.map((e) => e.id));
  const [progress, topicProgress] = userId
    ? await Promise.all([
        db.exerciseProgress.findMany({ where: { userId, exerciseId: { in: exerciseIds } } }),
        db.topicProgress.findMany({ where: { userId, topicId: { in: topicRows.map(({ topic }) => topic.id) } } }),
      ])
    : [[], []];
  const byExercise = new Map(progress.map((p) => [p.exerciseId, p]));
  const byTopic = new Map(topicProgress.map((p) => [p.topicId, p]));

  const views: TopicProgressView[] = topicRows.map(({ module, topic }) => {
    const rows = topic.exercises.map((e) => byExercise.get(e.id)).filter((p) => p !== undefined);
    const completed = rows.filter((p) => p.status === "COMPLETED").length;
    const correct = rows.reduce((n, p) => n + p.correctAttempts, 0);
    const attempts = rows.reduce((n, p) => n + p.attempts, 0);
    const tp = byTopic.get(topic.id);
    return {
      slug: topic.slug,
      title: topic.title,
      summary: topic.summary,
      difficulty: topic.difficulty,
      moduleSlug: module.slug,
      moduleTitle: module.title,
      exercises: topic.exercises.length,
      completed,
      attempted: rows.length,
      accuracy: attempts > 0 ? Math.round((correct / attempts) * 100) : null,
      lessonRead: !!tp?.lessonCompletedAt,
      completedAt: tp?.completedAt?.toISOString() ?? null,
      lastActivityAt: tp?.lastActivityAt?.toISOString() ?? null,
      locked: [],
    };
  });
  // Nothing is actually gated: `locked` is reserved for advanced topics whose groundwork
  // is genuinely missing, so the lock means something when a learner sees one.
  const bySlug = new Map(views.map((v) => [v.slug, v]));
  for (const [i, { topic }] of topicRows.entries())
    views[i].locked =
      topic.difficulty !== "ADVANCED"
        ? []
        : topic.prerequisites.map((p) => p.slug).filter((slug) => {
            const pre = bySlug.get(slug);
            return pre ? !pre.completedAt : false;
          });

  const started = views.filter((v) => v.attempted > 0 && !v.completedAt && v.locked.length === 0);
  const open = views.filter((v) => !v.completedAt && v.locked.length === 0);
  const weak = views.filter((v) => v.completedAt && v.accuracy !== null && v.accuracy < 60);
  const next: CourseProgressView["next"] = started.length
    ? { topicSlug: started.sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""))[0].slug, reason: "continue" }
    : open.length
      ? { topicSlug: open[0].slug, reason: "next" }
      : weak.length
        ? { topicSlug: weak[0].slug, reason: "review" }
        : views.length
          ? { topicSlug: views[views.length - 1].slug, reason: "done" }
          : null;

  return {
    slug: course.slug,
    kind: course.kind,
    title: course.title,
    description: course.description,
    topics: views,
    modules: course.modules.map((m) => ({ slug: m.slug, title: m.title, description: m.description, topics: m.topics.map((t) => t.slug) })),
    totals: {
      topics: views.length,
      topicsCompleted: views.filter((v) => v.completedAt).length,
      exercises: exerciseIds.length,
      exercisesCompleted: progress.filter((p) => p.status === "COMPLETED").length,
      xp: progress.reduce((n, p) => n + p.xpEarned, 0),
    },
    next,
    strong: views.filter((v) => v.completedAt && (v.accuracy ?? 0) >= 85).map((v) => v.slug),
    needsPractice: views.filter((v) => v.attempted > 0 && (v.accuracy ?? 100) < 60).map((v) => v.slug),
  };
}

export interface ReviewItem {
  exerciseSlug: string;
  title: string;
  topicSlug: string;
  topicTitle: string;
  courseSlug: string;
  kind: CourseKind;
  isChallenge: boolean;
  /** Ready-made link to the right tab (practice or challenge) with the exercise selected. */
  href: string;
  reason: "unsolved" | "struggled" | "revealed";
  attempts: number;
  hintsUsed: number;
}

/** Deterministic review queue: unsolved attempts first, then struggles, then revealed solutions. */
export async function reviewItems(userId: string, limit = 20): Promise<ReviewItem[]> {
  const rows = await db.exerciseProgress.findMany({
    where: {
      userId,
      OR: [{ status: "IN_PROGRESS", attempts: { gt: 0 } }, { solutionRevealed: true }, { incorrectAttempts: { gte: 2 } }, { hintsUsed: { gte: 2 } }],
    },
    include: { exercise: { include: { topic: { include: { module: { include: { course: true } } } } } } },
    orderBy: { lastAttemptAt: "desc" },
  });
  const rank = { unsolved: 0, struggled: 1, revealed: 2 } as const;
  return rows
    .map((p): ReviewItem => ({
      exerciseSlug: p.exercise.slug,
      title: p.exercise.title,
      topicSlug: p.exercise.topic.slug,
      topicTitle: p.exercise.topic.title,
      courseSlug: p.exercise.topic.module.course.slug,
      kind: p.exercise.kind,
      isChallenge: p.exercise.isChallenge,
      href: `/learn/${p.exercise.topic.module.course.slug}/${p.exercise.topic.slug}/${p.exercise.isChallenge ? "challenge" : "practice"}?e=${p.exercise.slug}`,
      reason: p.status !== "COMPLETED" ? "unsolved" : p.incorrectAttempts >= 2 || p.hintsUsed >= 2 ? "struggled" : "revealed",
      attempts: p.attempts,
      hintsUsed: p.hintsUsed,
    }))
    .sort((a, b) => rank[a.reason] - rank[b.reason])
    .slice(0, limit);
}
