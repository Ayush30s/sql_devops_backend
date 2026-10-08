import { db } from "./db.ts";
import { levelFor } from "./progress.ts";

/**
 * Standings across everyone who hasn't opted out. Equal scores share a rank and the next
 * learner takes the position they actually hold (1, 2, 3, 3, 5), so a rank always answers
 * "how many people are ahead of me".
 */

export const SORTS = ["xp", "solved", "streak"] as const;
export type Sort = (typeof SORTS)[number];

export interface Row {
  rank: number;
  userId: string;
  name: string;
  xp: number;
  level: number;
  solved: number;
  sqlSolved: number;
  linuxSolved: number;
  streak: number;
  badges: number;
  /** The signed-in learner's own row. */
  me: boolean;
}

export interface Leaderboard {
  sort: Sort;
  rows: Row[];
  /** Everyone listed, so a learner outside the visible top knows how many are ahead. */
  total: number;
  /** The viewer's row even when it falls outside the visible top; null when they opted out. */
  you: Row | null;
}

interface Raw {
  id: string;
  name: string;
  xp: bigint | null;
  solved: bigint | null;
  sql_solved: bigint | null;
  linux_solved: bigint | null;
  streak: number | null;
  badges: bigint | null;
}

export async function leaderboard(sort: Sort = "xp", viewerId: string | null = null, limit = 50): Promise<Leaderboard> {
  const raw = await db.$queryRaw<Raw[]>`
    SELECT u.id,
           u.name,
           COALESCE(SUM(p."xpEarned"), 0) AS xp,
           COUNT(p.*) FILTER (WHERE p.status::text = 'COMPLETED') AS solved,
           COUNT(p.*) FILTER (WHERE p.status::text = 'COMPLETED' AND e.kind::text = 'SQL') AS sql_solved,
           COUNT(p.*) FILTER (WHERE p.status::text = 'COMPLETED' AND e.kind::text = 'LINUX') AS linux_solved,
           MAX(COALESCE(s.current, 0)) AS streak,
           COUNT(DISTINCT a."achievementId") AS badges
      FROM users u
      JOIN profiles pr ON pr."userId" = u.id AND pr."onLeaderboard" = true
      LEFT JOIN exercise_progress p ON p."userId" = u.id
      LEFT JOIN exercises e ON e.id = p."exerciseId"
      LEFT JOIN streaks s ON s."userId" = u.id
      LEFT JOIN user_achievements a ON a."userId" = u.id
     GROUP BY u.id, u.name`;

  const scored = raw.map((r) => {
    const xp = Number(r.xp ?? 0);
    return {
      userId: r.id,
      name: r.name,
      xp,
      level: levelFor(xp).level,
      solved: Number(r.solved ?? 0),
      sqlSolved: Number(r.sql_solved ?? 0),
      linuxSolved: Number(r.linux_solved ?? 0),
      streak: Number(r.streak ?? 0),
      badges: Number(r.badges ?? 0),
      me: r.id === viewerId,
    };
  });

  // Nobody who has done nothing at all clutters the table.
  const active = scored.filter((r) => r.xp > 0 || r.solved > 0 || r.streak > 0);
  const score = (r: (typeof active)[number]) => (sort === "solved" ? r.solved : sort === "streak" ? r.streak : r.xp);
  active.sort((a, b) => score(b) - score(a) || b.xp - a.xp || a.name.localeCompare(b.name));

  let rank = 0;
  let previous: number | null = null;
  const ranked: Row[] = active.map((r, i) => {
    const value = score(r);
    if (value !== previous) rank = i + 1;
    previous = value;
    return { ...r, rank };
  });

  return {
    sort,
    rows: ranked.slice(0, limit),
    total: ranked.length,
    you: ranked.find((r) => r.me) ?? null,
  };
}
