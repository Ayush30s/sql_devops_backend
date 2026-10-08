import { z } from "zod";
import { body, route, sameOrigin } from "../../../../lib/api.ts";
import { requireUser } from "../../../../lib/auth.ts";
import { saveLabFile } from "../../../../lib/linux/lab.ts";

const schema = z.object({
  path: z.string().min(1).max(4096),
  content: z.string().max(256_000),
  sudo: z.boolean().optional(),
  exercise: z.string().max(120).optional(),
});

/** Saves the editor panel's buffer into the simulated machine (what `nano` would do). */
export async function POST(req: Request) {
  return route(async () => {
    sameOrigin(req);
    const user = await requireUser();
    const { path, content, sudo, exercise } = await body(req, schema);
    const error = await saveLabFile(user.id, exercise ? "EXERCISE" : "PLAYGROUND", path, content, sudo ?? false);
    return { ok: !error, error: error ?? null };
  });
}
