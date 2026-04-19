/**
 * IRG Licence Guard — TypeScript / Express runtime validator.
 *
 * Perpetual licence, Ed25519-signed. Mirror of the Python guard.
 *
 * Usage:
 *   import { verifyLicenceOrDie, enforceLicence } from './licence.guard';
 *   await verifyLicenceOrDie('FTR');   // before app.listen()
 *   app.use(enforceLicence());         // blocks requests if invalid
 *
 * IPR Owner: Rohit Tidke | (c) 2026 Intech Research Group
 */

import { createHash, createPublicKey, verify as cryptoVerify } from 'crypto';
import { readFileSync } from 'fs';
import { hostname, networkInterfaces } from 'os';
import { NextFunction, Request, Response } from 'express';

const LICENCE_PUBLIC_KEY_HEX =
  process.env.IRG_LICENCE_PUBLIC_KEY_HEX ||
  '0000000000000000000000000000000000000000000000000000000000000000';

const LICENCE_TOKEN_PATH = process.env.IRG_LICENCE_TOKEN_PATH || '/etc/irg/licence.token';
const FINGERPRINT_SALT = Buffer.from('irg-fingerprint-v1');
const RECHECK_INTERVAL_MS = 60 * 60 * 1000;

export interface LicencePayload {
  v: number;
  iss: string;
  sub: string;
  name: string;
  fp: string;
  products: string[];
  territory: string[];
  iat: number;
  serial: number;
  build_watermark: string;
}

interface State {
  valid: boolean;
  reason: string;
  payload: LicencePayload | null;
  lastCheckAt: number;
  lastGoodAt: number;
}

const STATE: State = {
  valid: false, reason: 'not_checked', payload: null,
  lastCheckAt: 0, lastGoodAt: 0,
};

function primaryMac(): string {
  const ifaces = networkInterfaces();
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const addr of list) {
      if (!addr.internal && addr.mac && addr.mac !== '00:00:00:00:00:00') {
        return addr.mac.replace(/:/g, '').toLowerCase();
      }
    }
  }
  return 'unknown';
}

function chainId(): string { return process.env.IRG_CHAIN_ID || '888101'; }
function buildVersion(): string { return process.env.IRG_BUILD_VERSION || 'v1.0'; }

export function computeDeploymentFingerprint(): string {
  const h = createHash('sha256');
  h.update(FINGERPRINT_SALT);
  h.update(primaryMac());
  h.update('|');
  h.update(hostname());
  h.update('|');
  h.update(chainId());
  h.update('|');
  h.update(buildVersion());
  return h.digest('hex');
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s + pad, 'base64url');
}

function ed25519PubKeyFromHex(hex: string) {
  const raw = Buffer.from(hex, 'hex');
  if (raw.length !== 32) throw new Error('bad_public_key_length');
  const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]);
  return createPublicKey({ key: der, format: 'der', type: 'spki' });
}

function verifySignature(message: Buffer, signature: Buffer): boolean {
  try {
    return cryptoVerify(null, message, ed25519PubKeyFromHex(LICENCE_PUBLIC_KEY_HEX), signature);
  } catch {
    return false;
  }
}

function parseToken(token: string): LicencePayload {
  const parts = token.trim().split('.');
  if (parts.length !== 2) throw new Error('malformed_token');
  const payloadBytes = b64urlDecode(parts[0]);
  const sig = b64urlDecode(parts[1]);
  if (!verifySignature(payloadBytes, sig)) throw new Error('bad_signature');
  return JSON.parse(payloadBytes.toString('utf8')) as LicencePayload;
}

function verifyOnce(productCode: string): {
  valid: boolean; reason: string; payload: LicencePayload | null;
} {
  let raw: string;
  try {
    raw = readFileSync(LICENCE_TOKEN_PATH, 'utf8').trim();
  } catch {
    return { valid: false, reason: `token_not_found:${LICENCE_TOKEN_PATH}`, payload: null };
  }
  let payload: LicencePayload;
  try {
    payload = parseToken(raw);
  } catch (e: any) {
    return { valid: false, reason: e.message || 'parse_error', payload: null };
  }

  if (payload.v !== 2) return { valid: false, reason: 'unsupported_version', payload };

  const now = Math.floor(Date.now() / 1000);
  if (payload.iat > now + 300) return { valid: false, reason: 'issued_in_future', payload };

  if ((payload.fp || '').toLowerCase() !== computeDeploymentFingerprint()) {
    return { valid: false, reason: 'fingerprint_mismatch', payload };
  }

  const products = (payload.products || []).map((p) => p.toUpperCase());
  if (!products.includes(productCode.toUpperCase())) {
    return { valid: false, reason: 'product_not_licensed', payload };
  }

  return { valid: true, reason: 'ok', payload };
}

let recheckStarted = false;

export async function verifyLicenceOrDie(productCode = 'FTR'): Promise<void> {
  const result = verifyOnce(productCode);
  STATE.valid = result.valid;
  STATE.reason = result.reason;
  STATE.payload = result.payload;
  STATE.lastCheckAt = Date.now();
  if (result.valid) STATE.lastGoodAt = Date.now();

  if (!result.valid) {
    console.error(
      `[irg.licence] LICENCE INVALID (${result.reason}) — refusing to start. ` +
      `Contact the licensor.`,
    );
    if (process.env.IRG_LICENCE_TEST_MODE === '1') {
      throw new Error(result.reason);
    }
    process.exit(2);
  }

  console.info(
    `[irg.licence] OK — ${productCode} licensed to ${result.payload?.name} ` +
    `(${result.payload?.sub}), serial ${result.payload?.serial}`,
  );

  if (!recheckStarted) {
    recheckStarted = true;
    setInterval(() => {
      const r = verifyOnce(productCode);
      STATE.valid = r.valid;
      STATE.reason = r.reason;
      STATE.payload = r.payload;
      STATE.lastCheckAt = Date.now();
      if (r.valid) STATE.lastGoodAt = Date.now();
      if (!r.valid) console.error(`[irg.licence] recheck failed: ${r.reason}`);
    }, RECHECK_INTERVAL_MS).unref();
  }
}

export function enforceLicence() {
  const exempt = new Set(['/healthz', '/licence/status']);
  return (req: Request, res: Response, next: NextFunction): void => {
    if (exempt.has(req.path)) return next();
    if (!STATE.valid) {
      res.status(503).json({
        error: 'licence_invalid',
        reason: STATE.reason,
        message: 'This deployment is not currently licensed. Contact the licensor.',
      });
      return;
    }
    next();
  };
}

export function currentLicenceInfo(): Record<string, unknown> {
  return {
    valid: STATE.valid,
    reason: STATE.reason,
    lastCheckAt: STATE.lastCheckAt,
    lastGoodAt: STATE.lastGoodAt,
    licensee: STATE.payload?.name ?? null,
    licenseeUid: STATE.payload?.sub ?? null,
    serial: STATE.payload?.serial ?? null,
    products: STATE.payload?.products ?? [],
    territory: STATE.payload?.territory ?? [],
  };
}
