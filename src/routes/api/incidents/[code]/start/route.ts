import { rateLimit, route, sameOrigin } from "../../../../../lib/api.ts";
import { requireUser } from "../../../../../lib/auth.ts";
import { startIncident } from "../../../../../lib/incidents/engine.ts";

/** Starts the incident, or starts it over: a fresh server and the database as it was when the alert fired. */
export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  return route(async () => {
    sameOrigin(req);
    const user = await requireUser();
    rateLimit(`incident-start:${user.id}`, 10, 60_000);
    return startIncident((await params).code, user.id);
  });
}
