/**
 * Who is using the app right now. Each signed-in browser sends a heartbeat every minute and
 * we keep the last one per learner in memory — a learner counts as live for `WINDOW` after it.
 *
 * ponytail: in-process, like the rate limiter and the lab lock. Several app instances would each
 * see only their own visitors; move this to Redis (`SETEX user:<id>`, then `DBSIZE`/`SCAN`) if the
 * app is ever load-balanced.
 */

const WINDOW = 2 * 60_000;
const seen = new Map<string, number>();

/** Records a heartbeat and returns how many learners are live, including this one. */
export function heartbeat(userId: string, now = Date.now()): number {
  seen.set(userId, now);
  return liveCount(now);
}

export function liveCount(now = Date.now()): number {
  let live = 0;
  for (const [id, at] of seen) {
    if (now - at <= WINDOW) live++;
    else seen.delete(id); // expired entries pay for their own cleanup
  }
  return live;
}

/** Drops a learner from the count immediately (used on sign-out). */
export const forget = (userId: string) => seen.delete(userId);

/** Test seam. */
export const reset = () => seen.clear();
