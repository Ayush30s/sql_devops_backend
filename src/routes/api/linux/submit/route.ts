import { z } from "zod";
import { body, rateLimit, route, sameOrigin } from "../../../../lib/api.ts";
import { HttpError, requireUser } from "../../../../lib/auth.ts";
import { db } from "../../../../lib/db.ts";
import type { LinuxCheck } from "../../../../lib/linux/checks.ts";
import { openLab, verifyLab } from "../../../../lib/linux/lab.ts";
import { renderInline } from "../../../../lib/markdown.ts";
import { recordAttempt } from "../../../../lib/progress.ts";

const schema = z.object({ exercise: z.string().max(120), timeSpentSec: z.number().int().min(0).max(86400).optional() });

/**
 * Verifies a Linux exercise by inspecting the machine's state (files, permissions,
 * owners, processes, services, env) and the output of the commands the learner ran.
 */
export async function POST(req: Request) {
  return route(async () => {
    sameOrigin(req);
    const user = await requireUser();
    const { exercise: slug, timeSpentSec } = await body(req, schema);
    rateLimit(`submit:${user.id}`, 60, 60_000);

    const exercise = await db.exercise.findUnique({ where: { slug } });
    if (!exercise) throw new HttpError(404, "That exercise does not exist.");
    if (exercise.kind !== "LINUX") throw new HttpError(400, "That is a SQL exercise.");
    const checks = (exercise.checks ?? []) as unknown as LinuxCheck[];

    await openLab(user.id, "EXERCISE", exercise);
    const started = Date.now();
    const results = await verifyLab(user.id, exercise.id, checks);
    if (!results) throw new HttpError(409, "Open this exercise's terminal first.");
    const passed = results.filter((r) => r.pass).length;
    const correct = passed === results.length && results.length > 0;
    const feedback = correct
      ? "All checks passed."
      : `${passed} of ${results.length} checks passed.\n${results.filter((r) => !r.pass).map((r) => `• ${r.label}: ${r.message ?? "not done yet"}`).join("\n")}`;

    const commands = await db.commandHistory.findMany({
      where: { userId: user.id, labSession: { kind: "EXERCISE" }, exerciseId: exercise.id },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { command: true },
    });
    const record = await recordAttempt(user.id, exercise, {
      status: correct ? "CORRECT" : "INCORRECT",
      feedback,
      code: commands.map((c) => c.command).reverse().join("\n"),
      durationMs: Date.now() - started,
      timeSpentSec,
    });

    return {
      status: correct ? "CORRECT" : "INCORRECT",
      checks: results,
      feedback,
      ...record,
      ...(record.correct && { explanationHtml: renderInline(exercise.explanation), solution: exercise.solution }),
    };
  });
}
