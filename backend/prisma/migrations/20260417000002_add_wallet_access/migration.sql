-- Wallet access (v2.7) — mirror of IRG_GDP wallet_access
-- IPR Owner: Rohit Tidke | (c) 2026 Intech Research Group

-- CreateEnum
CREATE TYPE "WalletState" AS ENUM ('CREATED','ACTIVATED','LOCKED','RECOVERING','OWNERSHIP_TRANSFER','SUSPENDED','RECOVERED');
CREATE TYPE "WalletHolderType" AS ENUM ('INDIVIDUAL','LEGAL_PERSON');
CREATE TYPE "WalletEntityType" AS ENUM ('UNSPECIFIED','PRIVATE_LTD','PUBLIC_LTD_LISTED','PUBLIC_LTD_UNLISTED','LLP','PARTNERSHIP','PROPRIETORSHIP','PUBLIC_TRUST','PRIVATE_TRUST','COOPERATIVE','HUF','OTHER');
CREATE TYPE "WalletDeviceState" AS ENUM ('PENDING','ACTIVE','RETIRED','REVOKED');
CREATE TYPE "InactivityEventKind" AS ENUM ('PROMPT_SENT','REMINDER_SENT','NOMINEES_ALERTED','CONFIRMED');
CREATE TYPE "RecoveryPath" AS ENUM ('SELF','SOCIAL','TRUSTEE');
CREATE TYPE "RecoveryStatus" AS ENUM ('FILED','NOTIFIED','AWAITING_SIGNATURES','AWAITING_OMBUDSMAN','APPROVED','EXECUTED','REJECTED','CANCELLED','EXPIRED');
CREATE TYPE "OwnershipTransferStatus" AS ENUM ('FILED','AWAITING_OMBUDSMAN','APPROVED','EXECUTED','REJECTED','CANCELLED','EXPIRED');
CREATE TYPE "OwnershipTransferReason" AS ENUM ('ACQUISITION','PARTNERSHIP_CHANGE','TRUSTEE_SUCCESSION','PROP_SALE','OPERATOR_DEPARTED','OTHER');

