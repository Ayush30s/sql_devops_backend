import { route } from "../../../../lib/api.ts";
import { requireAdmin } from "../../../../lib/auth.ts";
import { db } from "../../../../lib/db.ts";

/** Exercise statistics: where learners get stuck, and how the platform is being used. */
export async function GET(req: Request) {
  return route(async () => {
    await requireAdmin();
    const course = new URL(req.url).searchParams.get("course");
    const where = course ? { exercise: { topic: { module: { course: { slug: course } } } } } : {};

    const [users, exercises, attempts, correct, grouped, labs] = await Promise.all([
      db.user.count(),
      db.exercise.count(course ? { where: { topic: { module: { course: { slug: course } } } } } : undefined),
      db.exerciseAttempt.count({ where }),
      db.exerciseAttempt.count({ where: { ...where, status: "CORRECT" } }),
      db.exerciseProgress.groupBy({
        by: ["exerciseId"],
        where,
        _sum: { attempts: true, correctAttempts: true, hintsUsed: true },
        _count: { _all: true },
        _avg: { timeSpentSec: true },
      }),
      db.labSession.count(),
    ]);

    const meta = await db.exercise.findMany({
      where: { id: { in: grouped.map((g) => g.exerciseId) } },
      select: { id: true, slug: true, title: true, kind: true, difficulty: true, isChallenge: true, topic: { select: { slug: true, title: true } } },
    });
    const byId = new Map(meta.map((m) => [m.id, m]));
    const rows = grouped
      .map((g) => {
        const m = byId.get(g.exerciseId)!;
        const tries = g._sum.attempts ?? 0;
        return {
          slug: m.slug,
          title: m.title,
          kind: m.kind,
          difficulty: m.difficulty,
          isChallenge: m.isChallenge,
          topicSlug: m.topic.slug,
          topicTitle: m.topic.title,
          learners: g._count._all,
          attempts: tries,
          successRate: tries ? Math.round(((g._sum.correctAttempts ?? 0) / tries) * 100) : null,
          hintsUsed: g._sum.hintsUsed ?? 0,
          avgTimeSec: g._avg.timeSpentSec ? Math.round(g._avg.timeSpentSec) : 0,
        };
      })
      .sort((a, b) => (a.successRate ?? 100) - (b.successRate ?? 100));

    return {
      totals: { users, exercises, attempts, correct, successRate: attempts ? Math.round((correct / attempts) * 100) : null, labs },
      hardest: rows.slice(0, 25),
      mostAttempted: [...rows].sort((a, b) => b.attempts - a.attempts).slice(0, 25),
    };
  });
}
