import { route, sameOrigin } from "../../../../../../lib/api.ts";
import { requireUser } from "../../../../../../lib/auth.ts";
import { openIncidentTerminal } from "../../../../../../lib/incidents/engine.ts";

/** Opens the incident server's terminal, with the commands already run in this investigation. */
export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  return route(async () => {
    sameOrigin(req);
    const user = await requireUser();
    return openIncidentTerminal((await params).code, user.id);
  });
}
