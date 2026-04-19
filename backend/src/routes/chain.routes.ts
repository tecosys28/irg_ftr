/**
 * IRG Chain 888101 — Audit sink (FTR).
 *
 * The middleware fires a best-effort POST here whenever it broadcasts a
 * transaction, so the DB has a second confirmation of the hash even if
 * the middleware's response to /submit-tx is lost in transit.
 *
 * Bearer-token auth only (middleware and Node backend share a private
 * network; mTLS is overkill for this internal hop).
 *
 * IPR Owner: Rohit Tidke | (c) 2026 Intech Research Group
 */

import { Router } from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const router = Router();

const AUDIT_TOKEN = process.env.IRG_CHAIN_AUDIT_TOKEN || '';

router.post('/audit', async (req, res) => {
  if (!AUDIT_TOKEN) {
    return res.status(503).json({ error: 'sink_disabled' });
  }
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${AUDIT_TOKEN}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { clientTxId, txHash, chainId, mode, module, action, meta } = req.body || {};
  if (!clientTxId || !txHash) {
    return res.status(400).json({ error: 'bad_payload' });
  }

  const existing = await prisma.chainTxAudit.findUnique({ where: { clientTxId } });
  if (!existing) {
    // Defensive recovery row — middleware saw a tx we have no local record of.
    await prisma.chainTxAudit.create({
      data: {
        clientTxId,
        module: module || 'unknown',
        action: action || 'unknown',
        mode: mode || 'system',
        chainId: Number(chainId || 888101),
        meta: meta || {},
        status: 'SUBMITTED',
        txHash,
      },
    });
    return res.json({ ok: true, recovered: true });
  }

  const patch: any = {};
  if (!existing.txHash) patch.txHash = txHash;
  if (existing.status === 'PENDING') patch.status = 'SUBMITTED';
  if (Object.keys(patch).length > 0) {
    await prisma.chainTxAudit.update({ where: { clientTxId }, data: patch });
  }
  return res.json({ ok: true });
});

export default router;
