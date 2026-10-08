import { rateLimit, route, sameOrigin } from "../../../lib/api.ts";
import { requireUser } from "../../../lib/auth.ts";
import { heartbeat, liveCount } from "../../../lib/presence.ts";

/** Heartbeat from an open tab; answers with how many learners are here right now. */
export async function POST(req: Request) {
  return route(async () => {
    sameOrigin(req);
    const user = await requireUser();
    rateLimit(`presence:${user.id}`, 30, 60_000);
    return { live: heartbeat(user.id) };
  });
}

/** Read-only, for anything that just wants the number. */
export async function GET() {
  return route(async () => {
    await requireUser();
    return { live: liveCount() };
  });
}
