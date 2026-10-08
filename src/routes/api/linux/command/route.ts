import { z } from "zod";
import { body, rateLimit, route, sameOrigin } from "../../../../lib/api.ts";
import { HttpError, requireUser } from "../../../../lib/auth.ts";
import { config } from "../../../../lib/config.ts";
import { db } from "../../../../lib/db.ts";
import { LabTimeoutError } from "../../../../lib/linux/pool.ts";
import { openLab, runCommand } from "../../../../lib/linux/lab.ts";

const schema = z.object({
  command: z.string().max(config.lab.maxCommandLength, `Maximum ${config.lab.maxCommandLength} characters.`),
  exercise: z.string().max(120).optional(),
});

/**
 * Runs one command inside the learner's simulated machine. The simulation runs in a
 * worker thread that is killed on timeout; nothing touches the host.
 */
export async function POST(req: Request) {
  return route(async () => {
    sameOrigin(req);
    const user = await requireUser();
    const { command, exercise: slug } = await body(req, schema);
    rateLimit(`lab:${user.id}`, 120, 60_000);
    const kind = slug ? "EXERCISE" : "PLAYGROUND";
    if (slug) {
      const exercise = await db.exercise.findUnique({ where: { slug }, select: { id: true, kind: true, setupScript: true } });
      if (!exercise || exercise.kind !== "LINUX") throw new HttpError(404, "That exercise does not exist.");
      await openLab(user.id, "EXERCISE", exercise);
    } else await openLab(user.id, "PLAYGROUND");

    try {
      return await runCommand(user.id, kind, command);
    } catch (err) {
      if (err instanceof LabTimeoutError)
        return {
          stdout: "",
          stderr: `Command stopped: it ran longer than ${config.lab.commandTimeoutMs / 1000}s.\n`,
          exitCode: 124,
          timedOut: true,
        };
      throw err;
    }
  });
}
