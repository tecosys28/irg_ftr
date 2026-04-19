// ═══════════════════════════════════════════════════════════════════════════════
// IRG PAA Bridge — FTR adapter (TypeScript)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Typed wrapper around the canonical JS SDK that lives in
// `irg_gov/src/modules/payments/sdk.js`. Vendored locally under
// `./vendor/` so FTR has zero cross-repo runtime coupling.
//
// Swap's existing services (corpus-fund.service.ts, payment.service.ts) now
// call methods on this bridge. The JS SDK is the source of truth for method
// names, envelope shape, and wire protocol.
//
// Configuration (precedence high→low):
//   1. options passed to getPAABridge()
//   2. process.env.PAA_BRIDGE_*
//   3. defaults (transport=http, source_system='ftr')
//
// When transport='http' and PAA_BRIDGE_ENDPOINT is unset, the bridge falls
// back to 'callback' mode with an in-memory stub — enough for tests and
// early dev, but NOT a production configuration.

// ts-ignore is intentional here: the vendored file is a .mjs ES module and TS
// doesn't trace the path under nodenext without extra tsconfig work. At runtime
// Node resolves it fine since ts-node/tsx handles .mjs imports.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import createPAABridgeJS, {
  PAYMENTS_SCHEMA_VERSION as _SCHEMA_VERSION,
  SDK_METHODS as _SDK_METHODS,
  SUPPORTED_CURRENCIES as _CURRENCIES,
  TRANSACTION_CATEGORIES as _CATEGORIES,
  CORPUS_FUND_TYPES as _CF_TYPES,
  makeIdempotencyKey as _makeIdem,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
} from './vendor/sdk.mjs';

// Re-export as properly typed constants
export const PAYMENTS_SCHEMA_VERSION: string = _SCHEMA_VERSION;
export const SDK_METHODS: readonly string[] = _SDK_METHODS;
export const SUPPORTED_CURRENCIES: readonly string[] = _CURRENCIES;
export const TRANSACTION_CATEGORIES: readonly string[] = _CATEGORIES;
export const CORPUS_FUND_TYPES: readonly string[] = _CF_TYPES;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
export type Currency =
  | 'USD' | 'EUR' | 'GBP' | 'INR' | 'AED'
  | 'SGD' | 'JPY' | 'AUD' | 'CAD' | 'CHF';

export type TransactionType =
  | 'collection' | 'payment' | 'investment' | 'roi_credit'
  | 'recall' | 'refund' | 'system_charge' | 'exchange';

export type TransactionStatus =
  | 'pending' | 'validated' | 'pending_approval'
  | 'pending_dual' | 'pending_board' | 'approved'
  | 'executed' | 'failed' | 'court_pending' | 'cancelled';

export type CorpusFundType =
  'IRG_CF' | 'IRG_Local_CF' | 'Minter_CF' | 'Jeweler_CF';

export interface BridgeEnvelope<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface PAATransaction {
  id: string;
  txType: TransactionType;
  category: string;
  amount: number;
  currency: Currency;
  usdAmount?: number;
  fromAccount: string;
  toCF: CorpusFundType;
  toAccountId?: string | null;
  status: TransactionStatus;
  requiredApproval?: 'single' | 'dual' | 'board' | 'court';
  idempotencyKey: string;
  oracleConfirmations?: Array<{ type: string; confirmed: boolean; confirmedAt?: string; confirmedBy?: string }>;
  approvals?: Array<{ actor: string; role: string; approvedAt: string }>;
  blockchainTxHash?: string | null;
  sourceSystem?: string;
  sourceRef?: string | null;
  notes?: string;
  createdBy?: string;
  createdAt?: string;
  executedAt?: string | null;
}

export interface PAACorpusFund {
  id: string;
  cfType: CorpusFundType;
  name: string;
  countryCode?: string;
  ownerId: string;
  primaryCurrency: Currency;
  isMultiCurrencyAccount?: boolean;
  isActive: boolean;
  bankName?: string;
  balances: Array<{ currency: Currency; balance: number; lastUpdated: string }>;
}

