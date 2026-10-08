-- AlterEnum
ALTER TYPE "IncidentStatus" ADD VALUE 'GAVE_UP';

-- DropIndex
DROP INDEX "incident_runs_userId_scenarioId_key";

-- AlterTable
ALTER TABLE "incident_runs" ADD COLUMN     "events" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "hintsUsed" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "prevention" TEXT,
ADD COLUMN     "score" INTEGER,
ADD COLUMN     "scoreDetail" JSONB,
ADD COLUMN     "wrongDiagnoses" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "incident_scenarios" ADD COLUMN     "scoring" JSONB NOT NULL DEFAULT '{}';

-- CreateIndex
CREATE INDEX "incident_runs_userId_scenarioId_startedAt_idx" ON "incident_runs"("userId", "scenarioId", "startedAt");
