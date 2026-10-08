import { z } from "zod";
import { body, route, sameOrigin } from "../../../../../../lib/api.ts";
import { requireUser } from "../../../../../../lib/auth.ts";
import { incidentFile } from "../../../../../../lib/incidents/engine.ts";

const schema = z.object({ path: z.string().min(1).max(4096), content: z.string().max(256_000), sudo: z.boolean().optional() });

/** Saves the terminal editor's buffer on the incident's server (what `nano` would do). */
export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  return route(async () => {
    sameOrigin(req);
    const user = await requireUser();
    const { path, content, sudo } = await body(req, schema);
    const error = await incidentFile((await params).code, user.id, path, content, sudo ?? false);
    return { ok: !error, error: error ?? null };
  });
}
