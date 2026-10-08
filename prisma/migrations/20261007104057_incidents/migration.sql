-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('INVESTIGATING', 'RESOLVED');

-- AlterEnum
ALTER TYPE "LabKind" ADD VALUE 'INCIDENT';

-- CreateTable
CREATE TABLE "incident_scenarios" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "severity" TEXT NOT NULL,
    "usersAffected" INTEGER NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "alert" TEXT NOT NULL,
    "architecture" TEXT NOT NULL DEFAULT '',
    "briefing" JSONB NOT NULL,
    "machineSetup" TEXT NOT NULL,
    "databaseSql" TEXT NOT NULL,
    "model" JSONB NOT NULL,
    "diagnosis" JSONB NOT NULL,
    "solution" JSONB NOT NULL,
    "hints" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "incident_scenarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incident_runs" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "scenarioId" UUID NOT NULL,
    "status" "IncidentStatus" NOT NULL DEFAULT 'INVESTIGATING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "sqlJournal" TEXT[],
    "health" JSONB NOT NULL,
    "loggedUntil" TIMESTAMP(3) NOT NULL,
    "commands" INTEGER NOT NULL DEFAULT 0,
    "queries" INTEGER NOT NULL DEFAULT 0,
    "diagnosis" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "incident_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "incident_scenarios_code_key" ON "incident_scenarios"("code");

-- CreateIndex
CREATE INDEX "incident_runs_scenarioId_idx" ON "incident_runs"("scenarioId");

-- CreateIndex
CREATE UNIQUE INDEX "incident_runs_userId_scenarioId_key" ON "incident_runs"("userId", "scenarioId");

-- AddForeignKey
ALTER TABLE "incident_runs" ADD CONSTRAINT "incident_runs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_runs" ADD CONSTRAINT "incident_runs_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "incident_scenarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;
