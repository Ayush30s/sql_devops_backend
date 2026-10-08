-- CreateTable
CREATE TABLE "topic_likes" (
    "userId" UUID NOT NULL,
    "topicId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "topic_likes_pkey" PRIMARY KEY ("userId","topicId")
);

-- CreateTable
CREATE TABLE "topic_reviews" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "topicId" UUID NOT NULL,
    "rating" INTEGER,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "topic_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "topic_likes_topicId_idx" ON "topic_likes"("topicId");

-- CreateIndex
CREATE INDEX "topic_reviews_topicId_createdAt_idx" ON "topic_reviews"("topicId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "topic_reviews_userId_topicId_key" ON "topic_reviews"("userId", "topicId");

-- AddForeignKey
ALTER TABLE "topic_likes" ADD CONSTRAINT "topic_likes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topic_likes" ADD CONSTRAINT "topic_likes_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "topics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topic_reviews" ADD CONSTRAINT "topic_reviews_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topic_reviews" ADD CONSTRAINT "topic_reviews_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "topics"("id") ON DELETE CASCADE ON UPDATE CASCADE;