export interface CreateTransactionInput {
  txType: TransactionType;
  category: string;
  amount: number;
  currency: Currency;
  fromAccount: string;
  toAccountId?: string;
  idempotencyKey?: string;
  oracleConfirmations?: Array<{ type: string; confirmed: boolean }>;
  notes?: string;
  sourceSystem?: string;
  sourceRef?: string;
}

export interface BridgeOptions {
  transport?: 'http' | 'callback' | 'in-process';
  endpoint?: string;
  apiKey?: string;
  actor?: string;
  sourceSystem?: string;
  send?: (env: { method: string; args: unknown[] }) => Promise<BridgeEnvelope>;
  expectSchemaVersion?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bridge instance (class-shaped for easy mocking in tests)
// ─────────────────────────────────────────────────────────────────────────────
class PAABridge {
  private raw: any;
  readonly opts: BridgeOptions;

  constructor(raw: any, opts: BridgeOptions) {
    this.raw = raw;
    this.opts = opts;
  }

  meta() { return this.raw.meta(); }
  health() { return this.raw.health(); }

  async listCorpusFunds(filter: Record<string, unknown> = {}) {
    return this.raw.listCorpusFunds(filter) as Promise<BridgeEnvelope<PAACorpusFund[]>>;
  }
  async getCorpusFund(id: string) {
    return this.raw.getCorpusFund(id) as Promise<BridgeEnvelope<PAACorpusFund | null>>;
  }
  async getSuperCorpus() {
    return this.raw.getSuperCorpus() as Promise<BridgeEnvelope<PAACorpusFund | null>>;
  }
  async totalCorpusValueUSD() {
    return this.raw.totalCorpusValueUSD() as Promise<BridgeEnvelope<number>>;
  }

  async listTransactions(filter: Record<string, unknown> = {}) {
    return this.raw.listTransactions(filter) as Promise<BridgeEnvelope<PAATransaction[]>>;
  }
  async getTransaction(id: string) {
    return this.raw.getTransaction(id) as Promise<BridgeEnvelope<PAATransaction | null>>;
  }

  async createTransaction(input: CreateTransactionInput, actor?: string) {
    const payload: CreateTransactionInput = {
      sourceSystem: this.opts.sourceSystem || 'ftr',
      ...input,
    };
    return this.raw.createTransaction(payload, actor || this.opts.actor) as
      Promise<BridgeEnvelope<{ ok: boolean; transaction: PAATransaction; validation: any }>>;
  }

  async approveTransaction(id: string, actor?: string, role = 'AdvisoryBoardMember') {
    return this.raw.approveTransaction(id, actor || this.opts.actor, role) as
      Promise<BridgeEnvelope<{ transaction: PAATransaction }>>;
  }
  async executeTransaction(id: string, actor?: string) {
    return this.raw.executeTransaction(id, actor || this.opts.actor) as
      Promise<BridgeEnvelope<{ transaction: PAATransaction }>>;
  }
  async cancelTransaction(id: string, actor?: string, reason = '') {
    return this.raw.cancelTransaction(id, actor || this.opts.actor, reason) as
      Promise<BridgeEnvelope<{ transaction: PAATransaction }>>;
  }
  async recordOracleConfirmation(id: string, oracleType: string, actor?: string, docHash?: string) {
    return this.raw.recordOracleConfirmation(id, oracleType, actor || this.opts.actor, docHash) as
      Promise<BridgeEnvelope<{ transaction: PAATransaction }>>;
  }

  async createCorpusFund(payload: Partial<PAACorpusFund>, actor?: string) {
    return this.raw.createCorpusFund(payload, actor || this.opts.actor) as
      Promise<BridgeEnvelope<PAACorpusFund>>;
  }

