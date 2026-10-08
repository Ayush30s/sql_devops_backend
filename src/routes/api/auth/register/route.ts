import { z } from "zod";
import { body, clientIp, rateLimit, route, sameOrigin } from "../../../../lib/api.ts";
import { context } from "../../../../http.ts";
import { SESSION_COOKIE, cookieOptions, createSession, hashPassword, HttpError } from "../../../../lib/auth.ts";
import { db } from "../../../../lib/db.ts";
import { refreshAchievements } from "../../../../lib/progress.ts";

const schema = z.object({
  name: z.string().trim().min(1, "Please enter your name.").max(80),
  email: z.string().trim().toLowerCase().email("Please enter a valid email address.").max(200),
  password: z.string().min(8, "Use at least 8 characters.").max(200),
});

export async function POST(req: Request) {
  return route(async () => {
    sameOrigin(req);
    // Generous enough for a classroom behind one NAT, tight enough to stop bulk signups.
    rateLimit(`register:${clientIp(req)}`, 30, 60 * 60_000);
    const { name, email, password } = await body(req, schema);
    if (await db.user.findUnique({ where: { email }, select: { id: true } }))
      throw new HttpError(409, "An account with that email already exists.");

    const user = await db.user.create({
      data: { email, name, passwordHash: await hashPassword(password), profile: { create: {} }, streak: { create: {} } },
    });
    await refreshAchievements(user.id);
    const { token, expiresAt } = await createSession(user.id, req.headers.get("user-agent"));
    context().cookies.set(SESSION_COOKIE, token, cookieOptions(expiresAt));
    return { user: { id: user.id, email: user.email, name: user.name, role: user.role } };
  });
}
