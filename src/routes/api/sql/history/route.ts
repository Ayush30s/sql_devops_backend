import { route } from "../../../../lib/api.ts";
import { requireUser } from "../../../../lib/auth.ts";
import { db } from "../../../../lib/db.ts";

/** The learner's own query history, newest first. */
export async function GET(req: Request) {
  return route(async () => {
    const user = await requireUser();
    const url = new URL(req.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50), 1), 200);
    const dataset = url.searchParams.get("dataset");
    const rows = await db.queryHistory.findMany({
      where: { userId: user.id, ...(dataset && { dataset: { slug: dataset } }) },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { id: true, sql: true, status: true, rowCount: true, durationMs: true, error: true, createdAt: true, dataset: { select: { slug: true } } },
    });
    return { history: rows.map((r) => ({ ...r, dataset: r.dataset?.slug ?? null, createdAt: r.createdAt.toISOString() })) };
  });
}

/** Clears it. */
export async function DELETE() {
  return route(async () => {
    const user = await requireUser();
    const { count } = await db.queryHistory.deleteMany({ where: { userId: user.id } });
    return { deleted: count };
  });
}
