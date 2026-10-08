import { db } from "./db.ts";

/** One rung of the fighter-rank ladder, as GET /api/ranks serves it from the rank_tiers table. */
export interface RankTier {
  /** Position on the ladder, 1 (lowest) upwards: also the power the UI animates with. */
  tier: number;
  key: string;
  rank: string;
  /** Lowest XP level that unlocks this tier. */
  minLevel: number;
  character: string;
  epithet: string;
  image: string;
  /** Colour identity: primary, deep and glow. */
  colorA: string;
  colorB: string;
  glow: string;
  /** Why this fighter stands at this rank. */
  about: string;
}

/** The whole ladder, lowest tier first. */
export const rankTiers = (): Promise<RankTier[]> =>
  db.rankTier.findMany({
    orderBy: { tier: "asc" },
    select: { tier: true, key: true, rank: true, minLevel: true, character: true, epithet: true, image: true, colorA: true, colorB: true, glow: true, about: true },
  });

/** All the XP both courses can award, with no hints or revealed solutions: what "100% done" means. */
export const totalXp = async () => (await db.exercise.aggregate({ _sum: { xp: true } }))._sum.xp ?? 0;
