import { z } from "zod";
import { body, route, sameOrigin } from "../../../../../lib/api.ts";
import { HttpError, requireAdmin } from "../../../../../lib/auth.ts";
import { prerequisiteIds } from "../../../../../lib/admin.ts";
import { db } from "../../../../../lib/db.ts";

const patch = z.object({
  title: z.string().min(1).max(160).optional(),
  summary: z.string().max(400).optional(),
  difficulty: z.enum(["BEGINNER", "INTERMEDIATE", "ADVANCED"]).optional(),
  content: z.string().max(200_000).optional(),
  datasetSlug: z.string().max(60).nullish(),
  position: z.number().int().min(0).max(999).optional(),
  prerequisites: z.array(z.string().max(80)).max(10).optional(),
});

const find = async (id: string) => {
  const topic = await db.topic.findUnique({ where: { id }, include: { module: { select: { course: { select: { slug: true } } } } } });
  if (!topic) throw new HttpError(404, "That topic does not exist.");
  return topic;
};

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return route(async () => {
    await requireAdmin();
    const topic = await db.topic.findUnique({
      where: { id: (await params).id },
      include: {
        dataset: { select: { slug: true } },
        prerequisites: { select: { slug: true } },
        module: { select: { slug: true, title: true, course: { select: { slug: true } } } },
        exercises: { orderBy: { position: "asc" }, select: { id: true, slug: true, title: true, difficulty: true, isChallenge: true, xp: true, position: true } },
      },
    });
    if (!topic) throw new HttpError(404, "That topic does not exist.");
    return {
      ...topic,
      datasetSlug: topic.dataset?.slug ?? null,
      prerequisites: topic.prerequisites.map((p) => p.slug),
      courseSlug: topic.module.course.slug,
    };
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return route(async () => {
    sameOrigin(req);
    await requireAdmin();
    const topic = await find((await params).id);
    const { datasetSlug, prerequisites, ...rest } = await body(req, patch);
    const dataset = datasetSlug ? await db.sqlDataset.findUnique({ where: { slug: datasetSlug }, select: { id: true } }) : null;
    if (datasetSlug && !dataset) throw new HttpError(404, "That dataset does not exist.");
    await db.topic.update({
      where: { id: topic.id },
      data: {
        ...rest,
        ...(datasetSlug !== undefined && { datasetId: dataset?.id ?? null }),
        ...(prerequisites && { prerequisites: { set: await prerequisiteIds(prerequisites, topic.module.course.slug) } }),
      },
    });
    return { ok: true };
  });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return route(async () => {
    sameOrigin(req);
    await requireAdmin();
    const topic = await find((await params).id);
    await db.topic.delete({ where: { id: topic.id } });
    return { ok: true };
  });
}
