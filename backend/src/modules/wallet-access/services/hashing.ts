/**
 * Hashing utilities for wallet passwords and seed phrases.
 *
 * PBKDF2-SHA256 hash format used is compatible with Django's
 * `pbkdf2_sha256$<iterations>$<salt>$<hash>` so the GDP and FTR
 * backends can verify each other's password commitments in
 * cross-app workflows (e.g. during ownership transfers where the
 * operator moves between platforms).
 *
 * IPR Owner: Rohit Tidke | (c) 2026 Intech Research Group
 */

import { pbkdf2Sync, randomBytes, createHash, timingSafeEqual } from 'crypto';

import { WALLET_PASSWORD_ITERATIONS } from './policy';

export function hashSeedPhrase(words: string[]): string {
  const joined = words
    .map((w) => String(w || '').trim().toLowerCase())
    .filter(Boolean)
    .join(' ');
  return '0x' + createHash('sha256').update(joined).digest('hex');
}

export function hashWalletPassword(password: string): {
  hash: string;
  salt: string;
  algo: string;
  iterations: number;
} {
  const salt = randomBytes(16).toString('hex');
  const iterations = WALLET_PASSWORD_ITERATIONS;
  const derived = pbkdf2Sync(password, salt, iterations, 32, 'sha256').toString('base64');
  // Django-compatible encoding
  const hash = `pbkdf2_sha256$${iterations}$${salt}$${derived}`;
  return { hash, salt, algo: 'pbkdf2_sha256', iterations };
}

export function verifyWalletPassword(password: string, storedHash: string): boolean {
  if (!storedHash || !storedHash.startsWith('pbkdf2_sha256$')) return false;
  const parts = storedHash.split('$');
  if (parts.length !== 4) return false;
  const iterations = parseInt(parts[1], 10);
  const salt = parts[2];
  const expected = parts[3];
  const derived = pbkdf2Sync(password, salt, iterations, 32, 'sha256').toString('base64');
  // Constant-time compare
  const a = Buffer.from(derived);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
