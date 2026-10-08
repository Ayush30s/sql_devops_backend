import type { CourseKind, Difficulty } from "@prisma/client";
import { HttpError } from "./auth.ts";
import { db } from "./db.ts";
import { renderInline, renderLesson, type CodeBlock } from "./markdown.ts";
import { courseProgress, levelFor, xpTotal, type CourseProgressView } from "./progress.ts";

/** Shared read model for the pages and the API. Solutions are only included when the learner revealed them. */

export interface ExerciseView {
  slug: string;
  title: string;
  kind: CourseKind;
  isChallenge: boolean;
  story: string;
  prompt: string;
  /** Prompt and story rendered from inline markdown (bold, code, links). */
  promptHtml: string;
  storyHtml: string;
  difficulty: Difficulty;
  xp: number;
  hintCount: number;
  starterCode: string;
  datasetSlug: string | null;
  /** Tables this exercise actually works with, so they can be shown before the question is read. */
  tables: string[];
  /** Earlier topics this one also drills; empty for the focused half of a topic's set. */
  mixes: { slug: string; title: string }[];
  topicSlug: string;
  topicTitle: string;
  courseSlug: string;
  position: number;
  progress: {
    status: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED";
    attempts: number;
    hintsUsed: number;
    solutionRevealed: boolean;
    xpEarned: number;
    lastCode: string | null;
  };
  /** Only present once the learner has completed it or revealed it. */
  solution?: string;
  explanation?: string;
  explanationHtml?: string;
}

export interface TopicReviewView {
  id: string;
  author: string;
  /** The signed-in learner's own review, which they can edit or delete. */
  mine: boolean;
  rating: number | null;
  body: string;
  createdAt: string;
  edited: boolean;
}

export interface TopicView {
  slug: string;
  title: string;
  summary: string;
  difficulty: Difficulty;
  content: string;
  /** The lesson rendered to HTML, with its code fences lifted out for the interactive blocks. */
  contentHtml: string;
  codeBlocks: CodeBlock[];
  courseSlug: string;
  courseTitle: string;
  courseKind: CourseKind;
  moduleSlug: string;
  moduleTitle: string;
  datasetSlug: string | null;
  prerequisites: { slug: string; title: string; completed: boolean }[];
  exercises: ExerciseView[];
  lessonRead: boolean;
  completed: boolean;
  next: { courseSlug: string; topicSlug: string; title: string } | null;
  previous: { courseSlug: string; topicSlug: string; title: string } | null;
  likes: number;
  likedByMe: boolean;
  reviews: TopicReviewView[];
  averageRating: number | null;
}

const renderedLesson = (markdown: string) => {
  const { html, blocks } = renderLesson(markdown);
  return { contentHtml: html, codeBlocks: blocks };
};

/**
 * The tables a solution touches, matched against the dataset's real table names — a word match
 * rather than a parser, which is enough to name them and can only ever be a superset of the truth.
 */
const tablesUsed = (sql: string, names: string[]) => names.filter((n) => new RegExp(`\\b${n}\\b`, "i").test(sql));

/** slug → ordered table names, for every dataset named. */
async function tableNames(datasetSlugs: (string | null)[]): Promise<Map<string, string[]>> {
  const slugs = [...new Set(datasetSlugs.filter((s) => s !== null))];
  if (!slugs.length) return new Map();
  const rows = await db.sqlTable.findMany({
    where: { dataset: { slug: { in: slugs } } },
    orderBy: { position: "asc" },
    select: { name: true, dataset: { select: { slug: true } } },
  });
  const byDataset = new Map<string, string[]>();
  for (const r of rows) byDataset.set(r.dataset.slug, [...(byDataset.get(r.dataset.slug) ?? []), r.name]);
  return byDataset;
}

const statusOf = (p?: { status: string; attempts: number } | null) =>
  !p || (p.attempts === 0 && p.status !== "COMPLETED") ? "NOT_STARTED" : (p.status as "IN_PROGRESS" | "COMPLETED");

