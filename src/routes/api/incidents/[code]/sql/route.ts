import { z } from "zod";
import { body, rateLimit, route, sameOrigin } from "../../../../../lib/api.ts";
import { requireUser } from "../../../../../lib/auth.ts";
import { config } from "../../../../../lib/config.ts";
import { incidentQuery } from "../../../../../lib/incidents/engine.ts";

const schema = z.object({
  sql: z.string().max(config.sql.maxSqlLength, `Maximum ${config.sql.maxSqlLength} characters.`),
  // DROP, TRUNCATE or an UPDATE / DELETE without WHERE runs only once confirmed
  confirmed: z.boolean().optional(),
});

/** SQL against the incident's production database (the sandbox: a throwaway schema, a restricted role). */
export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  return route(async () => {
    sameOrigin(req);
    const user = await requireUser();
    const { sql, confirmed } = await body(req, schema);
    rateLimit(`sql:${user.id}`, 60, 60_000);
    return incidentQuery((await params).code, user.id, sql, confirmed);
  });
}
