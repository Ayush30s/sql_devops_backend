import { route } from "../../../../lib/api.ts";
import { requireUser } from "../../../../lib/auth.ts";
import { incidentHistory } from "../../../../lib/incidents/engine.ts";

/** The learner's finished incidents, newest first, with their scores. */
export async function GET() {
  return route(async () => {
    const user = await requireUser();
    return { runs: await incidentHistory(user.id) };
  });
}
