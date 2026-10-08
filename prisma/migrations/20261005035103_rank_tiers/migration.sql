-- CreateTable
CREATE TABLE "rank_tiers" (
    "id" UUID NOT NULL,
    "tier" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "rank" TEXT NOT NULL,
    "minLevel" INTEGER NOT NULL,
    "character" TEXT NOT NULL,
    "epithet" TEXT NOT NULL,
    "image" TEXT NOT NULL,
    "colorA" TEXT NOT NULL,
    "colorB" TEXT NOT NULL,
    "glow" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rank_tiers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rank_tiers_tier_key" ON "rank_tiers"("tier");

-- CreateIndex
CREATE UNIQUE INDEX "rank_tiers_key_key" ON "rank_tiers"("key");

-- CreateIndex
CREATE UNIQUE INDEX "rank_tiers_minLevel_key" ON "rank_tiers"("minLevel");
