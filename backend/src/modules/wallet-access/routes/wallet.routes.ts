/**
 * /api/v1/wallet/* — REST routes for the FTR wallet-access module.
 *
 * Endpoint shape matches IRG_GDP's Django wallet_access.urls exactly so
 * the same frontend code works against either backend.
 *
 * Auth: expects your existing auth middleware to populate
 * req.participantId. If you already use req.userId, adjust the routes
 * accordingly — the service functions here take participantId.
 *
 * IPR Owner: Rohit Tidke | (c) 2026 Intech Research Group
 */

import { Router, Request, Response } from 'express';

import * as wallet from '../services/wallet.service';
import { WalletAccessError } from '../services/errors';
import { systemSubmit, CONTRACTS, encodePlaceholder } from '../../../services/chain-submit.service';

const router = Router();

/**
 * Resolve the authenticated participant ID.
 *
 * The existing FTR auth middleware (src/middleware/auth.ts) is a stub in
 * this codebase — your security team is expected to populate one of
 * `req.participantId`, `req.userId`, or `req.user.id` once real auth is
 * wired in. This helper accepts all three so the wallet module works
 * with whichever convention gets adopted.
 *
 * If none are present, requests are rejected with 401 at the route level.
 */
function pidOf(req: Request): string {
  const r = req as any;
  return r.participantId || r.userId || r.user?.id || r.user?.participantId || '';
}

function requireAuth(req: Request, res: Response): string | null {
  const pid = pidOf(req);
  if (!pid) {
    res.status(401).json({ error: 'not_authenticated', code: 'not_authenticated' });
    return null;
  }
  return pid;
}

function errorOut(res: Response, err: unknown) {
  if (err instanceof WalletAccessError) {
    return res.status(err.httpStatus).json({ error: err.message, code: err.code });
  }
  const msg = (err as any)?.message || 'internal_error';
  return res.status(500).json({ error: msg, code: 'internal_error' });
}

// ─── PUBLIC ───────────────────────────────────────────────────────────────────

router.get('/heir-guide', (_req, res) => {
  res.json(wallet.heirGuide());
});

// ─── INFO ─────────────────────────────────────────────────────────────────────

router.get('/info', async (req, res) => {
  try {
    res.json(await wallet.getWalletInfo(pidOf(req)));
  } catch (err) {
    errorOut(res, err);
  }
});

router.get('/status-banner', async (req, res) => {
  try {
    res.json(await wallet.statusBanner(pidOf(req)));
  } catch (err) {
    errorOut(res, err);
  }
});

// ─── ACTIVATION & PASSWORD ────────────────────────────────────────────────────

router.post('/activate', async (req, res) => {
  try {
    const info = await wallet.activateWallet({
      participantId: pidOf(req),
      loginPasswordHash: (req as any).loginPasswordHash || null,
      walletPassword: req.body?.wallet_password || '',
      seedPhraseWords: req.body?.seed_phrase_words || [],
      holderType: req.body?.holder_type || 'INDIVIDUAL',
      legalEntityName: req.body?.legal_entity_name || '',
      entityType: req.body?.entity_type || '',
      nominees: req.body?.nominees || [],
      deviceIdHash: req.body?.device_id_hash || '',
      deviceLabel: req.body?.device_label || '',
      platform: req.body?.platform || '',
      termsAccepted: !!req.body?.terms_accepted,
    });
    res.json(info);
  } catch (err) {
    errorOut(res, err);
  }
});

router.post('/password/change', async (req, res) => {
  try {
    await wallet.changeWalletPassword(
      pidOf(req),
      req.body?.old_password || '',
      req.body?.new_password || '',
      (req as any).loginPasswordHash || null,
    );
    res.json({ ok: true });
  } catch (err) {
    errorOut(res, err);
  }
});

router.post('/password/verify', async (req, res) => {
  try {
    const verified = await wallet.verifyWalletPassword(pidOf(req), req.body?.password || '');
    res.json({ verified });
  } catch (err) {
    errorOut(res, err);
  }
});

// ─── NOMINEES ─────────────────────────────────────────────────────────────────

