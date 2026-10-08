import { z } from "zod";
import { body, route, sameOrigin } from "../../../../lib/api.ts";
import { HttpError, requireUser } from "../../../../lib/auth.ts";
import { db } from "../../../../lib/db.ts";
import { openLab } from "../../../../lib/linux/lab.ts";

const schema = z.object({ exercise: z.string().max(120).optional() });

/** Opens (creating if needed) the learner's playground machine, or an exercise's machine. */
export async function POST(req: Request) {
  return route(async () => {
    sameOrigin(req);
    const user = await requireUser();
    const { exercise: slug } = await body(req, schema);
    const exercise = slug ? await db.exercise.findUnique({ where: { slug }, select: { id: true, kind: true, setupScript: true } }) : null;
    if (slug && !exercise) throw new HttpError(404, "That exercise does not exist.");
    if (exercise && exercise.kind !== "LINUX") throw new HttpError(400, "That is a SQL exercise.");

    const lab = await openLab(user.id, exercise ? "EXERCISE" : "PLAYGROUND", exercise ?? undefined);
    const history = await db.commandHistory.findMany({
      where: { userId: user.id, labSession: { kind: exercise ? "EXERCISE" : "PLAYGROUND" } },
      orderBy: { createdAt: "asc" },
      take: 200,
      select: { command: true, output: true, exitCode: true },
    });
    return { ...lab, history };
  });
}
