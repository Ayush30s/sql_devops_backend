import { z } from "zod";
import { body, rateLimit, route, sameOrigin } from "../../../../lib/api.ts";
import { currentUser, HttpError, requireUser } from "../../../../lib/auth.ts";
import { topicView } from "../../../../lib/content.ts";
import { db } from "../../../../lib/db.ts";
import { markLessonRead } from "../../../../lib/progress.ts";

/** A topic is addressed as `/api/topics/sql/select-basics`, or by its slug alone. */
async function resolve(parts: string[]) {
  if (parts.length >= 2) return { course: parts[0], topic: parts[1] };
  const row = await db.topic.findFirst({ where: { slug: parts[0] }, select: { module: { select: { course: { select: { slug: true } } } } } });
  if (!row) throw new HttpError(404, "That topic does not exist.");
  return { course: row.module.course.slug, topic: parts[0] };
}

const findTopic = async (parts: string[]) => {
  const { course, topic } = await resolve(parts);
  const row = await db.topic.findFirst({ where: { slug: topic, module: { course: { slug: course } } }, select: { id: true } });
  if (!row) throw new HttpError(404, "That topic does not exist.");
  return { id: row.id, course, topic };
};

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string[] }> }) {
  return route(async () => {
    const user = await currentUser();
    const { course, topic } = await resolve((await params).slug);
    return topicView(course, topic, user?.id ?? null);
  });
}

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("lesson-read") }),
  z.object({ action: z.literal("like"), liked: z.boolean() }),
  z.object({ action: z.literal("review"), body: z.string().trim().min(1, "Write a few words.").max(2000), rating: z.number().int().min(1).max(5).nullish() }),
  z.object({ action: z.literal("delete-review") }),
]);

/** Marks the lesson read, toggles the like, or writes/removes this learner's review. */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string[] }> }) {
  return route(async () => {
    sameOrigin(req);
    const user = await requireUser();
    const input = await body(req, schema);
    const topic = await findTopic((await params).slug);

    if (input.action === "lesson-read") {
      await markLessonRead(user.id, topic.id);
      return { ok: true };
    }

    if (input.action === "like") {
      if (input.liked)
        await db.topicLike.upsert({
          where: { userId_topicId: { userId: user.id, topicId: topic.id } },
          create: { userId: user.id, topicId: topic.id },
          update: {},
        });
      else await db.topicLike.deleteMany({ where: { userId: user.id, topicId: topic.id } });
      return { liked: input.liked, likes: await db.topicLike.count({ where: { topicId: topic.id } }) };
    }

    if (input.action === "delete-review") {
      await db.topicReview.deleteMany({ where: { userId: user.id, topicId: topic.id } });
      return { ok: true };
    }

    // One review per learner per topic: writing again edits the one you already left.
    rateLimit(`review:${user.id}`, 20, 60 * 60_000);
    const review = await db.topicReview.upsert({
      where: { userId_topicId: { userId: user.id, topicId: topic.id } },
      create: { userId: user.id, topicId: topic.id, body: input.body, rating: input.rating ?? null },
      update: { body: input.body, rating: input.rating ?? null },
    });
    return { id: review.id, body: review.body, rating: review.rating, author: user.name, createdAt: review.createdAt.toISOString() };
  });
}
