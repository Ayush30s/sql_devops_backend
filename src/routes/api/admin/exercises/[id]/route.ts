import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { body, route, sameOrigin } from "../../../../../lib/api.ts";
import { datasetIdOf } from "../../../../../lib/admin.ts";
import { HttpError, requireAdmin } from "../../../../../lib/auth.ts";
import { db } from "../../../../../lib/db.ts";
import { CHECK_TYPES } from "../../../../../lib/linux/checks.ts";

const checkSchema = z.object({ label: z.string().min(1).max(200), type: z.enum(CHECK_TYPES) }).loose();

const patch = z.object({
  title: z.string().min(1).max(160).optional(),
  story: z.string().max(1000).optional(),
  prompt: z.string().min(1).max(4000).optional(),
  difficulty: z.enum(["BEGINNER", "INTERMEDIATE", "ADVANCED"]).optional(),
  xp: z.number().int().min(0).max(500).optional(),
  isChallenge: z.boolean().optional(),
  hints: z.array(z.string().max(1000)).max(10).optional(),
  explanation: z.string().max(4000).optional(),
  starterCode: z.string().max(10_000).optional(),
  solution: z.string().min(1).max(20_000).optional(),
  position: z.number().int().min(0).max(999).optional(),
  topicId: z.string().uuid().optional(),
  datasetSlug: z.string().max(60).nullish(),
  verification: z.enum(["EXACT_RESULT", "UNORDERED_RESULT", "ORDERED_RESULT", "ROW_COUNT", "SCHEMA", "CUSTOM"]).nullish(),
  checkSql: z.string().max(20_000).nullish(),
  setupScript: z.string().max(20_000).nullish(),
  checks: z.array(checkSchema).max(30).nullish(),
});

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return route(async () => {
    await requireAdmin();
    const exercise = await db.exercise.findUnique({
      where: { id: (await params).id },
      include: {
        dataset: { select: { slug: true } },
        topic: { select: { id: true, slug: true, title: true, module: { select: { slug: true, course: { select: { slug: true } } } } } },
      },
    });
    if (!exercise) throw new HttpError(404, "That exercise does not exist.");
    const stats = await db.exerciseProgress.aggregate({
      where: { exerciseId: exercise.id },
      _count: { _all: true },
      _sum: { attempts: true, correctAttempts: true, hintsUsed: true },
      _avg: { attempts: true, timeSpentSec: true },
    });
    const completed = await db.exerciseProgress.count({ where: { exerciseId: exercise.id, status: "COMPLETED" } });
    return {
      ...exercise,
      datasetSlug: exercise.dataset?.slug ?? null,
      stats: {
        learners: stats._count._all,
        completed,
        attempts: stats._sum.attempts ?? 0,
        correct: stats._sum.correctAttempts ?? 0,
        hintsUsed: stats._sum.hintsUsed ?? 0,
        avgAttempts: stats._avg.attempts ? Number(stats._avg.attempts.toFixed(2)) : 0,
        avgTimeSec: stats._avg.timeSpentSec ? Math.round(stats._avg.timeSpentSec) : 0,
      },
    };
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return route(async () => {
    sameOrigin(req);
    await requireAdmin();
    const id = (await params).id;
    const existing = await db.exercise.findUnique({ where: { id }, select: { id: true, kind: true } });
    if (!existing) throw new HttpError(404, "That exercise does not exist.");
    const { datasetSlug, checks, topicId, ...rest } = await body(req, patch);
    if (topicId && !(await db.topic.findUnique({ where: { id: topicId }, select: { id: true } }))) throw new HttpError(404, "That topic does not exist.");
    if (existing.kind === "LINUX" && checks !== undefined && !checks?.length) throw new HttpError(400, "A Linux exercise needs at least one check.");
    const data: Prisma.ExerciseUncheckedUpdateInput = {
      ...rest,
      ...(topicId && { topicId }),
      ...(datasetSlug !== undefined && { datasetId: await datasetIdOf(datasetSlug) }),
      ...(checks !== undefined && { checks: (checks as Prisma.InputJsonValue | undefined) ?? undefined }),
    };
    await db.exercise.update({ where: { id }, data });
    return { ok: true };
  });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return route(async () => {
    sameOrigin(req);
    await requireAdmin();
    const id = (await params).id;
    if (!(await db.exercise.findUnique({ where: { id }, select: { id: true } }))) throw new HttpError(404, "That exercise does not exist.");
    await db.exercise.delete({ where: { id } });
    return { ok: true };
  });
}
