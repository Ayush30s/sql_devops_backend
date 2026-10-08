import { route } from "../../../lib/api.ts";
import { requireUser } from "../../../lib/auth.ts";
import { leaderboard, SORTS, type Sort } from "../../../lib/leaderboard.ts";

/** Standings by XP, exercises solved or current streak. Learners who opted out are not listed. */
export async function GET(req: Request) {
  return route(async () => {
    const user = await requireUser();
    const asked = new URL(req.url).searchParams.get("sort");
    const sort: Sort = SORTS.includes(asked as Sort) ? (asked as Sort) : "xp";
    return leaderboard(sort, user.id);
  });
}
