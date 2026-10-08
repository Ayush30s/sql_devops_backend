import { z } from "zod";
import { body, route, sameOrigin } from "../../../../lib/api.ts";
import { currentUser, HttpError, requireUser } from "../../../../lib/auth.ts";
import { exerciseView } from "../../../../lib/content.ts";
import { db } from "../../../../lib/db.ts";
import { renderInline } from "../../../../lib/markdown.ts";
import { recordHint, recordReveal } from "../../../../lib/progress.ts";

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  return route(async () => {
    const user = await currentUser();
    return exerciseView((await params).slug, user?.id ?? null);
  });
}

const schema = z.object({ action: z.enum(["hint", "reveal"]), index: z.number().int().min(0).max(20).optional() });

/**
 * Asking for a hint or the solution before solving is recorded, because both reduce the XP
 * for the exercise; once it is solved they are free. The hint text is only returned here, never in the GET.
 */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  return route(async () => {
    sameOrigin(req);
    const user = await requireUser();
    const { action, index = 0 } = await body(req, schema);
    const exercise = await db.exercise.findUnique({ where: { slug: (await params).slug }, select: { id: true, hints: true, solution: true, explanation: true } });
    if (!exercise) throw new HttpError(404, "That exercise does not exist.");

    if (action === "hint") {
      if (index >= exercise.hints.length) throw new HttpError(404, "There are no more hints for this exercise.");
      await recordHint(user.id, exercise.id, index);
      return { hint: renderInline(exercise.hints[index]), index, remaining: exercise.hints.length - index - 1 };
    }
    await recordReveal(user.id, exercise.id);
    return { solution: exercise.solution, explanationHtml: renderInline(exercise.explanation) };
  });
}
