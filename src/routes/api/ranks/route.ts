import { route } from "../../../lib/api.ts";
import { rankTiers, totalXp } from "../../../lib/ranks.ts";

/** The fighter-rank ladder, lowest tier first, and the XP the courses hold in total. Public: the same for everyone. */
export async function GET() {
  return route(async () => {
    const [tiers, total] = await Promise.all([rankTiers(), totalXp()]);
    return { tiers, totalXp: total };
  });
}
