import { route } from "../../../../../lib/api.ts";
import { HttpError, requireAdmin } from "../../../../../lib/auth.ts";
import { db } from "../../../../../lib/db.ts";
import { courseProgress, levelFor, reviewItems, xpTotal } from "../../../../../lib/progress.ts";

/** One learner's progress in detail (admin view of the progress page). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return route(async () => {
    await requireAdmin();
    const id = (await params).id;
    const user = await db.user.findUnique({ where: { id }, include: { profile: true, streak: true } });
    if (!user) throw new HttpError(404, "That user does not exist.");
    const [xp, sql, linux, review, recent, badges] = await Promise.all([
      xpTotal(id),
      courseProgress("sql", id),
      courseProgress("linux", id),
      reviewItems(id, 10),
      db.exerciseAttempt.findMany({
        where: { userId: id },
        orderBy: { createdAt: "desc" },
        take: 25,
        select: { status: true, createdAt: true, durationMs: true, exercise: { select: { slug: true, title: true, kind: true } } },
      }),
      db.userAchievement.findMany({ where: { userId: id }, include: { achievement: { select: { slug: true, title: true } } }, orderBy: { earnedAt: "desc" } }),
    ]);
    return {
      user: { id: user.id, email: user.email, name: user.name, role: user.role, createdAt: user.createdAt.toISOString() },
      profile: user.profile,
      xp,
      level: levelFor(xp).level,
      streak: { current: user.streak?.current ?? 0, longest: user.streak?.longest ?? 0 },
      courses: [sql, linux].filter((c) => c !== null),
      review,
      recentAttempts: recent.map((a) => ({ ...a, createdAt: a.createdAt.toISOString() })),
      achievements: badges.map((b) => ({ slug: b.achievement.slug, title: b.achievement.title, earnedAt: b.earnedAt.toISOString() })),
    };
  });
}
