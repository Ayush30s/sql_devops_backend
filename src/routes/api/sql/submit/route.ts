import { z } from "zod";
import { body, rateLimit, route, sameOrigin } from "../../../../lib/api.ts";
import { HttpError, requireUser } from "../../../../lib/auth.ts";
import { config } from "../../../../lib/config.ts";
import { db } from "../../../../lib/db.ts";
import { renderInline } from "../../../../lib/markdown.ts";
import { recordAttempt } from "../../../../lib/progress.ts";
import { checkSubmission } from "../../../../lib/sql/verify.ts";

const schema = z.object({
  exercise: z.string().max(120),
  sql: z.string().max(config.sql.maxSqlLength),
  timeSpentSec: z.number().int().min(0).max(86400).optional(),
});

/**
 * Verification runs the canonical solution and the learner's SQL on identical data
 * and compares the result sets. There is no string comparison anywhere.
 */
export async function POST(req: Request) {
  return route(async () => {
    sameOrigin(req);
    const user = await requireUser();
    const { exercise: slug, sql, timeSpentSec } = await body(req, schema);
    rateLimit(`submit:${user.id}`, 60, 60_000);

    const exercise = await db.exercise.findUnique({
      where: { slug },
      include: { dataset: true, topic: { include: { dataset: true } } },
    });
    if (!exercise) throw new HttpError(404, "That exercise does not exist.");
    if (exercise.kind !== "SQL") throw new HttpError(400, "That is a Linux exercise.");
    const dataset = exercise.dataset ?? exercise.topic.dataset;
    if (!dataset) throw new HttpError(500, "This exercise has no dataset.");

    const started = Date.now();
    const tables = (await db.sqlTable.findMany({ where: { datasetId: dataset.id }, select: { name: true } })).map((t) => t.name);
    const check = await checkSubmission(
      dataset.setupSql,
      { solution: exercise.solution, verification: exercise.verification ?? "UNORDERED_RESULT", checkSql: exercise.checkSql },
      sql,
      tables,
    );
    const durationMs = Date.now() - started;

    const record = await recordAttempt(user.id, exercise, { status: check.status, feedback: check.feedback, code: sql, durationMs, timeSpentSec });
    await db.queryHistory.create({
      data: {
        userId: user.id,
        datasetId: dataset.id,
        exerciseId: exercise.id,
        sql: sql.slice(0, config.sql.maxSqlLength),
        status: check.status.toLowerCase(),
        rowCount: [...check.run.results].reverse().find((r) => r.columns.length)?.rowCount ?? null,
        durationMs,
        error: check.status === "CORRECT" ? null : check.feedback.slice(0, 500),
      },
    });

    return {
      status: check.status,
      feedback: check.feedback,
      run: check.run,
      ...record,
      // The explanation and the canonical solution become visible once it's solved.
      ...(record.correct && { explanationHtml: renderInline(exercise.explanation), solution: exercise.solution }),
    };
  });
}
