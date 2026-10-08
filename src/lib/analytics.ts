import { db } from "./db.ts";

/**
 * Platform analytics for the admin panel. "Active" means a learner actually did
 * something — an attempt, a query, a lab command or time on a topic — not just that
 * a session cookie exists.
 */

export interface DayPoint {
  day: string;
  activeUsers: number;
  attempts: number;
  signups: number;
}

/** How many learners got through one topic. */
export interface TopicCompletion {
  courseSlug: string;
  courseTitle: string;
  moduleSlug: string;
  moduleTitle: string;
  slug: string;
  title: string;
  exercises: number;
  /** Learners who opened or attempted it, and learners who finished every exercise in it. */
  started: number;
  completed: number;
  /** completed ÷ started, and completed ÷ every learner on the platform. */
  rate: number;
  shareOfAll: number;
}

export interface CourseCompletion {
  slug: string;
  title: string;
  exercises: number;
  topics: number;
  /** Learners who have completed at least one exercise in this course. */
  learners: number;
  exercisesCompleted: number;
  topicsCompleted: number;
  /** Mean completion across those learners, as a percentage of the course. */
  avgExercisePct: number;
  avgTopicPct: number;
  /** Learners at 100% of the course. */
  finished: number;
  /** How those learners are spread across the course, for the stacked bar. */
  buckets: { label: string; count: number }[];
}

export interface Analytics {
  generatedAt: string;
  learners: { total: number; admins: number; newToday: number; new7: number; new30: number };
  active: { today: number; last7: number; last30: number; everPractised: number };
  activity: DayPoint[];
  work: {
    attempts: number;
    correct: number;
    successRate: number | null;
    exercisesCompleted: number;
    topicsCompleted: number;
    lessonsRead: number;
    xpAwarded: number;
    hintsUsed: number;
    solutionsRevealed: number;
  };
  practice: { queries: number; queryErrors: number; labCommands: number; openLabs: number; avgQueryMs: number };
  courses: CourseCompletion[];
  topicCompletion: TopicCompletion[];
  funnel: { label: string; count: number }[];
  streaks: { active: number; atLeast3: number; atLeast7: number; longest: number };
  feedback: {
    likes: number;
    reviews: number;
    averageRating: number | null;
    topLiked: { slug: string; courseSlug: string; title: string; likes: number }[];
    lowestRated: { slug: string; courseSlug: string; title: string; rating: number; reviews: number }[];
    recent: { id: string; author: string; topic: string; courseSlug: string; topicSlug: string; rating: number | null; body: string; createdAt: string }[];
  };
}

const DAYS = 30;
const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000);

/** One row per (day, learner) across every activity table, so each metric uses the same definition. */
async function activityRows(since: Date) {
  // Prisma maps table names but not columns, so the identifiers stay camelCase and quoted.
  return db.$queryRaw<{ day: Date; userId: string }[]>`
    SELECT DISTINCT date_trunc('day', t.at) AS day, t."userId"
      FROM (
        SELECT "createdAt" AS at, "userId" FROM exercise_attempts WHERE "createdAt" >= ${since}
        UNION ALL
        SELECT "createdAt", "userId" FROM query_history WHERE "createdAt" >= ${since}
        UNION ALL
        SELECT "createdAt", "userId" FROM command_history WHERE "createdAt" >= ${since}
        UNION ALL
        SELECT "lastActivityAt", "userId" FROM topic_progress WHERE "lastActivityAt" >= ${since}
      ) t`;
}

