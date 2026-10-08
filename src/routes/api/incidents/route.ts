import { route } from "../../../lib/api.ts";
import { requireUser } from "../../../lib/auth.ts";
import { listIncidents } from "../../../lib/incidents/engine.ts";

/** The incident queue: every scenario, easiest first, with the learner's own progress on it. */
export async function GET() {
  return route(async () => {
    const user = await requireUser();
    return { incidents: await listIncidents(user.id) };
  });
}
