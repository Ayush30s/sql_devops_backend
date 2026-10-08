import { z } from "zod";
import { body, route, sameOrigin } from "../../../lib/api.ts";
import { requireUser } from "../../../lib/auth.ts";
import { db } from "../../../lib/db.ts";

const schema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  bio: z.string().max(500).optional(),
  timezone: z.string().max(60).optional(),
  theme: z.enum(["SYSTEM", "LIGHT", "DARK"]).optional(),
  editorFontSize: z.number().int().min(11).max(24).optional(),
  focusMode: z.boolean().optional(),
  onLeaderboard: z.boolean().optional(),
});

export async function GET() {
  return route(async () => {
    const user = await requireUser();
    const profile = await db.profile.upsert({ where: { userId: user.id }, create: { userId: user.id }, update: {} });
    return { user, profile };
  });
}

export async function PATCH(req: Request) {
  return route(async () => {
    sameOrigin(req);
    const user = await requireUser();
    const { name, ...rest } = await body(req, schema);
    if (name) await db.user.update({ where: { id: user.id }, data: { name } });
    const profile = await db.profile.upsert({ where: { userId: user.id }, create: { userId: user.id, ...rest }, update: rest });
    return { ok: true, profile, name: name ?? user.name };
  });
}
