import { route } from "../../../lib/api.ts";
import { requireUser } from "../../../lib/auth.ts";
import { db } from "../../../lib/db.ts";

/** Every story challenge, in course order, with whether this learner has solved it. */
export async function GET() {
  return route(async () => {
    const user = await requireUser();
    const [challenges, done] = await Promise.all([
      db.exercise.findMany({
        where: { isChallenge: true },
        orderBy: [{ topic: { module: { position: "asc" } } }, { topic: { position: "asc" } }, { position: "asc" }],
        select: {
          slug: true,
          title: true,
          story: true,
          kind: true,
          difficulty: true,
          xp: true,
          topic: { select: { slug: true, title: true, module: { select: { title: true, course: { select: { slug: true } } } } } },
        },
      }),
      db.exerciseProgress.findMany({
        where: { userId: user.id, status: "COMPLETED", exercise: { isChallenge: true } },
        select: { exercise: { select: { slug: true } } },
      }),
    ]);
    const completed = new Set(done.map((d) => d.exercise.slug));
    return {
      challenges: challenges.map((c) => ({
        slug: c.slug,
        title: c.title,
        story: c.story,
        kind: c.kind,
        difficulty: c.difficulty,
        xp: c.xp,
        topicSlug: c.topic.slug,
        moduleTitle: c.topic.module.title,
        courseSlug: c.topic.module.course.slug,
        completed: completed.has(c.slug),
      })),
      solved: completed.size,
    };
  });
}
