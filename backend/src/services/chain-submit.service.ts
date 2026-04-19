/**
 * IRG Chain 888101 — Node/Express submission gateway.
 *
 * TypeScript counterpart to the Django `chain.client` module in the GDP
 * backend. Every FTR module (registration, swap, redemption, ROI, admin,
 * minters) that wants to push a transaction onto IRG Chain 888101 calls
 * into this service. It:
 *
 *   1. Writes a PENDING `ChainTxAudit` row to Postgres via Prisma.
 *   2. HMAC-signs the body with MIDDLEWARE_SHARED_SECRET (same secret the
 *      Django backend uses — both talk to the same middleware instance).
 *   3. POSTs to /submit-tx on the middleware with retry + exponential
 *      backoff.
 *   4. Updates the audit row to SUBMITTED (with tx hash), or to
 *      SIMULATED if the middleware is unreachable and simulate-mode is
 *      allowed, or FAILED otherwise.
 *
 * Two public helpers:
 *   - systemSubmit(tx) — backend-originated transaction, middleware
 *                        signs with its operator key.
 *   - rawSubmit(tx)    — device-signed, middleware only forwards.
 *
 * IPR Owner: Rohit Tidke | (c) 2026 Intech Research Group
 */

import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const CHAIN_ID = parseInt(process.env.IRG_CHAIN_ID || '888101', 10);
const MIDDLEWARE_URL = (process.env.IRG_CHAIN_MIDDLEWARE_URL || '').replace(/\/$/, '');
const SHARED_SECRET = process.env.IRG_CHAIN_MIDDLEWARE_SECRET || '';
const TIMEOUT_MS = parseInt(process.env.IRG_CHAIN_SUBMIT_TIMEOUT_MS || '15000', 10);
const MAX_RETRIES = parseInt(process.env.IRG_CHAIN_SUBMIT_RETRIES || '3', 10);
const ALLOW_SIMULATE = (process.env.IRG_CHAIN_ALLOW_SIMULATE || 'true').toLowerCase() === 'true';

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export type ChainSubmitStatus = 'SUBMITTED' | 'SIMULATED' | 'FAILED';

export interface SystemTx {
  module: string;            // e.g. 'registration', 'swap', 'redemption', 'roi'
  action: string;            // e.g. 'link_wallet', 'surrender_token', 'execute_swap'
  toAddress: string;         // contract address; '' if unmapped (will simulate)
  data?: string;             // hex calldata; defaults to '0x'
  valueWei?: string;         // decimal string; defaults to '0'
  meta?: Record<string, unknown>;
  actorParticipantId?: string | null;
}

export interface RawTx {
  module: string;
  action: string;
  signedTx: string;          // 0x-prefixed pre-signed hex blob from user device
  meta?: Record<string, unknown>;
  actorParticipantId?: string | null;
  toAddress?: string;
  valueWei?: string;
}

export interface SubmitResult {
  txHash: string;
  chainId: number;
  status: ChainSubmitStatus;
  clientTxId: string;
  simulated: boolean;
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function newClientTxId(module: string, action: string): string {
  const rand = crypto.randomBytes(10).toString('hex');
  return `${module}.${action}.${rand}`;
}

function simulatedHash(clientTxId: string): string {
  return '0x' + crypto.createHash('sha256').update(`sim:${clientTxId}`).digest('hex');
}

function calldataHash(data: string | undefined): string {
  if (!data || data === '0x') return '';
  const raw = data.startsWith('0x') ? data.slice(2) : data;
  const buf = /^[0-9a-fA-F]*$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(data, 'utf8');
  return '0x' + crypto.createHash('sha256').update(buf).digest('hex');
}

function signBody(body: object): { bodyJson: string; timestamp: string; signature: string } {
  const bodyJson = JSON.stringify(body);
  const timestamp = String(Date.now());
  const msg = `${timestamp}.${bodyJson}`;
  const signature = crypto.createHmac('sha256', SHARED_SECRET).update(msg).digest('hex');
  return { bodyJson, timestamp, signature };
}

async function postToMiddleware(body: object): Promise<{ status: number; payload: any }> {
  const { bodyJson, timestamp, signature } = signBody(body);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(`${MIDDLEWARE_URL}/submit-tx`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-IRG-Timestamp': timestamp,
        'X-IRG-Signature': signature,
      },
      body: bodyJson,
      signal: controller.signal,
    });
    let payload: any;
    try {
      payload = await resp.json();
    } catch {
      payload = { success: false, error: `non_json_response_${resp.status}` };
    }
    return { status: resp.status, payload };
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE RETRY LOOP (shared by system + raw)
// ─────────────────────────────────────────────────────────────────────────────