export async function topicView(courseSlug: string, topicSlug: string, userId: string | null): Promise<TopicView> {
  const topic = await db.topic.findFirst({
    where: { slug: topicSlug, module: { course: { slug: courseSlug } } },
    include: {
      dataset: { select: { slug: true } },
      prerequisites: { select: { slug: true, title: true } },
      module: { select: { slug: true, title: true, position: true, course: { select: { slug: true, title: true, kind: true } } } },
      exercises: { orderBy: { position: "asc" }, include: { dataset: { select: { slug: true } } } },
    },
  });
  if (!topic) throw new HttpError(404, "That topic does not exist.");

  const [progress, lastAttempts, topicProgress, preProgress, order, likes, likedByMe, reviews] = await Promise.all([
    userId ? db.exerciseProgress.findMany({ where: { userId, exerciseId: { in: topic.exercises.map((e) => e.id) } } }) : [],
    userId
      ? db.exerciseAttempt.findMany({
          where: { userId, exerciseId: { in: topic.exercises.map((e) => e.id) } },
          orderBy: { createdAt: "desc" },
          distinct: ["exerciseId"],
          select: { exerciseId: true, code: true },
        })
      : [],
    userId ? db.topicProgress.findUnique({ where: { userId_topicId: { userId, topicId: topic.id } } }) : null,
    userId && topic.prerequisites.length
      ? db.topicProgress.findMany({
          where: { userId, completedAt: { not: null }, topic: { slug: { in: topic.prerequisites.map((p) => p.slug) } } },
          select: { topic: { select: { slug: true } } },
        })
      : [],
    db.topic.findMany({
      where: { module: { course: { slug: courseSlug } } },
      orderBy: [{ module: { position: "asc" } }, { position: "asc" }],
      select: { slug: true, title: true },
    }),
    db.topicLike.count({ where: { topicId: topic.id } }),
    userId ? db.topicLike.findUnique({ where: { userId_topicId: { userId, topicId: topic.id } } }) : null,
    // Your own review first, then the newest; 50 is plenty for one lesson page.
    db.topicReview.findMany({
      where: { topicId: topic.id },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { id: true, rating: true, body: true, createdAt: true, updatedAt: true, userId: true, user: { select: { name: true } } },
    }),
  ]);

  const byExercise = new Map(progress.map((p) => [p.exerciseId, p]));
  const codeByExercise = new Map(lastAttempts.map((a) => [a.exerciseId, a.code]));
  const donePre = new Set(preProgress.map((p) => p.topic.slug));
  const index = order.findIndex((t) => t.slug === topicSlug);
  const titles = new Map(order.map((t) => [t.slug, t.title]));
  const tables = await tableNames([topic.dataset?.slug ?? null, ...topic.exercises.map((e) => e.dataset?.slug ?? null)]);
  const rated = reviews.filter((r) => r.rating !== null);
  const reviewViews: TopicReviewView[] = reviews
    .map((r) => ({
      id: r.id,
      author: r.user.name,
      mine: r.userId === userId,
      rating: r.rating,
      body: r.body,
      createdAt: r.createdAt.toISOString(),
      edited: r.updatedAt.getTime() - r.createdAt.getTime() > 1000,
    }))
    .sort((a, b) => Number(b.mine) - Number(a.mine));

  return {
    slug: topic.slug,
    title: topic.title,
    summary: topic.summary,
    difficulty: topic.difficulty,
    content: topic.content,
    ...renderedLesson(topic.content),
    courseSlug: topic.module.course.slug,
    courseTitle: topic.module.course.title,
    courseKind: topic.module.course.kind,
    moduleSlug: topic.module.slug,
    moduleTitle: topic.module.title,
    datasetSlug: topic.dataset?.slug ?? null,
    prerequisites: topic.prerequisites.map((p) => ({ slug: p.slug, title: p.title, completed: donePre.has(p.slug) })),
    lessonRead: !!topicProgress?.lessonCompletedAt,
    completed: !!topicProgress?.completedAt,
    likes,
    likedByMe: !!likedByMe,
    reviews: reviewViews,
    averageRating: rated.length ? Math.round((rated.reduce((n, r) => n + (r.rating ?? 0), 0) / rated.length) * 10) / 10 : null,
    previous: index > 0 ? { courseSlug, topicSlug: order[index - 1].slug, title: order[index - 1].title } : null,
    next: index >= 0 && index < order.length - 1 ? { courseSlug, topicSlug: order[index + 1].slug, title: order[index + 1].title } : null,
    exercises: topic.exercises.map((e) => {
      const p = byExercise.get(e.id);
      const show = p?.status === "COMPLETED" || p?.solutionRevealed;
      const datasetSlug = e.dataset?.slug ?? topic.dataset?.slug ?? null;
      return {
        slug: e.slug,
        title: e.title,
        kind: e.kind,
        isChallenge: e.isChallenge,
        story: e.story,
        prompt: e.prompt,
        promptHtml: renderInline(e.prompt),
        storyHtml: renderInline(e.story),
        difficulty: e.difficulty,
        xp: e.xp,
        hintCount: e.hints.length,
        starterCode: e.starterCode,
        datasetSlug,
        tables: datasetSlug ? tablesUsed(e.solution, tables.get(datasetSlug) ?? []) : [],
        mixes: e.mixes.map((slug) => ({ slug, title: titles.get(slug) ?? slug })),
        topicSlug: topic.slug,
        topicTitle: topic.title,
        courseSlug,
        position: e.position,
        progress: {
          status: statusOf(p),
          attempts: p?.attempts ?? 0,
          hintsUsed: p?.hintsUsed ?? 0,
          solutionRevealed: p?.solutionRevealed ?? false,
          xpEarned: p?.xpEarned ?? 0,
          lastCode: codeByExercise.get(e.id) ?? null,
        },
        ...(show && { solution: e.solution, explanation: e.explanation, explanationHtml: renderInline(e.explanation) }),
      };
    }),
  };
}

