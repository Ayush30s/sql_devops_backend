import { rateLimit, route, sameOrigin } from "../../../../../lib/api.ts";
import { requireUser } from "../../../../../lib/auth.ts";
import { incidentHint } from "../../../../../lib/incidents/engine.ts";

/** Shows the next hint (concept, then direction, then the command); each one costs 5 points. */
export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  return route(async () => {
    sameOrigin(req);
    const user = await requireUser();
    rateLimit(`incident-hint:${user.id}`, 20, 60_000);
    return incidentHint((await params).code, user.id);
  });
}
