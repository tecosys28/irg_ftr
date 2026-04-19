/**
 * IRG Chain 888101 — Wallet access business logic (TypeScript mirror of
 * wallet_access/services.py in IRG_GDP).
 *
 * Every public function in this module is the single correct way to
 * perform that operation; routes do nothing more than translate HTTP
 * request bodies into function calls and translate thrown errors into
 * structured responses.
 *
 * Security invariants:
 *   - Plaintext wallet password and plaintext seed phrase are NEVER
 *     persisted. Only hashes are stored. Plaintext values are
 *     dereferenced as soon as the hash is computed.
 *   - State transitions happen inside transactions so crashes cannot
 *     leave a wallet half-activated or half-recovered.
 *
 * IPR Owner: Rohit Tidke | (c) 2026 Intech Research Group
 */

import { PrismaClient, Prisma } from '@prisma/client';

import {
  hashSeedPhrase,
  hashWalletPassword,
  verifyWalletPassword as verifyPwHash,
} from './hashing';
import {
  InvalidPassword,
  InvalidSeedPhrase,
  NomineePolicyViolation,
  OwnershipTransferError,
  PasswordPolicyViolation,
  RecoveryError,
  WalletAccessError,
  WalletAlreadyActivated,
  WalletLocked,
  WalletNotFound,
  WalletNotTransactable,
} from './errors';
import {
  DEVICE_COOLING_OFF_MS,
  INACTIVITY_NOMINEES_AFTER_REMINDER_MS,
  INACTIVITY_PROMPT_AFTER_MS,
  INACTIVITY_REMINDER_AFTER_PROMPT_MS,
  LOCK_DURATION_MS,
  MAX_FAILED_PASSWORD_ATTEMPTS,
  OWNERSHIP_TRANSFER_NOTICE_MS,
  REVERSIBILITY_WINDOW_MS,
  SEED_PHRASE_WORD_COUNT,
  SOCIAL_RECOVERY_COOLING_OFF_MS,
  TRUSTEE_PUBLIC_NOTICE_MS,
  WALLET_PASSWORD_MIN_LEN,
  addMs,
} from './policy';
import { notify } from './notifications';

const prisma = new PrismaClient();

// ─────────────────────────────────────────────────────────────────────────────
// PASSWORD POLICY
// ─────────────────────────────────────────────────────────────────────────────

const ALPHA = /[A-Za-z]/;
const DIGIT = /\d/;

