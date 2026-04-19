/**
 * Activity tracker — touches the wallet's lastActivityAt on every
 * authenticated request (rate-limited to once per hour per participant
 * to avoid write amplification).
 *
 * IPR Owner: Rohit Tidke | (c) 2026 Intech Research Group
 */

import { NextFunction, Request, Response } from 'express';

import { touchActivity } from '../services/wallet.service';
import { ACTIVITY_TOUCH_INTERVAL_MS } from '../services/policy';

const lastTouch = new Map<string, number>();

export function walletActivityMiddleware() {
  return async (req: Request, _res: Response, next: NextFunction) => {
    // Fire-and-forget: never block the request.
    try {
      const pid = (req as any).participantId || (req as any).userId || '';
      if (pid) {
        const now = Date.now();
        const last = lastTouch.get(pid) || 0;
        if (now - last >= ACTIVITY_TOUCH_INTERVAL_MS) {
          lastTouch.set(pid, now);
          void touchActivity(pid).catch(() => undefined);
        }
      }
    } catch {
      /* swallow */
    }
    next();
  };
}
