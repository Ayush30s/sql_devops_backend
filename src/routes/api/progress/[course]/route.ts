import { route } from "../../../../lib/api.ts";
import { HttpError, requireUser } from "../../../../lib/auth.ts";
import { courseProgress } from "../../../../lib/progress.ts";

/** One course's progress: /api/progress/sql and /api/progress/linux. */
export async function GET(_req: Request, { params }: { params: Promise<{ course: string }> }) {
  return route(async () => {
    const user = await requireUser();
    const course = await courseProgress((await params).course, user.id);
    if (!course) throw new HttpError(404, "That course does not exist.");
    return course;
  });
}
