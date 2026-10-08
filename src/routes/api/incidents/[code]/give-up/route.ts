import { route, sameOrigin } from "../../../../../lib/api.ts";
import { requireUser } from "../../../../../lib/auth.ts";
import { giveUpIncident } from "../../../../../lib/incidents/engine.ts";

/** Ends the investigation and shows what happened; giving up costs 20 points. */
export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  return route(async () => {
    sameOrigin(req);
    const user = await requireUser();
    return giveUpIncident((await params).code, user.id);
  });
}