function validateWalletPassword(
  password: string,
  opts: { loginPasswordHash?: string | null } = {},
): void {
  if (!password || password.length < WALLET_PASSWORD_MIN_LEN) {
    throw new PasswordPolicyViolation(
      `Wallet password must be at least ${WALLET_PASSWORD_MIN_LEN} characters.`,
    );
  }
  const isComplex = ALPHA.test(password) && DIGIT.test(password);
  const words = password.trim().split(/\s+/);
  const isPassphrase = words.length >= 4 && password.length >= 20;
  if (!(isComplex || isPassphrase)) {
    throw new PasswordPolicyViolation(
      'Wallet password must contain a letter and a digit, ' +
        'OR be a 4+ word passphrase of 20+ characters.',
    );
  }
  if (opts.loginPasswordHash && verifyPwHash(password, opts.loginPasswordHash)) {
    throw new PasswordPolicyViolation(
      'Your wallet password must be different from your login password.',
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC SHAPES
// ─────────────────────────────────────────────────────────────────────────────

export interface WalletInfo {
  address: string;
  chainId: number;
  state: string;
  stateLabel: string;
  blockingReason: string;
  holderType: string;
  legalEntityName: string;
  entityType: string;
  createdAt: string;
  activatedAt: string | null;
  nomineeCount: number;
  nomineeSharesTotal: string;
  activeDeviceCount: number;
  failedPasswordAttempts: number;
  lockedUntil: string | null;
  lastActivityAt: string | null;
  isTransactable: boolean;
}

const STATE_LABELS: Record<string, string> = {
  CREATED: 'Created — awaiting activation',
  ACTIVATED: 'Activated — ready for transactions',
  LOCKED: 'Locked — too many failed attempts',
  RECOVERING: 'Recovery in progress',
  OWNERSHIP_TRANSFER: 'Ownership transfer in progress (legal-person wallets)',
  SUSPENDED: 'Suspended',
  RECOVERED: 'Recovered — superseded',
};

function blockingReasonFor(state: string): string {
  switch (state) {
    case 'CREATED':
      return 'Wallet not activated. Please set your wallet password.';
    case 'LOCKED':
      return 'Wallet locked due to repeated failed password attempts.';
    case 'RECOVERING':
      return 'A recovery is in progress. Transactions paused until resolved.';
    case 'OWNERSHIP_TRANSFER':
      return 'An ownership transfer is in progress. Transactions paused until resolved.';
    case 'SUSPENDED':
      return 'Wallet suspended. Please contact support or the Ombudsman.';
    case 'RECOVERED':
      return 'This wallet has been recovered to another address. It can no longer transact.';
    default:
      return '';
  }
}

function isTransactable(w: { state: string; lockedUntil: Date | null }): boolean {
  if (w.state !== 'ACTIVATED') return false;
  if (w.lockedUntil && w.lockedUntil.getTime() > Date.now()) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// INFO
// ─────────────────────────────────────────────────────────────────────────────

export async function getWalletInfo(participantId: string): Promise<WalletInfo> {
  const wallet = await prisma.walletActivation.findUnique({
    where: { participantId },
    include: {
      nominees: { where: { active: true } },
      devices: { where: { state: 'ACTIVE' } },
    },
  });
  if (!wallet) throw new WalletNotFound();

  const total = wallet.nominees.reduce(
    (s, n) => s.plus(n.sharePercent),
    new Prisma.Decimal(0),
  );
  return {
    address: wallet.walletAddress,
    chainId: 888101,
    state: wallet.state,
    stateLabel: STATE_LABELS[wallet.state] ?? wallet.state,
    blockingReason: blockingReasonFor(wallet.state),
    holderType: wallet.holderType,
    legalEntityName: wallet.legalEntityName,
    entityType: wallet.entityType === 'UNSPECIFIED' ? '' : wallet.entityType,
    createdAt: wallet.createdAt.toISOString(),
    activatedAt: wallet.activatedAt?.toISOString() ?? null,
    nomineeCount: wallet.nominees.length,
    nomineeSharesTotal: total.toString(),
    activeDeviceCount: wallet.devices.length,
    failedPasswordAttempts: wallet.failedPasswordAttempts,
    lockedUntil: wallet.lockedUntil?.toISOString() ?? null,
    lastActivityAt: wallet.lastActivityAt?.toISOString() ?? null,
    isTransactable: isTransactable(wallet),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTIVATION
// ─────────────────────────────────────────────────────────────────────────────

export interface NomineeInput {
  name: string;
  relationship: string;
  email?: string;
  mobile?: string;
  share_percent: number | string;
  id_document_hash?: string;
  social_recovery_threshold?: number;
}

export interface ActivateParams {
  participantId: string;
  loginPasswordHash?: string | null;
  walletPassword: string;
  seedPhraseWords: string[];
  holderType: 'INDIVIDUAL' | 'LEGAL_PERSON';
  legalEntityName?: string;
  entityType?: string;
  nominees: NomineeInput[];
  deviceIdHash: string;
  deviceLabel?: string;
  platform?: string;
  termsAccepted: boolean;
}

const VALID_ENTITY_TYPES = new Set([
  'PRIVATE_LTD',
  'PUBLIC_LTD_LISTED',
  'PUBLIC_LTD_UNLISTED',
  'LLP',
  'PARTNERSHIP',
  'PROPRIETORSHIP',
  'PUBLIC_TRUST',
  'PRIVATE_TRUST',
  'COOPERATIVE',
  'HUF',
  'OTHER',
]);

export async function activateWallet(params: ActivateParams): Promise<WalletInfo> {
  if (!params.termsAccepted) {
    throw new WalletAccessError('You must accept the recovery terms to activate.');
  }

  const wallet = await prisma.walletActivation.findUnique({
    where: { participantId: params.participantId },
  });
  if (!wallet) throw new WalletNotFound('No wallet found. Complete registration first.');
  if (wallet.state === 'ACTIVATED') throw new WalletAlreadyActivated();
  if (wallet.state === 'SUSPENDED' || wallet.state === 'RECOVERED') {
    throw new WalletAccessError(`Wallet is ${wallet.state}. Activation not permitted.`);
  }

  // 1. Password
  validateWalletPassword(params.walletPassword, {
    loginPasswordHash: params.loginPasswordHash,
  });
  const pw = hashWalletPassword(params.walletPassword);

  // 2. Seed phrase
  const words = (params.seedPhraseWords ?? [])
    .map((w) => (w ?? '').trim().toLowerCase())
    .filter(Boolean);
  if (words.length !== SEED_PHRASE_WORD_COUNT) {
    throw new InvalidSeedPhrase(
      `Seed phrase must be exactly ${SEED_PHRASE_WORD_COUNT} words.`,
    );
  }
  const seedHash = hashSeedPhrase(words);

  // 3. Holder type
  if (params.holderType !== 'INDIVIDUAL' && params.holderType !== 'LEGAL_PERSON') {
    throw new WalletAccessError('Invalid holderType.');
  }
  if (params.holderType === 'LEGAL_PERSON') {
    if (!params.legalEntityName) {
      throw new WalletAccessError('legalEntityName is required for legal-person wallets.');
    }
    if (params.entityType && !VALID_ENTITY_TYPES.has(params.entityType)) {
      throw new WalletAccessError('Invalid entityType.');
    }
  }

  // 4. Nominees
  const nominees = params.nominees ?? [];
  if (params.holderType === 'INDIVIDUAL') {
    if (nominees.length < 2) {
      throw new NomineePolicyViolation(
        'At least two nominees are required for individual wallets.',
      );
    }
    const total = nominees.reduce((s, n) => {
      const v = new Prisma.Decimal(String(n.share_percent ?? 0));
      if (v.lte(0)) {
        throw new NomineePolicyViolation('Every nominee must have a positive share.');
      }
      return s.plus(v);
    }, new Prisma.Decimal(0));
    if (!total.equals(100)) {
      throw new NomineePolicyViolation(
        `Nominee shares must total 100% (got ${total.toString()}).`,
      );
    }
  } else if (nominees.length > 0) {
    const total = nominees.reduce(
      (s, n) => s.plus(new Prisma.Decimal(String(n.share_percent ?? 0))),
      new Prisma.Decimal(0),
    );
    if (!total.equals(100)) {
      throw new NomineePolicyViolation(
        `If nominees are provided, shares must total 100% (got ${total.toString()}).`,
      );
    }
  }

  // 5-7. Apply atomically
  const result = await prisma.$transaction(async (tx) => {
    // Device
    await tx.walletDevice.create({
      data: {
        walletId: wallet.id,
        deviceIdHash: params.deviceIdHash,
        deviceLabel: (params.deviceLabel ?? '').slice(0, 100),
        platform: (params.platform ?? '').slice(0, 20),
        state: 'ACTIVE',
        coolingOffUntil: null,
        activatedAt: new Date(),
      },
    });

    // Nominees
    for (const n of nominees) {
      await tx.walletNominee.create({
        data: {
          walletId: wallet.id,
          name: (n.name ?? '').slice(0, 200),
          relationship: (n.relationship ?? '').slice(0, 60),
          email: (n.email ?? '').slice(0, 254),
          mobile: (n.mobile ?? '').slice(0, 20),
          idDocumentHash: (n.id_document_hash ?? '').slice(0, 66),
          sharePercent: new Prisma.Decimal(String(n.share_percent ?? 0)),
          socialRecoveryThreshold: n.social_recovery_threshold ?? 2,
          active: true,
        },
      });
    }

    // Activate
    const updated = await tx.walletActivation.update({
      where: { id: wallet.id },
      data: {
        passwordHash: pw.hash,
        passwordSalt: pw.salt,
        passwordAlgo: pw.algo,
        passwordIterations: pw.iterations,
        seedPhraseHash: seedHash,
        seedPhraseConfirmed: true,
        seedPhraseConfirmedAt: new Date(),
        holderType: params.holderType,
        legalEntityName:
          params.holderType === 'LEGAL_PERSON'
            ? (params.legalEntityName ?? '').slice(0, 200)
            : '',
        entityType:
          params.holderType === 'LEGAL_PERSON' && params.entityType
            ? (params.entityType as any)
            : 'UNSPECIFIED',
        state: 'ACTIVATED',
        activatedAt: new Date(),
        lastActivityAt: new Date(),
        failedPasswordAttempts: 0,
        lockedUntil: null,
      },
    });
    return updated;
  });

  // Notifications (best-effort, outside tx)
  await notify({ participantId: params.participantId }, 'wallet.activated', {
    wallet_address: result.walletAddress,
  }).catch(() => undefined);

  // Defensive wipe of plaintext local references (cannot clear the caller's
  // argument binding, but we zero what we can).
  params.walletPassword = '***';
  params.seedPhraseWords = [];

  return getWalletInfo(params.participantId);
}

// ─────────────────────────────────────────────────────────────────────────────
// PASSWORD
// ─────────────────────────────────────────────────────────────────────────────

async function requireWallet(participantId: string) {
  const w = await prisma.walletActivation.findUnique({ where: { participantId } });
  if (!w) throw new WalletNotFound();
  return w;
}

async function registerFailedAttempt(walletId: string) {
  await prisma.walletActivation.update({
    where: { id: walletId },
    data: {
      failedPasswordAttempts: { increment: 1 },
    },
  });
  const fresh = await prisma.walletActivation.findUnique({ where: { id: walletId } });
  if (fresh && fresh.failedPasswordAttempts >= MAX_FAILED_PASSWORD_ATTEMPTS) {
    await prisma.walletActivation.update({
      where: { id: walletId },
      data: {
        state: 'LOCKED',
        lockedUntil: addMs(LOCK_DURATION_MS),
      },
    });
  }
}

export async function changeWalletPassword(
  participantId: string,
  oldPassword: string,
  newPassword: string,
  loginPasswordHash?: string | null,
): Promise<void> {
  const wallet = await requireWallet(participantId);
  if (wallet.state !== 'ACTIVATED') {
    throw new WalletNotTransactable(blockingReasonFor(wallet.state));
  }
  if (!verifyPwHash(oldPassword, wallet.passwordHash)) {
    await registerFailedAttempt(wallet.id);
    throw new InvalidPassword('Current wallet password is incorrect.');
  }
  validateWalletPassword(newPassword, { loginPasswordHash });
  const pw = hashWalletPassword(newPassword);
  await prisma.walletActivation.update({
    where: { id: wallet.id },
    data: {
      passwordHash: pw.hash,
      passwordSalt: pw.salt,
      failedPasswordAttempts: 0,
      lockedUntil: null,
    },
  });
  await notify({ participantId }, 'wallet.unusual_activity', {
    wallet_address: wallet.walletAddress,
    description: 'Your wallet password was changed.',
  }).catch(() => undefined);
}

export async function verifyWalletPassword(
  participantId: string,
  password: string,
): Promise<boolean> {
  const wallet = await requireWallet(participantId);

  if (wallet.state === 'LOCKED') {
    if (wallet.lockedUntil && wallet.lockedUntil.getTime() > Date.now()) {
      throw new WalletLocked(blockingReasonFor(wallet.state));
    }
    await prisma.walletActivation.update({
      where: { id: wallet.id },
      data: {
        state: wallet.passwordHash ? 'ACTIVATED' : 'CREATED',
        lockedUntil: null,
        failedPasswordAttempts: 0,
      },
    });
  }
  if (!wallet.passwordHash) throw new WalletNotTransactable('Wallet has not been activated.');

  if (verifyPwHash(password, wallet.passwordHash)) {
    if (wallet.failedPasswordAttempts) {
      await prisma.walletActivation.update({
        where: { id: wallet.id },
        data: { failedPasswordAttempts: 0 },
      });
    }
    return true;
  }
  await registerFailedAttempt(wallet.id);
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// NOMINEES (post-activation update)
// ─────────────────────────────────────────────────────────────────────────────

export async function updateNominees(
  participantId: string,
  nominees: NomineeInput[],
  walletPassword: string,
): Promise<void> {
  const wallet = await requireWallet(participantId);
  if (!(await verifyWalletPassword(participantId, walletPassword))) {
    throw new InvalidPassword();
  }
  if (!nominees || nominees.length < 2) {
    throw new NomineePolicyViolation('At least two nominees are required.');
  }
  const total = nominees.reduce(
    (s, n) => s.plus(new Prisma.Decimal(String(n.share_percent ?? 0))),
    new Prisma.Decimal(0),
  );
  if (!total.equals(100)) {
    throw new NomineePolicyViolation(
      `Nominee shares must total 100% (got ${total.toString()}).`,
    );
  }
  await prisma.$transaction(async (tx) => {
    await tx.walletNominee.updateMany({
      where: { walletId: wallet.id, active: true },
      data: { active: false, revokedAt: new Date(), revokeReason: 'Replaced by user update' },
    });
    for (const n of nominees) {
      await tx.walletNominee.create({
        data: {
          walletId: wallet.id,
          name: (n.name ?? '').slice(0, 200),
          relationship: (n.relationship ?? '').slice(0, 60),
          email: (n.email ?? '').slice(0, 254),
          mobile: (n.mobile ?? '').slice(0, 20),
          idDocumentHash: (n.id_document_hash ?? '').slice(0, 66),
          sharePercent: new Prisma.Decimal(String(n.share_percent ?? 0)),
          socialRecoveryThreshold: n.social_recovery_threshold ?? 2,
          active: true,
        },
      });
    }
  });
}

export async function listNominees(participantId: string) {
  const wallet = await prisma.walletActivation.findUnique({
    where: { participantId },
    include: { nominees: { where: { active: true } } },
  });
  if (!wallet) return [];
  return wallet.nominees.map((n) => ({
    id: n.id,
    name: n.name,
    relationship: n.relationship,
    email: n.email,
    mobile: n.mobile,
    share_percent: n.sharePercent.toString(),
    social_recovery_threshold: n.socialRecoveryThreshold,
    active: n.active,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// DEVICES
// ─────────────────────────────────────────────────────────────────────────────

export async function listDevices(participantId: string) {
  const wallet = await prisma.walletActivation.findUnique({
    where: { participantId },
    include: { devices: { orderBy: { boundAt: 'desc' } } },
  });
  if (!wallet) return [];
  return wallet.devices.map((d) => ({
    id: d.id,
    device_id_hash: d.deviceIdHash,
    device_label: d.deviceLabel,
    platform: d.platform,
    state: d.state,
    cooling_off_until: d.coolingOffUntil?.toISOString() ?? null,
    bound_at: d.boundAt.toISOString(),
    activated_at: d.activatedAt?.toISOString() ?? null,
    retired_at: d.retiredAt?.toISOString() ?? null,
  }));
}

export async function bindNewDevice(
  participantId: string,
  opts: { deviceIdHash: string; deviceLabel?: string; platform?: string; walletPassword: string },
) {
  const wallet = await requireWallet(participantId);
  if (wallet.state !== 'ACTIVATED' && wallet.state !== 'CREATED') {
    throw new WalletNotTransactable(blockingReasonFor(wallet.state));
  }
  if (!(await verifyWalletPassword(participantId, opts.walletPassword))) {
    throw new InvalidPassword();
  }
  const device = await prisma.$transaction(async (tx) => {
    await tx.walletDevice.updateMany({
      where: { walletId: wallet.id, state: 'ACTIVE' },
      data: { state: 'RETIRED', retiredAt: new Date() },
    });
    return tx.walletDevice.create({
      data: {
        walletId: wallet.id,
        deviceIdHash: opts.deviceIdHash,
        deviceLabel: (opts.deviceLabel ?? '').slice(0, 100),
        platform: (opts.platform ?? '').slice(0, 20),
        state: 'ACTIVE',
        coolingOffUntil: addMs(DEVICE_COOLING_OFF_MS),
      },
    });
  });
  await notify({ participantId }, 'wallet.unusual_activity', {
    wallet_address: wallet.walletAddress,
    description: `A new device (${device.deviceLabel || 'unnamed'}) was bound to your wallet. It can transact after the cooling-off period.`,
  }).catch(() => undefined);
  return device;
}

export async function revokeDevice(
  participantId: string,
  deviceId: string,
  walletPassword: string,
): Promise<void> {
  const wallet = await requireWallet(participantId);
  if (!(await verifyWalletPassword(participantId, walletPassword))) {
    throw new InvalidPassword();
  }
  const device = await prisma.walletDevice.findFirst({
    where: { id: deviceId, walletId: wallet.id },
  });
  if (!device) throw new WalletAccessError('Device not found.', 'device_not_found', 404);
  await prisma.walletDevice.update({
    where: { id: device.id },
    data: { state: 'REVOKED', retiredAt: new Date() },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// EMERGENCY FREEZE
// ─────────────────────────────────────────────────────────────────────────────

export async function emergencyFreeze(participantId: string, reason: string): Promise<void> {
  const wallet = await requireWallet(participantId);
  if (wallet.state === 'SUSPENDED' || wallet.state === 'RECOVERED') return;
  await prisma.walletActivation.update({
    where: { id: wallet.id },
    data: { state: 'SUSPENDED' },
  });
  await notify({ participantId }, 'wallet.unusual_activity', {
    wallet_address: wallet.walletAddress,
    description: `Wallet frozen by user. Reason: ${(reason || '').slice(0, 200)}`,
  }).catch(() => undefined);
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTIVITY + INACTIVITY WATCHDOG
// ─────────────────────────────────────────────────────────────────────────────

export async function touchActivity(participantId: string): Promise<void> {
  const wallet = await prisma.walletActivation.findUnique({ where: { participantId } });
  if (!wallet) return;
  await prisma.walletActivation.update({
    where: { id: wallet.id },
    data: {
      lastActivityAt: new Date(),
      inactivityPromptSentAt: null,
      inactivityReminderSentAt: null,
      nomineesAlertedAt: null,
    },
  });
}

export async function confirmLiveness(participantId: string) {
  const wallet = await requireWallet(participantId);
  await touchActivity(participantId);
  return prisma.walletInactivityEvent.create({
    data: {
      walletId: wallet.id,
      kind: 'CONFIRMED',
      detail: 'User confirmed active status.',
    },
  });
}

export async function listInactivityEvents(participantId: string) {
  const wallet = await prisma.walletActivation.findUnique({
    where: { participantId },
    include: { inactivityEvents: { orderBy: { occurredAt: 'desc' }, take: 40 } },
  });
  if (!wallet) return [];
  return wallet.inactivityEvents.map((e) => ({
    id: e.id,
    kind: e.kind,
    occurred_at: e.occurredAt.toISOString(),
    detail: e.detail,
  }));
}

export async function sweepInactivity(): Promise<{
  prompted: number;
  reminded: number;
  nomineesAlerted: number;
}> {
  const stats = { prompted: 0, reminded: 0, nomineesAlerted: 0 };
  const now = Date.now();

  const wallets = await prisma.walletActivation.findMany({
    where: { state: 'ACTIVATED' },
    include: { nominees: { where: { active: true } } },
  });

  for (const w of wallets) {
    const last = w.lastActivityAt ?? w.activatedAt ?? w.createdAt;
    if (!last) continue;
    const silentMs = now - last.getTime();

    // Stage 3: nominees alerted
    if (
      w.inactivityReminderSentAt &&
      !w.nomineesAlertedAt &&
      now - w.inactivityReminderSentAt.getTime() >= INACTIVITY_NOMINEES_AFTER_REMINDER_MS
    ) {
      for (const nom of w.nominees) {
        await notify(
          { email: nom.email, mobile: nom.mobile, name: nom.name },
          'wallet.inactivity_nominee_alert',
          {
            wallet_address: w.walletAddress,
            nominee_name: nom.name,
          },
        ).catch(() => undefined);
      }
      await prisma.walletActivation.update({
        where: { id: w.id },
        data: { nomineesAlertedAt: new Date() },
      });
      await prisma.walletInactivityEvent.create({
        data: {
          walletId: w.id,
          kind: 'NOMINEES_ALERTED',
          detail: `Silent since ${last.toISOString()}`,
        },
      });
      stats.nomineesAlerted++;
      continue;
    }

    // Stage 2: reminder
    if (
      w.inactivityPromptSentAt &&
      !w.inactivityReminderSentAt &&
      now - w.inactivityPromptSentAt.getTime() >= INACTIVITY_REMINDER_AFTER_PROMPT_MS
    ) {
      await notify({ participantId: w.participantId }, 'wallet.inactivity_reminder', {
        wallet_address: w.walletAddress,
      }).catch(() => undefined);
      await prisma.walletActivation.update({
        where: { id: w.id },
        data: { inactivityReminderSentAt: new Date() },
      });
      await prisma.walletInactivityEvent.create({
        data: {
          walletId: w.id,
          kind: 'REMINDER_SENT',
          detail: 'Reminder after no response to inactivity prompt.',
        },
      });
      stats.reminded++;
      continue;
    }

    // Stage 1: first prompt
    if (silentMs >= INACTIVITY_PROMPT_AFTER_MS && !w.inactivityPromptSentAt) {
      await notify({ participantId: w.participantId }, 'wallet.inactivity_prompt', {
        wallet_address: w.walletAddress,
        silent_for_days: Math.floor(silentMs / (24 * 60 * 60 * 1000)),
      }).catch(() => undefined);
      await prisma.walletActivation.update({
        where: { id: w.id },
        data: { inactivityPromptSentAt: new Date() },
      });
      await prisma.walletInactivityEvent.create({
        data: {
          walletId: w.id,
          kind: 'PROMPT_SENT',
          detail: `Silent for ${Math.floor(silentMs / (24 * 60 * 60 * 1000))} days.`,
        },
      });
      stats.prompted++;
    }
  }
  return stats;
}

// ─────────────────────────────────────────────────────────────────────────────
// RECOVERY
// ─────────────────────────────────────────────────────────────────────────────

export async function initiateSelfRecovery(
  participantId: string,
  seedPhraseWords: string[],
  newDeviceIdHash: string,
  newDeviceLabel = '',
  newPlatform = '',
) {
  const wallet = await requireWallet(participantId);
  if (wallet.state === 'SUSPENDED' || wallet.state === 'RECOVERED') {
    throw new WalletNotTransactable(blockingReasonFor(wallet.state));
  }
  const candidate = hashSeedPhrase(seedPhraseWords);
  if (candidate !== wallet.seedPhraseHash) {
    throw new InvalidSeedPhrase('Seed phrase does not match our records.');
  }
  const result = await prisma.$transaction(async (tx) => {
    const caseRow = await tx.walletRecoveryCase.create({
      data: {
        originalWalletId: wallet.id,
        path: 'SELF',
        status: 'EXECUTED',
        claimantParticipantId: participantId,
        claimantWalletAddress: wallet.walletAddress,
        grounds: 'Self-recovery via seed phrase on new device.',
      },
    });
    await tx.walletDevice.updateMany({
      where: { walletId: wallet.id, state: 'ACTIVE' },
      data: { state: 'RETIRED', retiredAt: new Date() },
    });
    await tx.walletDevice.create({
      data: {
        walletId: wallet.id,
        deviceIdHash: newDeviceIdHash,
        deviceLabel: (newDeviceLabel || '').slice(0, 100),
        platform: (newPlatform || '').slice(0, 20),
        state: 'ACTIVE',
        coolingOffUntil: addMs(DEVICE_COOLING_OFF_MS),
      },
    });
    return caseRow;
  });
  await notify({ participantId }, 'wallet.unusual_activity', {
    wallet_address: wallet.walletAddress,
    description: 'Self-recovery completed on a new device. Cooling-off is in effect.',
  }).catch(() => undefined);
  return result;
}

export async function initiateSocialRecovery(args: {
  claimantParticipantId: string;
  claimantContactEmail?: string;
  claimantContactMobile?: string;
  originalWalletAddress: string;
  claimantWalletAddress: string;
  grounds: string;
}) {
  const original = await prisma.walletActivation.findUnique({
    where: { walletAddress: args.originalWalletAddress },
    include: { nominees: { where: { active: true } } },
  });
  if (!original) throw new WalletNotFound('Original wallet not found.');
  if (original.state === 'RECOVERED' || original.state === 'SUSPENDED') {
    throw new WalletNotTransactable(blockingReasonFor(original.state));
  }

  // Verify claimant is a nominee (by email or mobile match).
  const isNominee = original.nominees.some(
    (n) =>
      (args.claimantContactEmail && n.email && n.email.toLowerCase() === args.claimantContactEmail.toLowerCase()) ||
      (args.claimantContactMobile && n.mobile && n.mobile === args.claimantContactMobile),
  );
  if (!isNominee) {
    throw new RecoveryError('Only a registered nominee may file social recovery.');
  }

  const now = new Date();
  const caseRow = await prisma.$transaction(async (tx) => {
    const c = await tx.walletRecoveryCase.create({
      data: {
        originalWalletId: original.id,
        path: 'SOCIAL',
        status: 'NOTIFIED',
        claimantParticipantId: args.claimantParticipantId,
        claimantWalletAddress: args.claimantWalletAddress,
        grounds: args.grounds.slice(0, 2000),
        coolingOffEndsAt: addMs(SOCIAL_RECOVERY_COOLING_OFF_MS),
      },
    });
    await tx.walletActivation.update({
      where: { id: original.id },
      data: { state: 'RECOVERING' },
    });
    return c;
  });

  await notify({ participantId: original.participantId }, 'recovery.initiated', {
    wallet_address: original.walletAddress,
    path: 'SOCIAL',
    filed_at: now.toISOString(),
    case_id: caseRow.id,
    cooling_off_ends_at: caseRow.coolingOffEndsAt?.toISOString() ?? '',
  }).catch(() => undefined);

  return caseRow;
}

export async function initiateTrusteeRecovery(args: {
  claimantParticipantId: string;
  originalWalletAddress: string;
  claimantWalletAddress: string;
  grounds: string;
  evidenceBundleHash: string;
  blockchainFiler?: (caseId: string, originalWallet: string, claimantWallet: string, evidenceHash: string) => Promise<string>;
}) {
  const original = await prisma.walletActivation.findUnique({
    where: { walletAddress: args.originalWalletAddress },
  });
  if (!original) throw new WalletNotFound('Original wallet not found.');
  if (original.state === 'RECOVERED') {
    throw new WalletNotTransactable('Wallet already recovered.');
  }

  const now = new Date();
  const caseRow = await prisma.$transaction(async (tx) => {
    const c = await tx.walletRecoveryCase.create({
      data: {
        originalWalletId: original.id,
        path: 'TRUSTEE',
        status: 'AWAITING_OMBUDSMAN',
        claimantParticipantId: args.claimantParticipantId,
        claimantWalletAddress: args.claimantWalletAddress,
        grounds: args.grounds.slice(0, 2000),
        evidenceBundleHash: args.evidenceBundleHash.slice(0, 66),
        publicNoticeEndsAt: addMs(TRUSTEE_PUBLIC_NOTICE_MS),
      },
    });
    await tx.walletActivation.update({
      where: { id: original.id },
      data: { state: 'RECOVERING' },
    });
    return c;
  });

  // Emit on-chain WalletRecoveryRequested
  if (args.blockchainFiler) {
    try {
      const txHash = await args.blockchainFiler(
        caseRow.id,
        original.walletAddress,
        args.claimantWalletAddress || '0x' + '0'.repeat(40),
        args.evidenceBundleHash,
      );
      await prisma.walletRecoveryCase.update({
        where: { id: caseRow.id },
        data: { recoveryRequestedTxHash: txHash },
      });
    } catch (err: any) {
      // Log only — never fail the case filing because of chain issues.
      console.warn('[wallet_access] blockchain filer failed:', err?.message || err);
    }
  }

  await notify({ participantId: original.participantId }, 'recovery.initiated', {
    wallet_address: original.walletAddress,
    path: 'TRUSTEE',
    filed_at: now.toISOString(),
    case_id: caseRow.id,
    cooling_off_ends_at: caseRow.publicNoticeEndsAt?.toISOString() ?? '',
  }).catch(() => undefined);
  return caseRow;
}

export async function cancelRecovery(
  participantId: string,
  caseId: string,
  reason: string,
) {
  const wallet = await requireWallet(participantId);
  const caseRow = await prisma.walletRecoveryCase.findFirst({
    where: { id: caseId, originalWalletId: wallet.id },
  });
  if (!caseRow) throw new RecoveryError('Recovery case not found.');
  if (['EXECUTED', 'CANCELLED', 'REJECTED', 'EXPIRED'].includes(caseRow.status)) {
    throw new RecoveryError(`Case already ${caseRow.status}.`);
  }
  if (
    caseRow.path === 'SOCIAL' &&
    caseRow.coolingOffEndsAt &&
    caseRow.coolingOffEndsAt.getTime() < Date.now()
  ) {
    throw new RecoveryError('Cooling-off period has elapsed.');
  }
  const updated = await prisma.$transaction(async (tx) => {
    const c = await tx.walletRecoveryCase.update({
      where: { id: caseRow.id },
      data: {
        status: 'CANCELLED',
        grounds: (caseRow.grounds + `\n\nCancelled by owner: ${reason.slice(0, 500)}`).trim(),
      },
    });
    await tx.walletActivation.update({
      where: { id: wallet.id },
      data: { state: wallet.passwordHash ? 'ACTIVATED' : 'CREATED' },
    });
    return c;
  });
  await notify({ participantId }, 'recovery.cancelled', {
    wallet_address: wallet.walletAddress,
    case_id: updated.id,
  }).catch(() => undefined);
  return updated;
}

export async function listRecoveryCases(participantId: string) {
  const wallet = await prisma.walletActivation.findUnique({
    where: { participantId },
    include: { recoveryCases: { orderBy: { createdAt: 'desc' }, take: 50 } },
  });
  if (!wallet) return [];
  return wallet.recoveryCases.map((c) => ({
    id: c.id,
    path: c.path,
    status: c.status,
    claimant_wallet_address: c.claimantWalletAddress,
    grounds: c.grounds.slice(0, 500),
    cooling_off_ends_at: c.coolingOffEndsAt?.toISOString() ?? null,
    public_notice_ends_at: c.publicNoticeEndsAt?.toISOString() ?? null,
    execution_tx_hash: c.executionTxHash,
    reversibility_ends_at: c.reversibilityEndsAt?.toISOString() ?? null,
    created_at: c.createdAt.toISOString(),
  }));
}

export async function executeOmbudsmanOrder(args: {
  caseId: string;
  orderHash: string;
  orderTxHash: string;
  disposition: 'APPROVE' | 'APPROVE_MODIFIED' | 'REJECT' | 'REMAND' | 'ESCALATE_COURT';
}) {
  const caseRow = await prisma.walletRecoveryCase.findUnique({ where: { id: args.caseId } });
  if (!caseRow) throw new RecoveryError(`No local case ${args.caseId}.`);

  if (args.disposition === 'REJECT') {
    await prisma.$transaction(async (tx) => {
      await tx.walletRecoveryCase.update({
        where: { id: caseRow.id },
        data: {
          status: 'REJECTED',
          ombudsmanOrderHash: args.orderHash,
          ombudsmanOrderTxHash: args.orderTxHash,
        },
      });
      const w = await tx.walletActivation.findUnique({ where: { id: caseRow.originalWalletId } });
      if (w) {
        await tx.walletActivation.update({
          where: { id: w.id },
          data: { state: w.passwordHash ? 'ACTIVATED' : 'CREATED' },
        });
      }
    });
    return caseRow;
  }
  if (args.disposition === 'APPROVE' || args.disposition === 'APPROVE_MODIFIED') {
    await prisma.$transaction(async (tx) => {
      await tx.walletRecoveryCase.update({
        where: { id: caseRow.id },
        data: {
          status: 'EXECUTED',
          ombudsmanOrderHash: args.orderHash,
          ombudsmanOrderTxHash: args.orderTxHash,
          executionTxHash: args.orderTxHash,
          reversibilityEndsAt: addMs(REVERSIBILITY_WINDOW_MS),
        },
      });
      await tx.walletActivation.update({
        where: { id: caseRow.originalWalletId },
        data: { state: 'RECOVERED' },
      });
    });
    return caseRow;
  }
  // REMAND / ESCALATE_COURT — record order, leave status
  return prisma.walletRecoveryCase.update({
    where: { id: caseRow.id },
    data: {
      ombudsmanOrderHash: args.orderHash,
      ombudsmanOrderTxHash: args.orderTxHash,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// OWNERSHIP TRANSFER (legal-person wallets)
// ─────────────────────────────────────────────────────────────────────────────

const VALID_REASONS = new Set([
  'ACQUISITION',
  'PARTNERSHIP_CHANGE',
  'TRUSTEE_SUCCESSION',
  'PROP_SALE',
  'OPERATOR_DEPARTED',
  'OTHER',
]);

export async function initiateOwnershipTransfer(args: {
  outgoingParticipantId: string;
  incomingParticipantId?: string | null;
  reason: string;
  grounds: string;
  evidenceBundleHash: string;
  blockchainFiler?: (caseId: string, wallet: string, evidenceHash: string) => Promise<string>;
}) {
  const wallet = await requireWallet(args.outgoingParticipantId);
  if (wallet.holderType !== 'LEGAL_PERSON') {
    throw new OwnershipTransferError(
      'Ownership transfer is only applicable to legal-person wallets.',
    );
  }
  if (['RECOVERING', 'OWNERSHIP_TRANSFER', 'RECOVERED', 'SUSPENDED'].includes(wallet.state)) {
    throw new OwnershipTransferError(
      `Wallet is in state ${wallet.state}; transfer cannot be filed now.`,
    );
  }
  if (!VALID_REASONS.has(args.reason)) {
    throw new OwnershipTransferError('Invalid transfer reason.');
  }
  const caseRow = await prisma.$transaction(async (tx) => {
    const c = await tx.walletOwnershipTransferCase.create({
      data: {
        walletId: wallet.id,
        status: 'AWAITING_OMBUDSMAN',
        outgoingOperatorParticipantId: args.outgoingParticipantId,
        incomingOperatorParticipantId: args.incomingParticipantId ?? null,
        reason: args.reason as any,
        grounds: args.grounds.slice(0, 2000),
        evidenceBundleHash: args.evidenceBundleHash.slice(0, 66),
        publicNoticeEndsAt: addMs(OWNERSHIP_TRANSFER_NOTICE_MS),
      },
    });
    await tx.walletActivation.update({
      where: { id: wallet.id },
      data: { state: 'OWNERSHIP_TRANSFER' },
    });
    return c;
  });
  if (args.blockchainFiler) {
    try {
      const txHash = await args.blockchainFiler(
        `ownership:${caseRow.id}`,
        wallet.walletAddress,
        args.evidenceBundleHash,
      );
      await prisma.walletOwnershipTransferCase.update({
        where: { id: caseRow.id },
        data: { transferRequestedTxHash: txHash },
      });
    } catch (err: any) {
      console.warn('[wallet_access] ownership filer failed:', err?.message || err);
    }
  }
  await notify({ participantId: args.outgoingParticipantId }, 'ownership.transfer_filed', {
    wallet_address: wallet.walletAddress,
    case_id: caseRow.id,
    reason: args.reason,
  }).catch(() => undefined);
  return caseRow;
}

export async function cancelOwnershipTransfer(
  participantId: string,
  caseId: string,
  reason: string,
) {
  const wallet = await requireWallet(participantId);
  const caseRow = await prisma.walletOwnershipTransferCase.findFirst({
    where: { id: caseId, walletId: wallet.id },
  });
  if (!caseRow) throw new OwnershipTransferError('Transfer case not found.');
  if (['EXECUTED', 'CANCELLED', 'REJECTED', 'EXPIRED'].includes(caseRow.status)) {
    throw new OwnershipTransferError(`Case already ${caseRow.status}.`);
  }
  const updated = await prisma.$transaction(async (tx) => {
    const c = await tx.walletOwnershipTransferCase.update({
      where: { id: caseRow.id },
      data: {
        status: 'CANCELLED',
        grounds: (caseRow.grounds + `\n\nCancelled: ${reason.slice(0, 500)}`).trim(),
      },
    });
    await tx.walletActivation.update({
      where: { id: wallet.id },
      data: { state: wallet.passwordHash ? 'ACTIVATED' : 'CREATED' },
    });
    return c;
  });
  await notify({ participantId }, 'ownership.transfer_cancelled', {
    wallet_address: wallet.walletAddress,
    case_id: updated.id,
  }).catch(() => undefined);
  return updated;
}

export async function listOwnershipTransfers(participantId: string) {
  const wallet = await prisma.walletActivation.findUnique({
    where: { participantId },
    include: { ownershipTransfers: { orderBy: { createdAt: 'desc' }, take: 50 } },
  });
  if (!wallet) return [];
  return wallet.ownershipTransfers.map((c) => ({
    id: c.id,
    status: c.status,
    reason: c.reason,
    grounds: c.grounds.slice(0, 500),
    public_notice_ends_at: c.publicNoticeEndsAt?.toISOString() ?? null,
    transfer_requested_tx_hash: c.transferRequestedTxHash,
    ombudsman_order_hash: c.ombudsmanOrderHash,
    created_at: c.createdAt.toISOString(),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV EXPORT (transaction history)
// ─────────────────────────────────────────────────────────────────────────────

export async function transactionsToCsv(
  participantId: string,
  filters: { module?: string; status?: string } = {},
): Promise<string> {
  const where: any = { actorParticipantId: participantId };
  if (filters.module) where.module = filters.module;
  if (filters.status) where.status = filters.status;

  const rows = await prisma.chainTxAudit.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 10000,
  });

  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };

  const header = [
    'created_at',
    'module',
    'action',
    'mode',
    'chain_id',
    'to_address',
    'tx_hash',
    'block_number',
    'status',
    'client_tx_id',
    'confirmed_at',
  ];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      [
        esc(r.createdAt.toISOString()),
        esc(r.module),
        esc(r.action),
        esc(r.mode),
        esc(r.chainId),
        esc(r.toAddress),
        esc(r.txHash),
        esc(r.blockNumber ?? ''),
        esc(r.status),
        esc(r.clientTxId),
        esc(r.confirmedAt?.toISOString() ?? ''),
      ].join(','),
    );
  }
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// STATUS BANNER (drives the dashboard alert)
// ─────────────────────────────────────────────────────────────────────────────

export async function statusBanner(participantId: string): Promise<{
  banner: { level: string; message: string; cta_label: string | null; cta_route: string | null } | null;
}> {
  const wallet = await prisma.walletActivation.findUnique({
    where: { participantId },
    include: { nominees: { where: { active: true } } },
  });
  if (!wallet) return { banner: null };

  switch (wallet.state) {
    case 'CREATED':
      return {
        banner: {
          level: 'warning',
          message:
            'Your wallet is not yet activated. Set your wallet password and register nominees before you can transact.',
          cta_label: 'Activate Wallet',
          cta_route: '/wallet/activate',
        },
      };
    case 'LOCKED':
      return {
        banner: {
          level: 'danger',
          message: 'Your wallet is locked due to repeated failed password attempts.',
          cta_label: 'Unlock',
          cta_route: '/wallet/unlock',
        },
      };
    case 'RECOVERING':
      return {
        banner: {
          level: 'danger',
          message:
            'A recovery is in progress on your wallet. If this was not you, cancel immediately.',
          cta_label: 'Review Recovery',
          cta_route: '/wallet/recovery',
        },
      };
    case 'OWNERSHIP_TRANSFER':
      return {
        banner: {
          level: 'danger',
          message: 'An ownership transfer is in progress. Transactions paused until resolved.',
          cta_label: 'Review Transfer',
          cta_route: '/wallet/ownership',
        },
      };
    case 'SUSPENDED':
      return {
        banner: {
          level: 'danger',
          message: 'Your wallet is suspended. Contact support.',
          cta_label: 'Contact Support',
          cta_route: '/support',
        },
      };
    case 'RECOVERED':
      return {
        banner: {
          level: 'info',
          message: 'This wallet has been recovered to another address.',
          cta_label: null,
          cta_route: null,
        },
      };
  }

  // ACTIVATED — policy-driven banners
  if (wallet.holderType === 'INDIVIDUAL' && wallet.nominees.length < 2) {
    return {
      banner: {
        level: 'warning',
        message: 'Register at least two nominees to protect your assets.',
        cta_label: 'Manage Nominees',
        cta_route: '/wallet/nominees',
      },
    };
  }
  return { banner: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// HEIR GUIDE (public content — no auth)
// ─────────────────────────────────────────────────────────────────────────────

export function heirGuide() {
  return {
    title: 'How to recover an IRG wallet for a family member',
    intro:
      'If someone you love held assets in an IRG wallet and has passed away, ' +
      'become incapacitated, or lost access in a way that cannot be resolved, ' +
      'this guide explains how to claim those assets on their behalf.',
    steps: [
      {
        heading: '1. Gather documentation',
        body:
          'Depending on the situation you may need: death certificate, succession ' +
          'certificate or legal heir certificate, court-issued letter of administration, ' +
          'a registered nominee document, or a probated will.',
      },
      {
        heading: '2. File a trustee-path recovery case',
        body:
          'From the IRG login screen choose "Recover Someone Else\'s Wallet". You will be ' +
          'asked for the wallet address (if known), your relationship, and to upload supporting documents.',
      },
      {
        heading: '3. Public notice period',
        body:
          'For 30 days a public on-chain notice will be posted so any other claimant or objection can be heard.',
      },
      {
        heading: '4. Ombudsman review',
        body:
          'The IRG Ombudsman will review the file, may hold a hearing, and will issue a reasoned Order.',
      },
      {
        heading: '5. Execution',
        body:
          'If the Ombudsman approves, assets transfer to the wallet you control. A 90-day reversibility window applies.',
      },
    ],
    contact:
      'For help with any step, contact the IRG Ombudsman office via the "Recovery" menu item.',
  };
}
