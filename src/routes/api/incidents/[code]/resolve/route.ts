import { z } from "zod";
import { body, rateLimit, route, sameOrigin } from "../../../../../lib/api.ts";
import { requireUser } from "../../../../../lib/auth.ts";
import { resolveIncident } from "../../../../../lib/incidents/engine.ts";

const schema = z.object({ answer: z.string().min(1).max(40), prevention: z.string().max(40).optional() });

/** Closes the incident: only once the system has recovered, and only with the right root cause. */
export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  return route(async () => {
    sameOrigin(req);
    const user = await requireUser();
    const { answer, prevention } = await body(req, schema);
    rateLimit(`incident-resolve:${user.id}`, 20, 60_000);
    return resolveIncident((await params).code, user.id, answer, prevention);
  });
}
