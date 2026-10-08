import { route } from "../../../../lib/api.ts";
import { currentUser } from "../../../../lib/auth.ts";

export async function GET() {
  return route(async () => ({ user: await currentUser() }));
}
