import { route } from "../../../../lib/api.ts";
import { HttpError, requireUser } from "../../../../lib/auth.ts";
import { datasetSchema } from "../../../../lib/schema.ts";

/** One dataset's tables and columns, for the practice panel's schema browser. */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  return route(async () => {
    await requireUser();
    const schema = await datasetSchema((await params).slug);
    if (!schema) throw new HttpError(404, "That dataset does not exist.");
    return schema;
  });
}
