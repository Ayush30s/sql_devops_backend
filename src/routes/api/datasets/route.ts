import { route } from "../../../lib/api.ts";
import { requireUser } from "../../../lib/auth.ts";
import { allDatasetSchemas } from "../../../lib/schema.ts";

/** Every dataset with its tables and columns, for the playground's picker and schema browser. */
export async function GET() {
  return route(async () => {
    await requireUser();
    return { datasets: await allDatasetSchemas() };
  });
}
