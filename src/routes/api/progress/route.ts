import { route } from "../../../lib/api.ts";
import { requireUser } from "../../../lib/auth.ts";
import { overview } from "../../../lib/content.ts";
import { learnerAnalytics } from "../../../lib/learner-analytics.ts";
import { leaderboard } from "../../../lib/leaderboard.ts";
import { reviewItems } from "../../../lib/progress.ts";

/** Everything the progress page shows: courses, XP, level, streak, badges, analytics, review queue. */
export async function GET() {
  return route(async () => {
    const user = await requireUser();
    const [data, review, me, board] = await Promise.all([
      overview(user.id),
      reviewItems(user.id),
      learnerAnalytics(user.id),
      // No rows needed — only where this learner stands.
      leaderboard("xp", user.id, 0),
    ]);
    return { ...data, review, me, standing: board.you ? { rank: board.you.rank, of: board.total } : null };
  });
}
