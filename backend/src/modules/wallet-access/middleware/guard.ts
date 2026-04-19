/**
 * Transaction guard — blocks any route that would cause a blockchain
 * transaction if the caller's wallet is not ACTIVATED, has insufficient
 * nominees (individual wallets), has no active device past its
 * cooling-off period, or is locked / recovering / suspended.
 *
 * Usage in a route file:
 *
 *   import { requireTransactable } from '../middleware/guard';
 *   router.post('/mint', requireTransactable({ requireNominees: true }), handler);
 *
 * The caller must have `req.participantId` populated by your existing
 * auth middleware (see registration module's auth.ts).
 *
 * IPR Owner: Rohit Tidke | (c) 2026 Intech Research Group
 */

import { NextFunction, Request, Response } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

interface GuardOptions {
  requireNominees?: boolean;
  requireActiveDevice?: boolean;
}

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

export function requireTransactable(opts: GuardOptions = {}) {
  const requireActiveDevice = opts.requireActiveDevice !== false;
  return async (req: Request, res: Response, next: NextFunction) => {
    const participantId = (req as any).participantId || (req as any).userId;
    if (!participantId) {
      return res.status(401).json({ error: 'not_authenticated', code: 'not_authenticated' });
    }
    const wallet = await prisma.walletActivation.findUnique({
      where: { participantId },
      include: {
        nominees: { where: { active: true } },
        devices: { where: { state: 'ACTIVE' } },
      },
    });
    if (!wallet) {
      return res
        .status(403)
        .json({ error: 'No wallet found for this account.', code: 'wallet_missing' });
    }

    if (wallet.state !== 'ACTIVATED') {
      return res.status(403).json({
        error: blockingReasonFor(wallet.state),
        code: `wallet_${wallet.state.toLowerCase()}`,
        wallet_state: wallet.state,
      });
    }
    if (wallet.lockedUntil && wallet.lockedUntil.getTime() > Date.now()) {
      return res.status(423).json({
        error: 'Wallet is temporarily locked.',
        code: 'wallet_locked',
        wallet_state: 'LOCKED',
      });
    }

    if (opts.requireNominees) {
      if (wallet.holderType === 'INDIVIDUAL' && wallet.nominees.length < 2) {
        return res.status(403).json({
          error: 'At least two nominees must be registered before you can transact.',
          code: 'nominees_required',
          wallet_state: wallet.state,
        });
      }
      if (wallet.nominees.length > 0) {
        const total = wallet.nominees.reduce(
          (s, n) => s.plus(n.sharePercent),
          new Prisma.Decimal(0),
        );
        if (!total.equals(100)) {
          return res.status(403).json({
            error: `Nominee shares must total 100% (currently ${total.toString()}%).`,
            code: 'nominee_shares_invalid',
            wallet_state: wallet.state,
          });
        }
      }
    }

    if (requireActiveDevice) {
      const now = Date.now();
      const ready = wallet.devices.some(
        (d) => !d.coolingOffUntil || d.coolingOffUntil.getTime() <= now,
      );
      if (!ready) {
        return res.status(403).json({
          error: 'No device is currently authorised to sign transactions for this wallet.',
          code: 'device_not_ready',
          wallet_state: wallet.state,
        });
      }
    }

    next();
  };
}
