/**
 * Wallet access policy constants — mirror of wallet_access/services.py
 * in IRG_GDP. Values must match because both apps share the same user
 * expectations and both notify the same users.
 *
 * IPR Owner: Rohit Tidke | (c) 2026 Intech Research Group
 */

export const WALLET_PASSWORD_MIN_LEN = 8;
export const WALLET_PASSWORD_ITERATIONS = 600_000; // PBKDF2-SHA256, OWASP 2024
export const SEED_PHRASE_WORD_COUNT = 15;
export const MAX_FAILED_PASSWORD_ATTEMPTS = 10;

// Durations in milliseconds
export const LOCK_DURATION_MS = 24 * 60 * 60 * 1000;
export const DEVICE_COOLING_OFF_MS = 48 * 60 * 60 * 1000;
export const SOCIAL_RECOVERY_COOLING_OFF_MS = 7 * 24 * 60 * 60 * 1000;
export const TRUSTEE_PUBLIC_NOTICE_MS = 30 * 24 * 60 * 60 * 1000;
export const OWNERSHIP_TRANSFER_NOTICE_MS = 30 * 24 * 60 * 60 * 1000;
export const REVERSIBILITY_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

export const INACTIVITY_PROMPT_AFTER_MS = 365 * 24 * 60 * 60 * 1000;
export const INACTIVITY_REMINDER_AFTER_PROMPT_MS = 2 * 24 * 60 * 60 * 1000;
export const INACTIVITY_NOMINEES_AFTER_REMINDER_MS = 2 * 24 * 60 * 60 * 1000;

export const ACTIVITY_TOUCH_INTERVAL_MS = 60 * 60 * 1000; // touch DB at most hourly

export function addMs(ms: number): Date {
  return new Date(Date.now() + ms);
}
