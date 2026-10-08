import { route } from "../../../../../lib/api.ts";
import { requireUser } from "../../../../../lib/auth.ts";
import { runReport } from "../../../../../lib/incidents/engine.ts";

/** One finished run's post-incident report; only its owner gets it. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return route(async () => {
    const user = await requireUser();
    return runReport((await params).id, user.id);
  });
}