export async function analytics(): Promise<Analytics> {
  const since = daysAgo(DAYS);
  const today = dayKey(new Date());

  const [
    totalUsers,
    admins,
    newToday,
    new7,
    new30,
    rows,
    signups,
    attemptsByDay,
    attempts,
    correct,
    exercisesCompleted,
    topicsCompleted,
    lessonsRead,
    xp,
    hints,
    revealed,
    queries,
    queryErrors,
    queryMs,
    labCommands,
    openLabs,
    everPractised,
    courses,
    streaks,
    likes,
    reviewStats,
    topLiked,
    lowestRated,
    recentReviews,
  ] = await Promise.all([
    db.user.count(),
    db.user.count({ where: { role: "ADMIN" } }),
    db.user.count({ where: { createdAt: { gte: new Date(`${today}T00:00:00.000Z`) } } }),
    db.user.count({ where: { createdAt: { gte: daysAgo(7) } } }),
    db.user.count({ where: { createdAt: { gte: daysAgo(30) } } }),
    activityRows(since),
    db.$queryRaw<{ day: Date; n: bigint }[]>`SELECT date_trunc('day', "createdAt") AS day, count(*) AS n FROM users WHERE "createdAt" >= ${since} GROUP BY 1`,
    db.$queryRaw<{ day: Date; n: bigint }[]>`SELECT date_trunc('day', "createdAt") AS day, count(*) AS n FROM exercise_attempts WHERE "createdAt" >= ${since} GROUP BY 1`,
    db.exerciseAttempt.count(),
    db.exerciseAttempt.count({ where: { status: "CORRECT" } }),
    db.exerciseProgress.count({ where: { status: "COMPLETED" } }),
    db.topicProgress.count({ where: { completedAt: { not: null } } }),
    db.topicProgress.count({ where: { lessonCompletedAt: { not: null } } }),
    db.exerciseProgress.aggregate({ _sum: { xpEarned: true } }),
    db.exerciseProgress.aggregate({ _sum: { hintsUsed: true } }),
    db.exerciseProgress.count({ where: { solutionRevealed: true } }),
    db.queryHistory.count(),
    db.queryHistory.count({ where: { NOT: { error: null } } }),
    db.queryHistory.aggregate({ _avg: { durationMs: true } }),
    db.commandHistory.count(),
    db.labSession.count(),
    db.exerciseProgress.groupBy({ by: ["userId"] }),
    db.course.findMany({
      orderBy: { position: "asc" },
      select: { slug: true, title: true, modules: { select: { topics: { select: { _count: { select: { exercises: true } } } } } } },
    }),
    db.streak.findMany({ select: { current: true, longest: true } }),
    db.topicLike.count(),
    db.topicReview.aggregate({ _count: { _all: true }, _avg: { rating: true } }),
    db.topicLike.groupBy({ by: ["topicId"], _count: { _all: true }, orderBy: { _count: { topicId: "desc" } }, take: 5 }),
    db.topicReview.groupBy({ by: ["topicId"], where: { rating: { not: null } }, _avg: { rating: true }, _count: { _all: true }, orderBy: { _avg: { rating: "asc" } }, take: 5 }),
    db.topicReview.findMany({
      orderBy: { createdAt: "desc" },
      take: 8,
      select: {
        id: true,
        rating: true,
        body: true,
        createdAt: true,
        user: { select: { name: true } },
        topic: { select: { slug: true, title: true, module: { select: { course: { select: { slug: true } } } } } },
      },
    }),
  ]);

  // ---- daily series -------------------------------------------------------------------------
  const activeByDay = new Map<string, Set<string>>();
  for (const r of rows) {
    const key = dayKey(r.day);
    (activeByDay.get(key) ?? activeByDay.set(key, new Set()).get(key)!).add(r.userId);
  }
  const num = (list: { day: Date; n: bigint }[]) => new Map(list.map((r) => [dayKey(r.day), Number(r.n)]));
  const signupsByDay = num(signups);
  const attemptsDay = num(attemptsByDay);

  const activity: DayPoint[] = Array.from({ length: DAYS }, (_, i) => {
    const day = dayKey(daysAgo(DAYS - 1 - i));
    return { day, activeUsers: activeByDay.get(day)?.size ?? 0, attempts: attemptsDay.get(day) ?? 0, signups: signupsByDay.get(day) ?? 0 };
  });

  const activeWithin = (days: number) => {
    const cutoff = dayKey(daysAgo(days - 1));
    const users = new Set<string>();
    for (const [day, set] of activeByDay) if (day >= cutoff) for (const u of set) users.add(u);
    return users.size;
  };

  // ---- completion, per course and per topic --------------------------------------------------
  const [perLearnerCourse, perLearnerTopics, allTopics, topicStarted, topicCompleted] = await Promise.all([
    // One row per (learner, course): how many exercises of that course they have finished.
    db.$queryRaw<{ course: string; userId: string; completed: bigint }[]>`
      SELECT c.slug AS course, p."userId", count(*) AS completed
        FROM exercise_progress p
        JOIN exercises e ON e.id = p."exerciseId"
        JOIN topics t ON t.id = e."topicId"
        JOIN modules m ON m.id = t."moduleId"
        JOIN courses c ON c.id = m."courseId"
       WHERE p.status::text = 'COMPLETED'
       GROUP BY 1, 2`,
    db.$queryRaw<{ course: string; userId: string; completed: bigint }[]>`
      SELECT c.slug AS course, tp."userId", count(*) AS completed
        FROM topic_progress tp
        JOIN topics t ON t.id = tp."topicId"
        JOIN modules m ON m.id = t."moduleId"
        JOIN courses c ON c.id = m."courseId"
       WHERE tp."completedAt" IS NOT NULL
       GROUP BY 1, 2`,
    db.topic.findMany({
      orderBy: [{ module: { course: { position: "asc" } } }, { module: { position: "asc" } }, { position: "asc" }],
      select: {
        id: true,
        slug: true,
        title: true,
        _count: { select: { exercises: true } },
        module: { select: { slug: true, title: true, course: { select: { slug: true, title: true } } } },
      },
    }),
    db.topicProgress.groupBy({ by: ["topicId"], _count: { _all: true } }),
    db.topicProgress.groupBy({ by: ["topicId"], where: { completedAt: { not: null } }, _count: { _all: true } }),
  ]);

  const startedByTopic = new Map(topicStarted.map((t) => [t.topicId, t._count._all]));
  const completedByTopic = new Map(topicCompleted.map((t) => [t.topicId, t._count._all]));

  const topicCompletion: TopicCompletion[] = allTopics.map((t) => {
    const started = startedByTopic.get(t.id) ?? 0;
    const completed = completedByTopic.get(t.id) ?? 0;
    return {
      courseSlug: t.module.course.slug,
      courseTitle: t.module.course.title,
      moduleSlug: t.module.slug,
      moduleTitle: t.module.title,
      slug: t.slug,
      title: t.title,
      exercises: t._count.exercises,
      started,
      completed,
      rate: started ? Math.round((completed / started) * 100) : 0,
      shareOfAll: totalUsers ? Math.round((completed / totalUsers) * 100) : 0,
    };
  });

  const BUCKETS = ["under 25%", "25–50%", "50–75%", "75–99%", "finished"];
  const bucketOf = (pct: number) => (pct >= 100 ? 4 : pct >= 75 ? 3 : pct >= 50 ? 2 : pct >= 25 ? 1 : 0);

  const courseCompletion: CourseCompletion[] = courses.map((c) => {
    const exercises = c.modules.reduce((n, m) => n + m.topics.reduce((t, x) => t + x._count.exercises, 0), 0);
    const topicsInCourse = topicCompletion.filter((t) => t.courseSlug === c.slug).length;
    const learners = perLearnerCourse.filter((r) => r.course === c.slug);
    const topicRows = perLearnerTopics.filter((r) => r.course === c.slug);
    const pcts = learners.map((r) => (exercises ? (Number(r.completed) / exercises) * 100 : 0));
    const topicPcts = topicRows.map((r) => (topicsInCourse ? (Number(r.completed) / topicsInCourse) * 100 : 0));
    const mean = (list: number[]) => (list.length ? Math.round((list.reduce((a, b) => a + b, 0) / list.length) * 10) / 10 : 0);

    return {
      slug: c.slug,
      title: c.title,
      exercises,
      topics: topicsInCourse,
      learners: learners.length,
      exercisesCompleted: learners.reduce((n, r) => n + Number(r.completed), 0),
      topicsCompleted: topicRows.reduce((n, r) => n + Number(r.completed), 0),
      avgExercisePct: mean(pcts),
      avgTopicPct: mean(topicPcts),
      finished: pcts.filter((p) => p >= 100).length,
      buckets: BUCKETS.map((label, i) => ({ label, count: pcts.filter((p) => bucketOf(p) === i).length })),
    };
  });

  // ---- topic titles for the feedback lists ---------------------------------------------------
  const topicIds = [...new Set([...topLiked.map((t) => t.topicId), ...lowestRated.map((t) => t.topicId)])];
  const topicMeta = new Map(
    (
      await db.topic.findMany({
        where: { id: { in: topicIds } },
        select: { id: true, slug: true, title: true, module: { select: { course: { select: { slug: true } } } } },
      })
    ).map((t) => [t.id, t]),
  );

  const practised = everPractised.length;
  const [completionsPerLearner, finishedATopic] = await Promise.all([
    db.exerciseProgress.groupBy({ by: ["userId"], where: { status: "COMPLETED" }, _count: { _all: true } }),
    db.topicProgress.groupBy({ by: ["userId"], where: { completedAt: { not: null } } }),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    learners: { total: totalUsers, admins, newToday, new7, new30 },
    active: { today: activeByDay.get(today)?.size ?? 0, last7: activeWithin(7), last30: activeWithin(30), everPractised: practised },
    activity,
    work: {
      attempts,
      correct,
      successRate: attempts ? Math.round((correct / attempts) * 100) : null,
      exercisesCompleted,
      topicsCompleted,
      lessonsRead,
      xpAwarded: xp._sum.xpEarned ?? 0,
      hintsUsed: hints._sum.hintsUsed ?? 0,
      solutionsRevealed: revealed,
    },
    practice: {
      queries,
      queryErrors,
      labCommands,
      openLabs,
      avgQueryMs: queryMs._avg.durationMs ? Math.round(queryMs._avg.durationMs) : 0,
    },
    courses: courseCompletion,
    topicCompletion,
    funnel: [
      { label: "Registered", count: totalUsers },
      { label: "Started practising", count: practised },
      { label: "Solved an exercise", count: completionsPerLearner.length },
      { label: "Solved 10 or more", count: completionsPerLearner.filter((r) => r._count._all >= 10).length },
      { label: "Finished a topic", count: finishedATopic.length },
    ],
    streaks: {
      active: streaks.filter((s) => s.current > 0).length,
      atLeast3: streaks.filter((s) => s.current >= 3).length,
      atLeast7: streaks.filter((s) => s.current >= 7).length,
      longest: streaks.reduce((n, s) => Math.max(n, s.longest), 0),
    },
    feedback: {
      likes,
      reviews: reviewStats._count._all,
      averageRating: reviewStats._avg.rating ? Math.round(reviewStats._avg.rating * 10) / 10 : null,
      topLiked: topLiked.map((t) => {
        const meta = topicMeta.get(t.topicId);
        return { slug: meta?.slug ?? "", courseSlug: meta?.module.course.slug ?? "", title: meta?.title ?? "(deleted)", likes: t._count._all };
      }),
      lowestRated: lowestRated.map((t) => {
        const meta = topicMeta.get(t.topicId);
        return {
          slug: meta?.slug ?? "",
          courseSlug: meta?.module.course.slug ?? "",
          title: meta?.title ?? "(deleted)",
          rating: Math.round((t._avg.rating ?? 0) * 10) / 10,
          reviews: t._count._all,
        };
      }),
      recent: recentReviews.map((r) => ({
        id: r.id,
        author: r.user.name,
        topic: r.topic.title,
        courseSlug: r.topic.module.course.slug,
        topicSlug: r.topic.slug,
        rating: r.rating,
        body: r.body,
        createdAt: r.createdAt.toISOString(),
      })),
    },
  };
}