-- WalletActivation
CREATE TABLE "WalletActivation" (
    "id" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "state" "WalletState" NOT NULL DEFAULT 'CREATED',
    "holderType" "WalletHolderType" NOT NULL DEFAULT 'INDIVIDUAL',
    "legalEntityName" TEXT NOT NULL DEFAULT '',
    "entityType" "WalletEntityType" NOT NULL DEFAULT 'UNSPECIFIED',
    "passwordHash" TEXT NOT NULL DEFAULT '',
    "passwordAlgo" TEXT NOT NULL DEFAULT 'pbkdf2_sha256',
    "passwordIterations" INTEGER NOT NULL DEFAULT 600000,
    "passwordSalt" TEXT NOT NULL DEFAULT '',
    "seedPhraseHash" TEXT NOT NULL DEFAULT '',
    "seedPhraseConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "seedPhraseConfirmedAt" TIMESTAMP(3),
    "failedPasswordAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastActivityAt" TIMESTAMP(3),
    "inactivityPromptSentAt" TIMESTAMP(3),
    "inactivityReminderSentAt" TIMESTAMP(3),
    "nomineesAlertedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),
    "lastStateChange" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WalletActivation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WalletActivation_participantId_key" ON "WalletActivation"("participantId");
CREATE UNIQUE INDEX "WalletActivation_walletAddress_key" ON "WalletActivation"("walletAddress");
CREATE INDEX "WalletActivation_state_idx" ON "WalletActivation"("state");
CREATE INDEX "WalletActivation_walletAddress_idx" ON "WalletActivation"("walletAddress");
CREATE INDEX "WalletActivation_lastActivityAt_idx" ON "WalletActivation"("lastActivityAt");

-- WalletNominee
CREATE TABLE "WalletNominee" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "relationship" TEXT NOT NULL,
    "email" TEXT NOT NULL DEFAULT '',
    "mobile" TEXT NOT NULL DEFAULT '',
    "idDocumentHash" TEXT NOT NULL DEFAULT '',
    "sharePercent" DECIMAL(6,3) NOT NULL DEFAULT 0,
    "socialRecoveryThreshold" INTEGER NOT NULL DEFAULT 2,
    "notifiedAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WalletNominee_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WalletNominee_walletId_active_idx" ON "WalletNominee"("walletId", "active");
ALTER TABLE "WalletNominee" ADD CONSTRAINT "WalletNominee_walletId_fkey"
    FOREIGN KEY ("walletId") REFERENCES "WalletActivation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- WalletDevice
CREATE TABLE "WalletDevice" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "deviceIdHash" TEXT NOT NULL,
    "deviceLabel" TEXT NOT NULL DEFAULT '',
    "platform" TEXT NOT NULL DEFAULT '',
    "state" "WalletDeviceState" NOT NULL DEFAULT 'PENDING',
    "coolingOffUntil" TIMESTAMP(3),
    "bindTxHash" TEXT NOT NULL DEFAULT '',
    "revokeTxHash" TEXT NOT NULL DEFAULT '',
    "boundAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    CONSTRAINT "WalletDevice_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WalletDevice_walletId_state_idx" ON "WalletDevice"("walletId", "state");
CREATE INDEX "WalletDevice_deviceIdHash_idx" ON "WalletDevice"("deviceIdHash");
ALTER TABLE "WalletDevice" ADD CONSTRAINT "WalletDevice_walletId_fkey"
    FOREIGN KEY ("walletId") REFERENCES "WalletActivation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- WalletInactivityEvent
CREATE TABLE "WalletInactivityEvent" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "kind" "InactivityEventKind" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "detail" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "WalletInactivityEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WalletInactivityEvent_walletId_occurredAt_idx" ON "WalletInactivityEvent"("walletId","occurredAt");
ALTER TABLE "WalletInactivityEvent" ADD CONSTRAINT "WalletInactivityEvent_walletId_fkey"
    FOREIGN KEY ("walletId") REFERENCES "WalletActivation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- WalletRecoveryCase
CREATE TABLE "WalletRecoveryCase" (
    "id" TEXT NOT NULL,
    "originalWalletId" TEXT NOT NULL,
    "path" "RecoveryPath" NOT NULL,
    "status" "RecoveryStatus" NOT NULL DEFAULT 'FILED',
    "claimantParticipantId" TEXT,
    "claimantWalletAddress" TEXT NOT NULL DEFAULT '',
    "grounds" TEXT NOT NULL DEFAULT '',
    "evidenceBundleHash" TEXT NOT NULL DEFAULT '',
    "coolingOffEndsAt" TIMESTAMP(3),
    "publicNoticeEndsAt" TIMESTAMP(3),
    "recoveryRequestedTxHash" TEXT NOT NULL DEFAULT '',
    "ombudsmanOrderHash" TEXT NOT NULL DEFAULT '',
    "ombudsmanOrderTxHash" TEXT NOT NULL DEFAULT '',
    "executionTxHash" TEXT NOT NULL DEFAULT '',
    "reversibilityEndsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WalletRecoveryCase_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WalletRecoveryCase_path_status_idx" ON "WalletRecoveryCase"("path","status");
CREATE INDEX "WalletRecoveryCase_originalWalletId_status_idx" ON "WalletRecoveryCase"("originalWalletId","status");
ALTER TABLE "WalletRecoveryCase" ADD CONSTRAINT "WalletRecoveryCase_originalWalletId_fkey"
    FOREIGN KEY ("originalWalletId") REFERENCES "WalletActivation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- WalletNomineeSignature
CREATE TABLE "WalletNomineeSignature" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "nomineeId" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "signedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WalletNomineeSignature_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WalletNomineeSignature_caseId_nomineeId_key" ON "WalletNomineeSignature"("caseId","nomineeId");
ALTER TABLE "WalletNomineeSignature" ADD CONSTRAINT "WalletNomineeSignature_caseId_fkey"
    FOREIGN KEY ("caseId") REFERENCES "WalletRecoveryCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WalletNomineeSignature" ADD CONSTRAINT "WalletNomineeSignature_nomineeId_fkey"
    FOREIGN KEY ("nomineeId") REFERENCES "WalletNominee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- WalletOwnershipTransferCase
CREATE TABLE "WalletOwnershipTransferCase" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "status" "OwnershipTransferStatus" NOT NULL DEFAULT 'FILED',
    "outgoingOperatorParticipantId" TEXT,
    "incomingOperatorParticipantId" TEXT,
    "reason" "OwnershipTransferReason" NOT NULL DEFAULT 'OTHER',
    "grounds" TEXT NOT NULL DEFAULT '',
    "evidenceBundleHash" TEXT NOT NULL DEFAULT '',
    "publicNoticeEndsAt" TIMESTAMP(3),
    "transferRequestedTxHash" TEXT NOT NULL DEFAULT '',
    "ombudsmanOrderHash" TEXT NOT NULL DEFAULT '',
    "ombudsmanOrderTxHash" TEXT NOT NULL DEFAULT '',
    "executionTxHash" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WalletOwnershipTransferCase_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WalletOwnershipTransferCase_walletId_status_idx" ON "WalletOwnershipTransferCase"("walletId","status");
CREATE INDEX "WalletOwnershipTransferCase_status_createdAt_idx" ON "WalletOwnershipTransferCase"("status","createdAt");
ALTER TABLE "WalletOwnershipTransferCase" ADD CONSTRAINT "WalletOwnershipTransferCase_walletId_fkey"
    FOREIGN KEY ("walletId") REFERENCES "WalletActivation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
