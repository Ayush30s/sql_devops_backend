/** Badges are derived from progress, never granted by hand. `criteria` is stored as JSON on the row. */
export type Criteria =
  | { type: "exercises"; count: number; kind?: "SQL" | "LINUX" }
  | { type: "challenges"; count: number }
  | { type: "topics"; count: number; kind?: "SQL" | "LINUX" }
  | { type: "module"; slug: string }
  | { type: "streak"; days: number }
  | { type: "level"; level: number }
  | { type: "firstTry"; count: number };

/** What the badge evaluator needs to know about one learner. */
export interface AchievementStats {
  completedExercises: { SQL: number; LINUX: number };
  completedChallenges: number;
  completedTopics: { SQL: number; LINUX: number };
  completedModules: Set<string>;
  firstTryCorrect: number;
  streakDays: number;
  level: number;
}

export function earned(criteria: Criteria, s: AchievementStats): boolean {
  switch (criteria.type) {
    case "exercises":
      return criteria.kind ? s.completedExercises[criteria.kind] >= criteria.count : s.completedExercises.SQL + s.completedExercises.LINUX >= criteria.count;
    case "challenges":
      return s.completedChallenges >= criteria.count;
    case "topics":
      return criteria.kind ? s.completedTopics[criteria.kind] >= criteria.count : s.completedTopics.SQL + s.completedTopics.LINUX >= criteria.count;
    case "module":
      return s.completedModules.has(criteria.slug);
    case "streak":
      return s.streakDays >= criteria.days;
    case "level":
      return s.level >= criteria.level;
    case "firstTry":
      return s.firstTryCorrect >= criteria.count;
  }
}
