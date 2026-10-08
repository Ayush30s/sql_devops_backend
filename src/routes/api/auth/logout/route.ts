import { route, sameOrigin } from "../../../../lib/api.ts";
import { context } from "../../../../http.ts";
import { SESSION_COOKIE, currentUser, destroySession } from "../../../../lib/auth.ts";
import { forget } from "../../../../lib/presence.ts";

export async function POST(req: Request) {
  return route(async () => {
    sameOrigin(req);
    // Sign out should drop you from the live count straight away, not two minutes later.
    const user = await currentUser();
    if (user) forget(user.id);
    const jar = context().cookies;
    const token = jar.get(SESSION_COOKIE);
    if (token) await destroySession(token);
    jar.delete(SESSION_COOKIE);
    return { ok: true };
  });
}
