import { z } from "zod";
import { body, rateLimit, route, sameOrigin } from "../../../../../../lib/api.ts";
import { requireUser } from "../../../../../../lib/auth.ts";
import { config } from "../../../../../../lib/config.ts";
import { incidentCommand } from "../../../../../../lib/incidents/engine.ts";
import { LabTimeoutError } from "../../../../../../lib/linux/pool.ts";

const schema = z.object({
  command: z.string().max(config.lab.maxCommandLength, `Maximum ${config.lab.maxCommandLength} characters.`),
  // a production action (restart, rm, chmod…) runs only once the learner has confirmed it
  confirmed: z.boolean().optional(),
});

/** One command on the incident's simulated server (a worker-thread sandbox: nothing touches the host). */
export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  return route(async () => {
    sameOrigin(req);
    const user = await requireUser();
    const { command, confirmed } = await body(req, schema);
    rateLimit(`lab:${user.id}`, 120, 60_000);
    try {
      return await incidentCommand((await params).code, user.id, command, confirmed);
    } catch (err) {
      if (err instanceof LabTimeoutError)
        return { stdout: "", stderr: `Command stopped: it ran longer than ${config.lab.commandTimeoutMs / 1000}s.\n`, exitCode: 124, timedOut: true };
      throw err;
    }
  });
}
