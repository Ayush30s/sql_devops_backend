import { z } from "zod";
import { body, clientIp, rateLimit, route, sameOrigin } from "../../../../lib/api.ts";
import { context } from "../../../../http.ts";
import { SESSION_COOKIE, cookieOptions, createSession, HttpError, verifyPassword } from "../../../../lib/auth.ts";
import { db } from "../../../../lib/db.ts";

const schema = z.object({ email: z.string().trim().toLowerCase().max(200), password: z.string().max(200) });

export async function POST(req: Request) {
  return route(async () => {
    sameOrigin(req);
    const { email, password } = await body(req, schema);
    // Per-account is the brute-force defence; the per-IP ceiling is loose enough for a
    // classroom behind one address but still bounds a spray across many accounts.
    // The per-account limit is the brute-force defence. The per-IP one only bounds a spray
    // across many accounts, so it stays loose: a school or office shares one address.
    rateLimit(`login-ip:${clientIp(req)}`, 200, 15 * 60_000);
    rateLimit(`login:${email}`, 10, 15 * 60_000);

    const user = await db.user.findUnique({ where: { email } });
    // Same message either way, so the response doesn't reveal which emails exist.
    if (!user || !(await verifyPassword(password, user.passwordHash))) throw new HttpError(401, "Incorrect email or password.");

    const { token, expiresAt } = await createSession(user.id, req.headers.get("user-agent"));
    context().cookies.set(SESSION_COOKIE, token, cookieOptions(expiresAt));
    return { user: { id: user.id, email: user.email, name: user.name, role: user.role } };
  });
}