router.get('/nominees', async (req, res) => {
  try {
    res.json(await wallet.listNominees(pidOf(req)));
  } catch (err) {
    errorOut(res, err);
  }
});

router.put('/nominees/update', async (req, res) => {
  try {
    await wallet.updateNominees(pidOf(req), req.body?.nominees || [], req.body?.wallet_password || '');
    res.json({ ok: true });
  } catch (err) {
    errorOut(res, err);
  }
});

// ─── DEVICES ──────────────────────────────────────────────────────────────────

router.get('/devices', async (req, res) => {
  try {
    res.json(await wallet.listDevices(pidOf(req)));
  } catch (err) {
    errorOut(res, err);
  }
});

router.post('/devices/bind', async (req, res) => {
  try {
    const d = await wallet.bindNewDevice(pidOf(req), {
      deviceIdHash: req.body?.device_id_hash || '',
      deviceLabel: req.body?.device_label || '',
      platform: req.body?.platform || '',
      walletPassword: req.body?.wallet_password || '',
    });
    res.json({ id: d.id, cooling_off_until: d.coolingOffUntil?.toISOString() ?? null });
  } catch (err) {
    errorOut(res, err);
  }
});

router.post('/devices/revoke', async (req, res) => {
  try {
    await wallet.revokeDevice(pidOf(req), req.body?.device_id || '', req.body?.wallet_password || '');
    res.json({ ok: true });
  } catch (err) {
    errorOut(res, err);
  }
});

// ─── FREEZE ───────────────────────────────────────────────────────────────────

router.post('/freeze', async (req, res) => {
  try {
    await wallet.emergencyFreeze(pidOf(req), req.body?.reason || '');
    res.json({ ok: true });
  } catch (err) {
    errorOut(res, err);
  }
});

// ─── LIVENESS / INACTIVITY ────────────────────────────────────────────────────

router.post('/liveness/confirm', async (req, res) => {
  try {
    const ev = await wallet.confirmLiveness(pidOf(req));
    res.json({ id: ev.id, kind: ev.kind, occurred_at: ev.occurredAt.toISOString() });
  } catch (err) {
    errorOut(res, err);
  }
});

router.get('/liveness/history', async (req, res) => {
  try {
    res.json(await wallet.listInactivityEvents(pidOf(req)));
  } catch (err) {
    errorOut(res, err);
  }
});

// ─── RECOVERY ─────────────────────────────────────────────────────────────────

async function filerToChain(caseId: string, orig: string, claim: string, evidenceHash: string): Promise<string> {
  const r = await systemSubmit({
    module: 'wallet_access',
    action: 'file_recovery_request',
    toAddress: CONTRACTS.WalletRecoveryEvents || '',
    data: encodePlaceholder('fileRecoveryRequest', {
      caseId, originalWallet: orig, claimantWallet: claim, evidenceHash,
    }),
    meta: { caseId, orig, claim, evidenceHash },
  });
  return r.txHash || '';
}

router.post('/recovery/self', async (req, res) => {
  try {
    const c = await wallet.initiateSelfRecovery(
      pidOf(req),
      req.body?.seed_phrase_words || [],
      req.body?.new_device_id_hash || '',
      req.body?.new_device_label || '',
      req.body?.new_platform || '',
    );
    res.json({ case_id: c.id, status: c.status });
  } catch (err) {
    errorOut(res, err);
  }
});

router.post('/recovery/social', async (req, res) => {
  try {
    const c = await wallet.initiateSocialRecovery({
      claimantParticipantId: pidOf(req),
      claimantContactEmail: (req as any).userEmail,
      claimantContactMobile: (req as any).userMobile,
      originalWalletAddress: req.body?.original_wallet_address || '',
      claimantWalletAddress: req.body?.claimant_wallet_address || '',
      grounds: req.body?.grounds || '',
    });
    res.json({
      case_id: c.id,
      status: c.status,
      cooling_off_ends_at: c.coolingOffEndsAt?.toISOString() ?? null,
    });
  } catch (err) {
    errorOut(res, err);
  }
});