async function submitWithRetries(auditId: string, body: object): Promise<SubmitResult> {
  let lastErr = '';
  let delay = 500;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { status, payload } = await postToMiddleware(body);
      if (status === 200 && payload?.success) {
        await prisma.chainTxAudit.update({
          where: { id: auditId },
          data: {
            txHash: payload.txHash || '',
            chainId: Number(payload.chainId || CHAIN_ID),
            status: 'SUBMITTED',
            retries: attempt - 1,
            lastError: '',
          },
        });
        const row = await prisma.chainTxAudit.findUnique({ where: { id: auditId } });
        return {
          txHash: row?.txHash || '',
          chainId: row?.chainId || CHAIN_ID,
          status: 'SUBMITTED',
          clientTxId: row?.clientTxId || '',
          simulated: false,
        };
      }
      lastErr = String(payload?.error || `http_${status}`).slice(0, 500);
      // 4xx other than 429 — don't retry a client-side bug
      if (status >= 400 && status < 500 && status !== 429) break;
    } catch (e: any) {
      lastErr = String(e?.message || e).slice(0, 500);
    }
    if (attempt < MAX_RETRIES) {
      await sleep(delay);
      delay = Math.min(delay * 2, 4000);
    }
  }

  // All attempts exhausted
  const row = await prisma.chainTxAudit.findUnique({ where: { id: auditId } });
  if (ALLOW_SIMULATE) {
    const simHash = simulatedHash(row?.clientTxId || auditId);
    await prisma.chainTxAudit.update({
      where: { id: auditId },
      data: {
        txHash: simHash,
        status: 'SIMULATED',
        retries: MAX_RETRIES,
        lastError: lastErr,
      },
    });
    return {
      txHash: simHash,
      chainId: row?.chainId || CHAIN_ID,
      status: 'SIMULATED',
      clientTxId: row?.clientTxId || '',
      simulated: true,
      error: lastErr,
    };
  }

  await prisma.chainTxAudit.update({
    where: { id: auditId },
    data: { status: 'FAILED', retries: MAX_RETRIES, lastError: lastErr },
  });
  return {
    txHash: '',
    chainId: row?.chainId || CHAIN_ID,
    status: 'FAILED',
    clientTxId: row?.clientTxId || '',
    simulated: false,
    error: lastErr,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

export async function systemSubmit(tx: SystemTx): Promise<SubmitResult> {
  const clientTxId = newClientTxId(tx.module, tx.action);
  const audit = await prisma.chainTxAudit.create({
    data: {
      clientTxId,
      module: tx.module,
      action: tx.action,
      mode: 'system',
      chainId: CHAIN_ID,
      toAddress: tx.toAddress || '',
      valueWei: tx.valueWei || '0',
      dataHash: calldataHash(tx.data),
      meta: (tx.meta as any) || {},
      status: 'PENDING',
      actorParticipantId: tx.actorParticipantId || null,
    },
  });

  // Short-circuit if nothing is configured
  if (!MIDDLEWARE_URL || !SHARED_SECRET) {
    if (ALLOW_SIMULATE) {
      const simHash = simulatedHash(clientTxId);
      await prisma.chainTxAudit.update({
        where: { id: audit.id },
        data: { txHash: simHash, status: 'SIMULATED', lastError: 'middleware_not_configured' },
      });
      return {
        txHash: simHash,
        chainId: CHAIN_ID,
        status: 'SIMULATED',
        clientTxId,
        simulated: true,
        error: 'middleware_not_configured',
      };
    }
    await prisma.chainTxAudit.update({
      where: { id: audit.id },
      data: { status: 'FAILED', lastError: 'middleware_not_configured' },
    });
    return {
      txHash: '',
      chainId: CHAIN_ID,
      status: 'FAILED',
      clientTxId,
      simulated: false,
      error: 'middleware_not_configured',
    };
  }

  const body = {
    mode: 'system',
    clientTxId,
    to: tx.toAddress,
    data: tx.data || '0x',
    value: tx.valueWei || '0',
    module: tx.module,
    action: tx.action,
    meta: tx.meta || {},
  };
  return submitWithRetries(audit.id, body);
}

export async function rawSubmit(tx: RawTx): Promise<SubmitResult> {
  const clientTxId = newClientTxId(tx.module, tx.action);
  const audit = await prisma.chainTxAudit.create({
    data: {
      clientTxId,
      module: tx.module,
      action: tx.action,
      mode: 'raw',
      chainId: CHAIN_ID,
      toAddress: tx.toAddress || '',
      valueWei: tx.valueWei || '0',
      dataHash: '',
      meta: (tx.meta as any) || {},
      status: 'PENDING',
      actorParticipantId: tx.actorParticipantId || null,
    },
  });

  if (!MIDDLEWARE_URL || !SHARED_SECRET) {
    await prisma.chainTxAudit.update({
      where: { id: audit.id },
      data: { status: 'FAILED', lastError: 'middleware_not_configured' },
    });
    return {
      txHash: '',
      chainId: CHAIN_ID,
      status: 'FAILED',
      clientTxId,
      simulated: false,
      error: 'middleware_not_configured',
    };
  }

  const body = {
    mode: 'raw',
    clientTxId,
    signedTx: tx.signedTx,
    module: tx.module,
    action: tx.action,
    meta: tx.meta || {},
  };
  return submitWithRetries(audit.id, body);
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT ADDRESS MAP (populated via env — blank => simulate)
// ─────────────────────────────────────────────────────────────────────────────

export const CONTRACTS = {
  FTRToken: process.env.ADDR_FTR_TOKEN || '',
  FTRRedemption: process.env.ADDR_FTR_REDEMPTION || '',
  P2PGuaranteedSettlement: process.env.ADDR_P2P_SETTLEMENT || '',
  SuperCorpusFund: process.env.ADDR_SUPER_CORPUS || '',
  IdentityRegistry: process.env.ADDR_IDENTITY_REGISTRY || '',
  IPRLicense: process.env.ADDR_IPR_LICENSE || '',
  DeviceP2PRegistry: process.env.ADDR_DEVICE_P2P || '',
  GICLedger: process.env.ADDR_GIC_LEDGER || '',
  RoiRegistry: process.env.ADDR_ROI_REGISTRY || '',
};

// ─────────────────────────────────────────────────────────────────────────────
// CALLDATA PLACEHOLDER (until real ABI encoding is wired up)
// ─────────────────────────────────────────────────────────────────────────────

export function encodePlaceholder(action: string, args: Record<string, unknown>): string {
  const serialised =
    `${action}:` +
    Object.keys(args)
      .sort()
      .map((k) => `${k}=${String(args[k])}`)
      .join(':');
  return '0x' + crypto.createHash('sha256').update(serialised).digest('hex');
}
