import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { body, route, sameOrigin } from "../../../../lib/api.ts";
import { datasetIdOf } from "../../../../lib/admin.ts";
import { HttpError, requireAdmin } from "../../../../lib/auth.ts";
import { db } from "../../../../lib/db.ts";
import { CHECK_TYPES } from "../../../../lib/linux/checks.ts";

/** Linux checks are validated loosely: the type must be known, the rest is the check's own shape. */
const checkSchema = z.object({ label: z.string().min(1).max(200), type: z.enum(CHECK_TYPES) }).loose();

const exerciseInput = z.object({
  topicId: z.string().uuid(),
  slug: z.string().min(1).max(120).regex(/^[a-z0-9-]+$/, "Use lowercase letters, digits and dashes."),
  kind: z.enum(["SQL", "LINUX"]),
  title: z.string().min(1).max(160),
  story: z.string().max(1000).default(""),
  prompt: z.string().min(1).max(4000),
  difficulty: z.enum(["BEGINNER", "INTERMEDIATE", "ADVANCED"]),
  xp: z.number().int().min(0).max(500),
  isChallenge: z.boolean().default(false),
  hints: z.array(z.string().max(1000)).max(10).default([]),
  explanation: z.string().max(4000).default(""),
  starterCode: z.string().max(10_000).default(""),
  solution: z.string().min(1).max(20_000),
  position: z.number().int().min(0).max(999).optional(),
  datasetSlug: z.string().max(60).nullish(),
  verification: z.enum(["EXACT_RESULT", "UNORDERED_RESULT", "ORDERED_RESULT", "ROW_COUNT", "SCHEMA", "CUSTOM"]).nullish(),
  checkSql: z.string().max(20_000).nullish(),
  setupScript: z.string().max(20_000).nullish(),
  checks: z.array(checkSchema).max(30).nullish(),
});

export async function GET(req: Request) {
  return route(async () => {
    await requireAdmin();
    const url = new URL(req.url);
    const topicId = url.searchParams.get("topic");
    const course = url.searchParams.get("course");
    const search = url.searchParams.get("q");
    const exercises = await db.exercise.findMany({
      where: {
        ...(topicId && { topicId }),
        ...(course && { topic: { module: { course: { slug: course } } } }),
        ...(search && { OR: [{ slug: { contains: search, mode: "insensitive" } }, { title: { contains: search, mode: "insensitive" } }] }),
      },
      orderBy: [{ topic: { module: { position: "asc" } } }, { topic: { position: "asc" } }, { position: "asc" }],
      take: 500,
      include: {
        dataset: { select: { slug: true } },
        topic: { select: { slug: true, title: true, module: { select: { slug: true, course: { select: { slug: true } } } } } },
        _count: { select: { attempts: true } },
      },
    });
    return {
      exercises: exercises.map((e) => ({
        id: e.id,
        slug: e.slug,
        title: e.title,
        kind: e.kind,
        difficulty: e.difficulty,
        xp: e.xp,
        isChallenge: e.isChallenge,
        position: e.position,
        topicId: e.topicId,
        topicSlug: e.topic.slug,
        topicTitle: e.topic.title,
        moduleSlug: e.topic.module.slug,
        courseSlug: e.topic.module.course.slug,
        datasetSlug: e.dataset?.slug ?? null,
        attempts: e._count.attempts,
      })),
    };
  });
}

export async function POST(req: Request) {
  return route(async () => {
    sameOrigin(req);
    await requireAdmin();
    const { topicId, datasetSlug, checks, ...rest } = await body(req, exerciseInput);
    const topic = await db.topic.findUnique({ where: { id: topicId }, select: { id: true } });
    if (!topic) throw new HttpError(404, "That topic does not exist.");
    if (await db.exercise.findUnique({ where: { slug: rest.slug }, select: { id: true } }))
      throw new HttpError(409, "An exercise with that slug already exists.");
    if (rest.kind === "LINUX" && !checks?.length) throw new HttpError(400, "A Linux exercise needs at least one check.");
    if (rest.kind === "SQL" && !rest.verification) rest.verification = "UNORDERED_RESULT";

    const exercise = await db.exercise.create({
      data: {
        ...rest,
        topicId,
        datasetId: await datasetIdOf(datasetSlug),
        position: rest.position ?? (await db.exercise.count({ where: { topicId } })),
        checks: (checks as Prisma.InputJsonValue | undefined) ?? undefined,
      },
    });
    return { id: exercise.id, slug: exercise.slug };
  });
}
