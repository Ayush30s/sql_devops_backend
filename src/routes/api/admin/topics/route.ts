import { z } from "zod";
import { body, route, sameOrigin } from "../../../../lib/api.ts";
import { prerequisiteIds } from "../../../../lib/admin.ts";
import { HttpError, requireAdmin } from "../../../../lib/auth.ts";
import { db } from "../../../../lib/db.ts";

const create = z.object({
  moduleSlug: z.string().min(1).max(80),
  courseSlug: z.enum(["sql", "linux"]),
  slug: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/, "Use lowercase letters, digits and dashes."),
  title: z.string().min(1).max(160),
  summary: z.string().max(400).default(""),
  difficulty: z.enum(["BEGINNER", "INTERMEDIATE", "ADVANCED"]).default("BEGINNER"),
  content: z.string().max(200_000).default(""),
  datasetSlug: z.string().max(60).nullish(),
  position: z.number().int().min(0).max(999).optional(),
  prerequisites: z.array(z.string().max(80)).max(10).optional(),
});

export async function GET(req: Request) {
  return route(async () => {
    await requireAdmin();
    const course = new URL(req.url).searchParams.get("course");
    const topics = await db.topic.findMany({
      where: course ? { module: { course: { slug: course } } } : {},
      orderBy: [{ module: { course: { position: "asc" } } }, { module: { position: "asc" } }, { position: "asc" }],
      include: {
        dataset: { select: { slug: true } },
        prerequisites: { select: { slug: true } },
        module: { select: { slug: true, title: true, course: { select: { slug: true } } } },
        _count: { select: { exercises: true } },
      },
    });
    return {
      topics: topics.map((t) => ({
        id: t.id,
        slug: t.slug,
        title: t.title,
        summary: t.summary,
        difficulty: t.difficulty,
        position: t.position,
        courseSlug: t.module.course.slug,
        moduleSlug: t.module.slug,
        moduleTitle: t.module.title,
        datasetSlug: t.dataset?.slug ?? null,
        prerequisites: t.prerequisites.map((p) => p.slug),
        exercises: t._count.exercises,
        contentLength: t.content.length,
      })),
    };
  });
}

export async function POST(req: Request) {
  return route(async () => {
    sameOrigin(req);
    await requireAdmin();
    const input = await body(req, create);
    const module = await db.module.findFirst({ where: { slug: input.moduleSlug, course: { slug: input.courseSlug } }, select: { id: true } });
    if (!module) throw new HttpError(404, "That module does not exist.");
    const dataset = input.datasetSlug ? await db.sqlDataset.findUnique({ where: { slug: input.datasetSlug }, select: { id: true } }) : null;
    if (input.datasetSlug && !dataset) throw new HttpError(404, "That dataset does not exist.");
    if (await db.topic.findFirst({ where: { moduleId: module.id, slug: input.slug }, select: { id: true } }))
      throw new HttpError(409, "A topic with that slug already exists in this module.");

    const topic = await db.topic.create({
      data: {
        moduleId: module.id,
        slug: input.slug,
        title: input.title,
        summary: input.summary,
        difficulty: input.difficulty,
        content: input.content,
        datasetId: dataset?.id ?? null,
        position: input.position ?? (await db.topic.count({ where: { moduleId: module.id } })),
        ...(input.prerequisites?.length && { prerequisites: { connect: await prerequisiteIds(input.prerequisites, input.courseSlug) } }),
      },
    });
    return { id: topic.id, slug: topic.slug };
  });
}
