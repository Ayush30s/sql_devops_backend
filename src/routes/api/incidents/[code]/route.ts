import { route } from "../../../../lib/api.ts";
import { requireUser } from "../../../../lib/auth.ts";
import { incidentView } from "../../../../lib/incidents/engine.ts";

/** One incident: the alert and briefing, the learner's run (monitoring, changes), and the solution once resolved. */
export async function GET(_req: Request, { params }: { params: Promise<{ code: string }> }) {
  return route(async () => {
    const user = await requireUser();
    return incidentView((await params).code, user.id);
  });
}