  async getActiveBudget()         { return this.raw.getActiveBudget(); }
  async listTrustees()            { return this.raw.listTrustees(); }
  async getTrustee(id: string)    { return this.raw.getTrustee(id); }
  async getAuditLog(filter = {})  { return this.raw.getAuditLog(filter); }
  async getDashboardMetrics()     { return this.raw.getDashboardMetrics(); }
  async snapshotState()           { return this.raw.snapshotState(); }

  // ── Convenience helpers (match sdk.js wrappers + Python bridge) ───────────
  async postCollection(args: {
    category: string;
    amount: number;
    currency: Currency;
    fromAccount: string;
    sourceRef?: string;
    oracleConfirmations?: Array<{ type: string; confirmed: boolean }>;
    notes?: string;
  }) {
    return this.raw.postCollection({
      ...args,
      sourceRef: args.sourceRef || null,
      oracleConfirmations: args.oracleConfirmations || [],
      notes: args.notes || '',
    }) as Promise<BridgeEnvelope<{ ok: boolean; transaction: PAATransaction; validation: any }>>;
  }

  async requestPayment(args: {
    category: string;
    amount: number;
    currency: Currency;
    fromAccount: string;
    sourceRef?: string;
    oracleConfirmations?: Array<{ type: string; confirmed: boolean }>;
    notes?: string;
  }) {
    return this.raw.requestPayment({
      ...args,
      sourceRef: args.sourceRef || null,
      oracleConfirmations: args.oracleConfirmations || [],
      notes: args.notes || '',
    }) as Promise<BridgeEnvelope<{ ok: boolean; transaction: PAATransaction; validation: any }>>;
  }

  async creditROI(args: {
    cfId: string;
    amount: number;
    currency: Currency;
    sourceRef: string;
    period: string;
    notes?: string;
  }) {
    return this.raw.creditROI(args) as
      Promise<BridgeEnvelope<{ ok: boolean; transaction: PAATransaction; validation: any }>>;
  }

  /** Reusable stable key; matches the Python `make_idempotency_key`. */
  static idempotencyKey(sourceSystem: string, sourceRef: string | null,
                        category: string, amount: number, currency: string): string {
    return _makeIdem(sourceSystem, sourceRef, category, amount, currency);
  }
}

export type { PAABridge };

// ─────────────────────────────────────────────────────────────────────────────
// Singleton factory
// ─────────────────────────────────────────────────────────────────────────────
let _singleton: PAABridge | null = null;

export function getPAABridge(overrides: BridgeOptions = {}): PAABridge {
  if (_singleton && Object.keys(overrides).length === 0) return _singleton;

  const envTransport = (process.env.PAA_BRIDGE_TRANSPORT as BridgeOptions['transport']) || undefined;
  const envEndpoint  = process.env.PAA_BRIDGE_ENDPOINT;
  const envApiKey    = process.env.PAA_BRIDGE_API_KEY;

  const opts: Required<Pick<BridgeOptions, 'sourceSystem' | 'actor'>> & BridgeOptions = {
    sourceSystem: overrides.sourceSystem || 'ftr',
    actor:        overrides.actor        || 'ftr.system',
    transport:    overrides.transport    || envTransport || (envEndpoint ? 'http' : 'callback'),
    endpoint:     overrides.endpoint     || envEndpoint,
    apiKey:       overrides.apiKey       || envApiKey,
    send:         overrides.send,
    expectSchemaVersion: overrides.expectSchemaVersion,
  };

  // Callback fallback — an in-memory "ok" stub so FTR boots cleanly in dev.
  // Production deployments MUST set PAA_BRIDGE_ENDPOINT or PAA_BRIDGE_TRANSPORT=http.
  if (opts.transport === 'callback' && !opts.send) {
    // eslint-disable-next-line no-console
    console.warn('[paa-bridge] no endpoint and no callback supplied; using in-memory stub.');
    opts.send = async () => ({ ok: true, data: null });
  }

  const raw = createPAABridgeJS(opts);
  const b = new PAABridge(raw, opts);
  if (Object.keys(overrides).length === 0) _singleton = b;
  return b;
}

// Convenience helper for tests
export function __resetPAABridgeSingleton(): void { _singleton = null; }