router.post('/recovery/trustee', async (req, res) => {
  try {
    const c = await wallet.initiateTrusteeRecovery({
      claimantParticipantId: pidOf(req),
      originalWalletAddress: req.body?.original_wallet_address || '',
      claimantWalletAddress: req.body?.claimant_wallet_address || '',
      grounds: req.body?.grounds || '',
      evidenceBundleHash: req.body?.evidence_bundle_hash || '',
      blockchainFiler: filerToChain,
    });
    res.json({
      case_id: c.id,
      status: c.status,
      recovery_requested_tx_hash: c.recoveryRequestedTxHash,
      public_notice_ends_at: c.publicNoticeEndsAt?.toISOString() ?? null,
    });
  } catch (err) {
    errorOut(res, err);
  }
});

router.post('/recovery/cancel', async (req, res) => {
  try {
    const c = await wallet.cancelRecovery(
      pidOf(req),
      req.body?.case_id || '',
      req.body?.reason || '',
    );
    res.json({ case_id: c.id, status: c.status });
  } catch (err) {
    errorOut(res, err);
  }
});

router.get('/recovery/cases', async (req, res) => {
  try {
    res.json(await wallet.listRecoveryCases(pidOf(req)));
  } catch (err) {
    errorOut(res, err);
  }
});

// ─── OWNERSHIP TRANSFER ───────────────────────────────────────────────────────

router.post('/ownership/initiate', async (req, res) => {
  try {
    const c = await wallet.initiateOwnershipTransfer({
      outgoingParticipantId: pidOf(req),
      incomingParticipantId: req.body?.incoming_participant_id ?? null,
      reason: req.body?.reason || 'OTHER',
      grounds: req.body?.grounds || '',
      evidenceBundleHash: req.body?.evidence_bundle_hash || '',
      blockchainFiler: async (caseId, wallet_address, evidenceHash) =>
        filerToChain(caseId, wallet_address, '0x' + '0'.repeat(40), evidenceHash),
    });
    res.json({
      case_id: c.id,
      status: c.status,
      public_notice_ends_at: c.publicNoticeEndsAt?.toISOString() ?? null,
    });
  } catch (err) {
    errorOut(res, err);
  }
});

router.post('/ownership/cancel', async (req, res) => {
  try {
    const c = await wallet.cancelOwnershipTransfer(
      pidOf(req),
      req.body?.case_id || '',
      req.body?.reason || '',
    );
    res.json({ case_id: c.id, status: c.status });
  } catch (err) {
    errorOut(res, err);
  }
});

router.get('/ownership/cases', async (req, res) => {
  try {
    res.json(await wallet.listOwnershipTransfers(pidOf(req)));
  } catch (err) {
    errorOut(res, err);
  }
});

// ─── REPORTS ──────────────────────────────────────────────────────────────────

router.get('/transactions', async (req, res) => {
  try {
    const { PrismaClient } = await import('@prisma/client');
    const p = new PrismaClient();
    const where: any = { actorParticipantId: pidOf(req) };
    if (req.query.module) where.module = String(req.query.module);
    if (req.query.status) where.status = String(req.query.status);
    const rows = await p.chainTxAudit.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(parseInt(String(req.query.limit || '50'), 10), 200),
    });
    res.json(
      rows.map((r) => ({
        id: r.id,
        client_tx_id: r.clientTxId,
        module: r.module,
        action: r.action,
        mode: r.mode,
        chain_id: r.chainId,
        to_address: r.toAddress,
        tx_hash: r.txHash,
        block_number: r.blockNumber,
        status: r.status,
        created_at: r.createdAt.toISOString(),
        confirmed_at: r.confirmedAt?.toISOString() ?? null,
        meta: r.meta,
      })),
    );
  } catch (err) {
    errorOut(res, err);
  }
});

router.get('/transactions/export.csv', async (req, res) => {
  try {
    const csv = await wallet.transactionsToCsv(pidOf(req), {
      module: req.query.module ? String(req.query.module) : undefined,
      status: req.query.status ? String(req.query.status) : undefined,
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="irg_transactions.csv"');
    res.send(csv);
  } catch (err) {
    errorOut(res, err);
  }
});

export default router;
