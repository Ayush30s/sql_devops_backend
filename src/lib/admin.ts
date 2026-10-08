import { HttpError } from "./auth.ts";
import { db } from "./db.ts";

/** Resolves prerequisite topic slugs within one course, failing loudly on typos. */
export async function prerequisiteIds(slugs: string[], courseSlug: string) {
  const rows = await db.topic.findMany({ where: { slug: { in: slugs }, module: { course: { slug: courseSlug } } }, select: { id: true, slug: true } });
  const missing = slugs.filter((s) => !rows.some((r) => r.slug === s));
  if (missing.length) throw new HttpError(404, `Unknown prerequisite topics: ${missing.join(", ")}`);
  return rows.map((r) => ({ id: r.id }));
}

export async function datasetIdOf(slug: string | null | undefined) {
  if (!slug) return null;
  const row = await db.sqlDataset.findUnique({ where: { slug }, select: { id: true } });
  if (!row) throw new HttpError(404, "That dataset does not exist.");
  return row.id;
}
