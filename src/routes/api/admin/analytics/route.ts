import { route } from "../../../../lib/api.ts";
import { analytics } from "../../../../lib/analytics.ts";
import { requireAdmin } from "../../../../lib/auth.ts";

/** Platform analytics: who is using the app, how much, and how it's going. */
export async function GET() {
  return route(async () => {
    await requireAdmin();
    return analytics();
  });
}
