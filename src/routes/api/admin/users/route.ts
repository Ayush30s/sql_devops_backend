import { route } from "../../../../lib/api.ts";
import { requireAdmin } from "../../../../lib/auth.ts";
import { db } from "../../../../lib/db.ts";
import { levelFor } from "../../../../lib/progress.ts";

/** Every learner with their progress totals, for the admin panel's user list. */
export async function GET(req: Request) {
  return route(async () => {
    await requireAdmin();
    const url = new URL(req.url);
    const search = url.searchParams.get("q");
    const users = await db.user.findMany({
      where: search ? { OR: [{ email: { contains: search, mode: "insensitive" } }, { name: { contains: search, mode: "insensitive" } }] } : {},
      orderBy: { createdAt: "desc" },
      take: 200,
      include: {
        streak: true,
        _count: { select: { attempts: true } },
        exerciseProgress: { where: { status: "COMPLETED" }, select: { xpEarned: true, exercise: { select: { kind: true } } } },
        topicProgress: { where: { completedAt: { not: null } }, select: { topicId: true } },
      },
    });
    return {
      users: users.map((u) => {
        const xp = u.exerciseProgress.reduce((n, p) => n + p.xpEarned, 0);
        return {
          id: u.id,
          email: u.email,
          name: u.name,
          role: u.role,
          createdAt: u.createdAt.toISOString(),
          xp,
          level: levelFor(xp).level,
          attempts: u._count.attempts,
          completedSql: u.exerciseProgress.filter((p) => p.exercise.kind === "SQL").length,
          completedLinux: u.exerciseProgress.filter((p) => p.exercise.kind === "LINUX").length,
          completedTopics: u.topicProgress.length,
          streak: u.streak?.current ?? 0,
        };
      }),
    };
  });
}
