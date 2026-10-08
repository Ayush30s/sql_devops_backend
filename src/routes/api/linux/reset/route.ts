import { z } from "zod";
import { body, route, sameOrigin } from "../../../../lib/api.ts";
import { HttpError, requireUser } from "../../../../lib/auth.ts";
import { db } from "../../../../lib/db.ts";
import { resetLab } from "../../../../lib/linux/lab.ts";

const schema = z.object({ exercise: z.string().max(120).optional() });

/** Throws the machine away and builds a fresh one (re-running the exercise setup). */
export async function POST(req: Request) {
  return route(async () => {
    sameOrigin(req);
    const user = await requireUser();
    const { exercise: slug } = await body(req, schema);
    const exercise = slug ? await db.exercise.findUnique({ where: { slug }, select: { id: true, kind: true, setupScript: true } }) : null;
    if (slug && (!exercise || exercise.kind !== "LINUX")) throw new HttpError(404, "That exercise does not exist.");
    return resetLab(user.id, exercise ? "EXERCISE" : "PLAYGROUND", exercise ?? undefined);
  });
}
