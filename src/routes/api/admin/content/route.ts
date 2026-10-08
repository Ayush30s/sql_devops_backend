import { route } from "../../../../lib/api.ts";
import { requireAdmin } from "../../../../lib/auth.ts";
import { db } from "../../../../lib/db.ts";

/**
 * Courses, their modules and their topics for the content admin. Lesson bodies are left out —
 * the editor fetches one topic's content when you open it, instead of shipping all 81.
 */
export async function GET() {
  return route(async () => {
    await requireAdmin();
    const [courses, datasets] = await Promise.all([
      db.course.findMany({
        orderBy: { position: "asc" },
        select: {
          slug: true,
          title: true,
          kind: true,
          modules: {
            orderBy: { position: "asc" },
            select: {
              slug: true,
              title: true,
              topics: {
                orderBy: { position: "asc" },
                select: {
                  id: true,
                  slug: true,
                  title: true,
                  summary: true,
                  difficulty: true,
                  position: true,
                  dataset: { select: { slug: true } },
                  prerequisites: { select: { slug: true } },
                  _count: { select: { exercises: true } },
                },
              },
            },
          },
        },
      }),
      db.sqlDataset.findMany({ orderBy: { createdAt: "asc" }, select: { slug: true, name: true } }),
    ]);

    return {
      datasets,
      courses: courses.map((c) => ({
        slug: c.slug,
        title: c.title,
        modules: c.modules.map((m) => ({
          slug: m.slug,
          title: m.title,
          topics: m.topics.map((t) => ({
            id: t.id,
            slug: t.slug,
            title: t.title,
            summary: t.summary,
            difficulty: t.difficulty,
            position: t.position,
            datasetSlug: t.dataset?.slug ?? null,
            prerequisites: t.prerequisites.map((p) => p.slug),
            exercises: t._count.exercises,
          })),
        })),
      })),
    };
  });
}