/** One exercise plus whatever the learner is allowed to see of it. */
export async function exerciseView(slug: string, userId: string | null): Promise<ExerciseView> {
  const exercise = await db.exercise.findUnique({
    where: { slug },
    include: {
      dataset: { select: { slug: true } },
      topic: { include: { dataset: { select: { slug: true } }, module: { select: { slug: true, course: { select: { slug: true } } } } } },
    },
  });
  if (!exercise) throw new HttpError(404, "That exercise does not exist.");
  const datasetSlug = exercise.dataset?.slug ?? exercise.topic.dataset?.slug ?? null;
  const [p, last, tables, mixed] = await Promise.all([
    userId ? db.exerciseProgress.findUnique({ where: { userId_exerciseId: { userId, exerciseId: exercise.id } } }) : null,
    userId ? db.exerciseAttempt.findFirst({ where: { userId, exerciseId: exercise.id }, orderBy: { createdAt: "desc" }, select: { code: true } }) : null,
    tableNames([datasetSlug]),
    exercise.mixes.length ? db.topic.findMany({ where: { slug: { in: exercise.mixes } }, select: { slug: true, title: true } }) : [],
  ]);
  const show = p?.status === "COMPLETED" || p?.solutionRevealed;
  const titles = new Map(mixed.map((t) => [t.slug, t.title]));
  return {
    slug: exercise.slug,
    title: exercise.title,
    kind: exercise.kind,
    isChallenge: exercise.isChallenge,
    story: exercise.story,
    prompt: exercise.prompt,
    promptHtml: renderInline(exercise.prompt),
    storyHtml: renderInline(exercise.story),
    difficulty: exercise.difficulty,
    xp: exercise.xp,
    hintCount: exercise.hints.length,
    starterCode: exercise.starterCode,
    datasetSlug,
    tables: datasetSlug ? tablesUsed(exercise.solution, tables.get(datasetSlug) ?? []) : [],
    mixes: exercise.mixes.map((slug) => ({ slug, title: titles.get(slug) ?? slug })),
    topicSlug: exercise.topic.slug,
    topicTitle: exercise.topic.title,
    courseSlug: exercise.topic.module.course.slug,
    position: exercise.position,
    progress: {
      status: statusOf(p),
      attempts: p?.attempts ?? 0,
      hintsUsed: p?.hintsUsed ?? 0,
      solutionRevealed: p?.solutionRevealed ?? false,
      xpEarned: p?.xpEarned ?? 0,
      lastCode: last?.code ?? null,
    },
    ...(show && { solution: exercise.solution, explanation: exercise.explanation, explanationHtml: renderInline(exercise.explanation) }),
  };
}

export interface Overview {
  courses: CourseProgressView[];
  xp: number;
  level: number;
  xpInto: number;
  xpForNext: number;
  streak: { current: number; longest: number };
  achievements: { slug: string; title: string; description: string; earnedAt: string | null }[];
  waiting: number;
  /** How many SQL datasets the playground offers. */
  datasets: number;
}

/** Both courses with progress, plus the learner's XP, level, streak and badges. */
export async function overview(userId: string | null): Promise<Overview> {
  const slugs = (await db.course.findMany({ orderBy: { position: "asc" }, select: { slug: true } })).map((c) => c.slug);
  const courses = (await Promise.all(slugs.map((slug) => courseProgress(slug, userId)))).filter((c) => c !== null);
  const [xp, streak, badges] = userId
    ? await Promise.all([
        xpTotal(userId),
        db.streak.findUnique({ where: { userId } }),
        db.achievement.findMany({ orderBy: { position: "asc" }, include: { users: { where: { userId }, select: { earnedAt: true } } } }),
      ])
    : // signed out: every badge, none earned ("" is not a valid UUID, so it can't be used as a filter)
      [0, null, await db.achievement.findMany({ orderBy: { position: "asc" }, include: { users: { take: 0, select: { earnedAt: true } } } })];
  const level = levelFor(xp);
  return {
    courses,
    xp,
    level: level.level,
    xpInto: level.xpInto,
    xpForNext: level.xpForNext,
    streak: { current: streak?.current ?? 0, longest: streak?.longest ?? 0 },
    achievements: badges.map((b) => ({ slug: b.slug, title: b.title, description: b.description, earnedAt: b.users[0]?.earnedAt.toISOString() ?? null })),
    waiting: courses.reduce((n, c) => n + (c.totals.exercises - c.totals.exercisesCompleted), 0),
    datasets: await db.sqlDataset.count(),
  };
}
