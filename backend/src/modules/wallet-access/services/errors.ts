/**
 * Structured error classes for wallet_access.
 *
 * Every thrown error carries a stable `code` so the Express layer can
 * convert it to a uniform JSON response without needing to know the
 * specific class.
 */

export class WalletAccessError extends Error {
  code: string;
  httpStatus: number;
  constructor(message: string, code = 'wallet_access_error', httpStatus = 400) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export class WalletNotFound extends WalletAccessError {
  constructor(message = 'No wallet found for this participant.') {
    super(message, 'wallet_not_found', 404);
  }
}
export class WalletAlreadyActivated extends WalletAccessError {
  constructor(message = 'Wallet is already activated.') {
    super(message, 'wallet_already_activated', 400);
  }
}
export class InvalidSeedPhrase extends WalletAccessError {
  constructor(message = 'Seed phrase does not match our records.') {
    super(message, 'invalid_seed_phrase', 400);
  }
}
export class InvalidPassword extends WalletAccessError {
  constructor(message = 'Wallet password is incorrect.') {
    super(message, 'invalid_password', 400);
  }
}
export class PasswordPolicyViolation extends WalletAccessError {
  constructor(message: string) {
    super(message, 'password_policy', 400);
  }
}
export class NomineePolicyViolation extends WalletAccessError {
  constructor(message: string) {
    super(message, 'nominee_policy', 400);
  }
}
export class WalletLocked extends WalletAccessError {
  constructor(message = 'Wallet is locked.') {
    super(message, 'wallet_locked', 423);
  }
}
export class WalletNotTransactable extends WalletAccessError {
  constructor(message = 'Wallet is not in a transactable state.') {
    super(message, 'wallet_not_transactable', 403);
  }
}
export class RecoveryError extends WalletAccessError {
  constructor(message: string) {
    super(message, 'recovery_error', 400);
  }
}
export class OwnershipTransferError extends WalletAccessError {
  constructor(message: string) {
    super(message, 'ownership_transfer_error', 400);
  }
}
