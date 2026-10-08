import { z } from "zod";
import { body, route, sameOrigin } from "../../../../lib/api.ts";
import { HttpError, requireAdmin } from "../../../../lib/auth.ts";
import { db } from "../../../../lib/db.ts";
import { describeDataset } from "../../../../lib/sql/sandbox.ts";

const input = z.object({
  slug: z.string().min(1).max(60).regex(/^[a-z0-9_]+$/, "Use lowercase letters, digits and underscores."),
  name: z.string().min(1).max(120),
  description: z.string().max(1000).default(""),
  setupSql: z.string().min(1).max(2_000_000),
});

export async function GET() {
  return route(async () => {
    await requireAdmin();
    const datasets = await db.sqlDataset.findMany({
      orderBy: { createdAt: "asc" },
      include: { tables: { orderBy: { position: "asc" } }, _count: { select: { topics: true, exercises: true } } },
    });
    return {
      datasets: datasets.map((d) => ({
        id: d.id,
        slug: d.slug,
        name: d.name,
        description: d.description,
        sqlLength: d.setupSql.length,
        tables: d.tables.map((t) => ({ name: t.name, rowCount: t.rowCount, columns: t.columns })),
        usedByTopics: d._count.topics,
        usedByExercises: d._count.exercises,
      })),
    };
  });
}

/**
 * Creates or replaces a dataset. The SQL is really executed in the sandbox first:
 * a dataset that doesn't load is rejected instead of breaking every exercise that uses it.
 */
export async function POST(req: Request) {
  return route(async () => {
    sameOrigin(req);
    await requireAdmin();
    const { slug, name, description, setupSql } = await body(req, input);
    let tables: Awaited<ReturnType<typeof describeDataset>>;
    try {
      tables = await describeDataset(setupSql);
    } catch (err) {
      throw new HttpError(400, `The dataset SQL failed to run: ${(err as Error).message}`);
    }
    if (!tables.length) throw new HttpError(400, "That SQL did not create any tables.");

    const dataset = await db.sqlDataset.upsert({
      where: { slug },
      create: { slug, name, description, setupSql },
      update: { name, description, setupSql },
    });
    await db.sqlTable.deleteMany({ where: { datasetId: dataset.id } });
    await db.sqlTable.createMany({
      data: tables.map((t, i) => ({ datasetId: dataset.id, name: t.name, columns: t.columns, rowCount: t.rowCount, position: i })),
    });
    return { id: dataset.id, slug: dataset.slug, tables: tables.length };
  });
}

export async function DELETE(req: Request) {
  return route(async () => {
    sameOrigin(req);
    await requireAdmin();
    const slug = new URL(req.url).searchParams.get("slug");
    if (!slug) throw new HttpError(400, "Which dataset?");
    const dataset = await db.sqlDataset.findUnique({ where: { slug }, include: { _count: { select: { topics: true, exercises: true } } } });
    if (!dataset) throw new HttpError(404, "That dataset does not exist.");
    if (dataset._count.topics || dataset._count.exercises)
      throw new HttpError(409, `That dataset is still used by ${dataset._count.topics} topics and ${dataset._count.exercises} exercises.`);
    await db.sqlDataset.delete({ where: { id: dataset.id } });
    return { ok: true };
  });
}
