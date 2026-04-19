/**
 * irg_ftr backend — Express middleware to verify Firebase ID tokens.
 * Attaches req.firebaseUid and req.firebaseClaims when a valid Bearer token
 * is present. Does NOT reject requests without a token (so endpoints can
 * remain optionally auth'd during migration).
 */
import type { Request, Response, NextFunction } from 'express';
import { getAuth } from './admin';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      firebaseUid?: string;
      firebaseClaims?: any;
    }
  }
}

export async function firebaseAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return next();
  const token = header.slice(7).trim();
  if (!token) return next();
  try {
    const decoded = await getAuth().verifyIdToken(token);
    req.firebaseUid = decoded.uid;
    req.firebaseClaims = decoded;
  } catch {
    /* silent */
  }
  next();
}

export function requireFirebaseAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.firebaseUid) return res.status(401).json({ error: 'unauthorized' });
  next();
}
