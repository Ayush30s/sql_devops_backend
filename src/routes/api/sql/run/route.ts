import { z } from "zod";
import { body, rateLimit, route, sameOrigin } from "../../../../lib/api.ts";
import { HttpError, requireUser } from "../../../../lib/auth.ts";
import { config } from "../../../../lib/config.ts";
import { db } from "../../../../lib/db.ts";
import { runQuery } from "../../../../lib/sql/sandbox.ts";

const schema = z.object({
  sql: z.string().max(config.sql.maxSqlLength, `Maximum ${config.sql.maxSqlLength} characters.`),
  dataset: z.string().max(60).optional(),
  exercise: z.string().max(120).optional(),
});

/** Runs learner SQL in a throwaway schema of the sandbox cluster. Nothing is ever committed. */
export async function POST(req: Request) {
  return route(async () => {
    sameOrigin(req);
    const user = await requireUser();
    const { sql, dataset, exercise } = await body(req, schema);
    rateLimit(`sql:${user.id}`, 60, 60_000);

    // An exercise runs on its own dataset, else its topic's, exactly as submit checks it; the playground
    // picks one by slug. (One OR query matched both and returned either, so Run and Submit could disagree.)
    const row = exercise
      ? await db.exercise
          .findUnique({ where: { slug: exercise }, select: { dataset: true, topic: { select: { dataset: true } } } })
          .then((e) => e && (e.dataset ?? e.topic.dataset))
      : await db.sqlDataset.findFirst({ where: dataset ? { slug: dataset } : {}, orderBy: { createdAt: "asc" } });
    if (!row) throw new HttpError(404, "That dataset does not exist.");

    const started = Date.now();
    const tables = (await db.sqlTable.findMany({ where: { datasetId: row.id }, select: { name: true } })).map((t) => t.name);
    const result = await runQuery(row.setupSql, sql, tables);
    const durationMs = Date.now() - started;
    const last = [...result.results].reverse().find((r) => r.columns.length);

    await db.queryHistory.create({
      data: {
        userId: user.id,
        datasetId: row.id,
        sql: sql.slice(0, config.sql.maxSqlLength),
        status: result.status,
        rowCount: last?.rowCount ?? null,
        durationMs,
        error: result.message?.slice(0, 500) ?? null,
      },
    });
    return { ...result, durationMs, dataset: row.slug };
  });
}
