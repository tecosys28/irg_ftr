-- IRG Chain 888101 — transaction audit log
-- IPR Owner: Rohit Tidke | © 2026 Intech Research Group

-- CreateEnum
CREATE TYPE "ChainTxMode" AS ENUM ('raw', 'system');

-- CreateEnum
CREATE TYPE "ChainTxStatus" AS ENUM ('PENDING', 'SUBMITTED', 'CONFIRMED', 'FINAL', 'FAILED', 'SIMULATED');

-- CreateTable
CREATE TABLE "ChainTxAudit" (
    "id" TEXT NOT NULL,
    "clientTxId" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "mode" "ChainTxMode" NOT NULL DEFAULT 'system',
    "chainId" INTEGER NOT NULL DEFAULT 888101,
    "toAddress" TEXT NOT NULL DEFAULT '',
    "valueWei" TEXT NOT NULL DEFAULT '0',
    "dataHash" TEXT NOT NULL DEFAULT '',
    "txHash" TEXT NOT NULL DEFAULT '',
    "blockNumber" INTEGER,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "status" "ChainTxStatus" NOT NULL DEFAULT 'PENDING',
    "lastError" TEXT NOT NULL DEFAULT '',
    "retries" INTEGER NOT NULL DEFAULT 0,
    "actorParticipantId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "ChainTxAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChainTxAudit_clientTxId_key" ON "ChainTxAudit"("clientTxId");
CREATE INDEX "ChainTxAudit_module_action_idx" ON "ChainTxAudit"("module", "action");
CREATE INDEX "ChainTxAudit_status_createdAt_idx" ON "ChainTxAudit"("status", "createdAt");
CREATE INDEX "ChainTxAudit_txHash_idx" ON "ChainTxAudit"("txHash");
CREATE INDEX "ChainTxAudit_actorParticipantId_idx" ON "ChainTxAudit"("actorParticipantId");
