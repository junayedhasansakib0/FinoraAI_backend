-- AlterTable
ALTER TABLE "User" ADD COLUMN     "emailVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "emailVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "verificationTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN     "verificationTokenHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_verificationTokenHash_key" ON "User"("verificationTokenHash");

-- Backfill: accounts that existed before email verification was introduced are grandfathered as
-- verified, so the soft login gate never shows them a spurious "unverified" prompt and no live
-- account is disrupted ("never delete/lock out existing users"). New rows keep the false default
-- and go through the verification flow. This runs once, against rows present at deploy time.
UPDATE "User" SET "emailVerified" = true, "emailVerifiedAt" = CURRENT_TIMESTAMP WHERE "emailVerified" = false;
