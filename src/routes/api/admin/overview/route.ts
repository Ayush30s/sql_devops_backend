import { route } from "../../../../lib/api.ts";
import { requireAdmin } from "../../../../lib/auth.ts";
import { db } from "../../../../lib/db.ts";

/** The counts on the admin home page. */
export async function GET() {
  return route(async () => {
    await requireAdmin();
    const [users, topics, exercises, datasets, attempts, labs, likes, reviews] = await Promise.all([
      db.user.count(),
      db.topic.count(),
      db.exercise.count(),
      db.sqlDataset.count(),
      db.exerciseAttempt.count(),
      db.labSession.count(),
      db.topicLike.count(),
      db.topicReview.count(),
    ]);
    return { users, topics, exercises, datasets, attempts, labs, likes, reviews };
  });
}
