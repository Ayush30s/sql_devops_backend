import { route } from "../../../lib/api.ts";
import { currentUser } from "../../../lib/auth.ts";
import { overview } from "../../../lib/content.ts";

/** Both courses, their modules and topics, with this learner's progress folded in. */
export async function GET() {
  return route(async () => {
    const user = await currentUser();
    return overview(user?.id ?? null);
  });
}
