/**
 * IRG Payments — Canonical Schema
 * =================================
 *
 * Single source of truth for every payments concept used across the IRG
 * ecosystem (Governance Hub, GDP, FTR, DAC). Ports the original IRG-PAA
 * type system (src/types/index.ts) into plain JS frozen constants so it can
 * be imported by:
 *
 *   - the gov_v3 React UI (this file lives in gov_v3)
 *   - the cross-system PAA Bridge SDK (sdk.js — re-exports these constants)
 *   - any consumer that imports the SDK (GDP / FTR / DAC adapters)
 *
 * Anything new (a new corpus fund type, a new category, a new currency)
 * must be added here first. Other systems pick it up by upgrading their
 * SDK pin.
 *
 * IPR Owner: Mr. Rohit Tidke
 * © 2026 Intech Research Group
 */

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA VERSION
// ─────────────────────────────────────────────────────────────────────────────
// Bumped whenever any constant in this file changes shape (NOT for value
// additions to enums). Bridge SDK consumers can assert this at boot time.
export const PAYMENTS_SCHEMA_VERSION = '1.0.0';

// ─────────────────────────────────────────────────────────────────────────────
// USER ROLES (payment-system roles — distinct from gov_v3 hub roles, mapped
// in roleMapping.js)
// ─────────────────────────────────────────────────────────────────────────────
export const USER_ROLES = Object.freeze([
  'SuperAdmin',
  'AdvisoryBoardMember',
  'TrusteeBanker',
  'Minter',
  'Jeweler',
  'Licensee',
  'Auditor',
  'System',
]);

// ─────────────────────────────────────────────────────────────────────────────
// CORPUS FUND TYPES
// ─────────────────────────────────────────────────────────────────────────────
//   IRG_CF        — Main IRG Trust Corpus Fund (the "super corpus")
//   IRG_Local_CF  — Country-localised CFs (one per jurisdiction)
//   Minter_CF     — One per FTR minter
//   Jeweler_CF    — One per enlisted jeweler (GDP proceeds)
// ─────────────────────────────────────────────────────────────────────────────
export const CORPUS_FUND_TYPES = Object.freeze([
  'IRG_CF',
  'IRG_Local_CF',
  'Minter_CF',
  'Jeweler_CF',
]);

// The "super corpus" is the IRG_CF. Surfaced as a named constant so consumers
// don't hardcode the string.
export const SUPER_CORPUS_FUND_TYPE = 'IRG_CF';

// ─────────────────────────────────────────────────────────────────────────────
// TRANSACTION TYPES (the verb)
// ─────────────────────────────────────────────────────────────────────────────
export const TRANSACTION_TYPES = Object.freeze([
  'collection',     // Inflow / deposit
  'payment',        // Outflow
  'investment',     // Trustee investment of CF
  'roi_credit',     // ROI returns being credited to CF
  'recall',         // FTR recall settlement
  'refund',         // Refund of an earlier transaction
  'system_charge',  // System support charge from FTR sale
  'exchange',       // Cross-currency exchange leg
]);

// ─────────────────────────────────────────────────────────────────────────────
// TRANSACTION CATEGORIES (the noun — what specific business event)
// ─────────────────────────────────────────────────────────────────────────────
export const TRANSACTION_CATEGORIES = Object.freeze([
  // Collections (inflows)
  'trot_book_sale',
  'license_fee',
  'irg_gdp_sale',
  'irg_ftr_sale',
  'default_compensation',
  'recall_compensation',
  'recall_insurance_claim',
  'dac_charges',
  'advertisement_charges',
  'referral_commission_ftr',
  'ftr_minting_cost',
  'gdp_minting_cost',
  'ftr_recall_costs',
  'gdp_shortfall',
  'gdp_recovery',
  'roi_investment_proceeds',
  'trade_profit',
  'tgdp_ftr_gic_jr_sale',
  'jewelry_designer_charges',
  'cross_currency_gain',
  'system_support_charges',
  'other_collection',

  // Payments (outflows)
  'advisory_board_expense',
  'taxes',
  'investments',
  'trust_beneficiary_income',
  'cross_currency_loss',
  'operational_expense',
  'other_payment',
]);

// ─────────────────────────────────────────────────────────────────────────────
// TRANSACTION STATUSES
// ─────────────────────────────────────────────────────────────────────────────
export const TRANSACTION_STATUSES = Object.freeze([
  'pending',         // Awaiting validation
  'validated',       // Passed rules engine, awaiting approval
  'pending_approval',// Awaiting single-approval
  'pending_dual',    // Awaiting dual approval
  'pending_board',   // Awaiting board approval
  'approved',        // All approvals captured, awaiting execution
  'executed',        // Successfully posted to ledger
  'failed',          // Failed validation or execution
  'court_pending',   // Awaiting court approval (rule-change linked)
  'cancelled',       // Cancelled by initiator/governance
]);

// ─────────────────────────────────────────────────────────────────────────────
// CURRENCIES — multi-currency support (matches original IRG-PAA)
// ─────────────────────────────────────────────────────────────────────────────
export const SUPPORTED_CURRENCIES = Object.freeze([
  'USD', 'EUR', 'GBP', 'INR', 'AED', 'SGD', 'JPY', 'AUD', 'CAD', 'CHF',
]);

// Decimal places per currency (JPY uses 0). Used by the formatter and the
// validator to round amounts to the correct precision.
export const CURRENCY_DECIMALS = Object.freeze({
  USD: 2, EUR: 2, GBP: 2, INR: 2, AED: 2, SGD: 2,
  JPY: 0,
  AUD: 2, CAD: 2, CHF: 2,
});

// Display symbols for the UI.
export const CURRENCY_SYMBOLS = Object.freeze({
  USD: '$',  EUR: '€',  GBP: '£',  INR: '₹',  AED: 'د.إ',
  SGD: 'S$', JPY: '¥',  AUD: 'A$', CAD: 'C$', CHF: 'CHF',
});

// ─────────────────────────────────────────────────────────────────────────────
// CATEGORY → CORPUS FUND ROUTING
// ─────────────────────────────────────────────────────────────────────────────
// Drives where a transaction's funds end up. Mirrors the routing table in the
// original PAA rules engine; the gov_v3 rules engine reads from this map.
// ─────────────────────────────────────────────────────────────────────────────
export const CATEGORY_ROUTING = Object.freeze({
  // To IRG_CF (super corpus)
  trot_book_sale:           'IRG_CF',
  license_fee:              'IRG_CF',
  ftr_minting_cost:         'IRG_CF',
  gdp_minting_cost:         'IRG_CF',
  trust_beneficiary_income: 'IRG_CF',
  advisory_board_expense:   'IRG_CF',
  taxes:                    'IRG_CF',
  investments:              'IRG_CF',
  roi_investment_proceeds:  'IRG_CF',
  trade_profit:             'IRG_CF',

  // To IRG_Local_CF (country-localised)
  default_compensation:     'IRG_Local_CF',
  recall_compensation:      'IRG_Local_CF',
  recall_insurance_claim:   'IRG_Local_CF',
  dac_charges:              'IRG_Local_CF',
  advertisement_charges:    'IRG_Local_CF',
  referral_commission_ftr:  'IRG_Local_CF',
  ftr_recall_costs:         'IRG_Local_CF',
  gdp_shortfall:            'IRG_Local_CF',
  gdp_recovery:             'IRG_Local_CF',
  tgdp_ftr_gic_jr_sale:     'IRG_Local_CF',
  jewelry_designer_charges: 'IRG_Local_CF',
  system_support_charges:   'IRG_Local_CF',
  operational_expense:      'IRG_Local_CF',
  other_collection:         'IRG_Local_CF',
  other_payment:            'IRG_Local_CF',

  // To Minter_CF
  irg_ftr_sale:             'Minter_CF',
  cross_currency_gain:      'Minter_CF',
  cross_currency_loss:      'Minter_CF',

  // To Jeweler_CF
  irg_gdp_sale:             'Jeweler_CF',
});

// ─────────────────────────────────────────────────────────────────────────────
// ORACLE REQUIREMENTS BY CATEGORY
// ─────────────────────────────────────────────────────────────────────────────
// Categories that require external confirmations before executing (bank
// statement, law-firm sign-off, trustee-banker confirmation, etc).
// ─────────────────────────────────────────────────────────────────────────────
export const ORACLE_REQUIREMENTS = Object.freeze({
  recall_insurance_claim:   ['law_firm', 'bank'],
  investments:              ['trustee'],
  roi_investment_proceeds:  ['trustee', 'bank'],
  trust_beneficiary_income: ['trustee'],
  taxes:                    ['bank'],
  advisory_board_expense:   ['bank'],
  tgdp_ftr_gic_jr_sale:     ['bank'],
});

export const ORACLE_TYPES = Object.freeze([
  'bank', 'law_firm', 'blockchain', 'trustee', 'system',
]);

// ─────────────────────────────────────────────────────────────────────────────
// APPROVAL THRESHOLDS (USD-equivalent)
// ─────────────────────────────────────────────────────────────────────────────
// All amounts are normalised to USD for threshold checking via the FX rate
// table. A transaction in INR for ₹500,000 is checked against the USD-
// equivalent at the prevailing rate.
// ─────────────────────────────────────────────────────────────────────────────
export const APPROVAL_THRESHOLDS_USD = Object.freeze({
  SINGLE_APPROVAL: 0,         // Any value ≥ 0 needs at least one approver
  DUAL_APPROVAL: 1_000,       // ≥ $1k needs two approvers
  BOARD_APPROVAL: 10_000,     // ≥ $10k needs Advisory Board
  COURT_APPROVAL: 1_000_000,  // ≥ $1M needs court approval (rule-change link)
});

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM CHARGES
// ─────────────────────────────────────────────────────────────────────────────
export const DEFAULT_CHARGE_RATES = Object.freeze({
  SYSTEM_SUPPORT_CHARGE_RATE: 0.0050,  // 0.50% of FTR sale proceeds
  ROI_SHARE_RATE:             0.0600,  // 6% share of ROI to system
  MIN_CORPUS_RATIO:           0.6000,  // 60% of CF must remain untouched
});

// ─────────────────────────────────────────────────────────────────────────────
// COMPLIANCE FACTORS (TrusteeBanker scoring weights, sums to 1.0)
// ─────────────────────────────────────────────────────────────────────────────
export const COMPLIANCE_FACTORS = Object.freeze({
  ROI_PERFORMANCE:        { weight: 0.25, label: 'ROI performance' },
  GUIDELINE_ADHERENCE:    { weight: 0.25, label: 'Guideline adherence' },
  REPORTING_TIMELINESS:   { weight: 0.15, label: 'Reporting timeliness' },
  TRANSACTION_ACCURACY:   { weight: 0.15, label: 'Transaction accuracy' },
  RISK_MANAGEMENT:        { weight: 0.10, label: 'Risk management' },
  RESPONSE_TIME:          { weight: 0.10, label: 'Response time' },
});

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT ACTIONS
// ─────────────────────────────────────────────────────────────────────────────
export const AUDIT_ACTIONS = Object.freeze([
  'TRANSACTION_CREATED',
  'TRANSACTION_VALIDATED',
  'TRANSACTION_APPROVED',
  'TRANSACTION_EXECUTED',
  'TRANSACTION_FAILED',
  'TRANSACTION_CANCELLED',
  'BUDGET_PROPOSED',
  'BUDGET_VOTED',
  'BUDGET_APPROVED',
  'BUDGET_REVISED',
  'COURT_APPROVAL_UPLOADED',
  'CF_CREATED',
  'CF_DEPOSIT',
  'CF_WITHDRAWAL',
  'CF_RECONCILED',
  'TRUSTEE_REGISTERED',
  'TRUSTEE_REVOKED',
  'TRUSTEE_SCORE_UPDATED',
  'EXCHANGE_RATE_RECORDED',
  'ORACLE_CONFIRMED',
]);

// ─────────────────────────────────────────────────────────────────────────────
// LOCALSTORAGE / DATASTORE NAMESPACES
// ─────────────────────────────────────────────────────────────────────────────
// Namespace under which the gov_v3 implementation persists payment data via
// the existing `storage` helper. Other consumers (FTR/GDP/DAC) keep their
// existing storage but mirror state via the SDK's writeBack callback.
// ─────────────────────────────────────────────────────────────────────────────
export const STORE_KEYS = Object.freeze({
  CORPUS_FUNDS:      'paa.corpusFunds',
  TRANSACTIONS:      'paa.transactions',
  BUDGETS:           'paa.budgets',
  ACTIVE_BUDGET_ID:  'paa.activeBudgetId',
  TRUSTEES:          'paa.trustees',
  RULE_CHANGES:      'paa.ruleChanges',
  AUDIT_LOG:         'paa.auditLog',
  EXCHANGE_RATES:    'paa.exchangeRates',
  COURT_APPROVALS:   'paa.courtApprovals',
  SETTINGS:          'paa.settings',
});

// ─────────────────────────────────────────────────────────────────────────────
// HUMAN-FRIENDLY LABELS (for the UI dropdowns and badges)
// ─────────────────────────────────────────────────────────────────────────────
export const CATEGORY_LABELS = Object.freeze({
  trot_book_sale:           'Trot Book Sale',
  license_fee:              'License Fee',
  irg_gdp_sale:             'IRG GDP Sale',
  irg_ftr_sale:             'IRG FTR Sale',
  default_compensation:     'Default Compensation',
  recall_compensation:      'Recall Compensation',
  recall_insurance_claim:   'Recall Insurance Claim',
  dac_charges:              'DAC Charges',
  advertisement_charges:    'Advertisement Charges',
  referral_commission_ftr:  'FTR Referral Commission',
  ftr_minting_cost:         'FTR Minting Cost',
  gdp_minting_cost:         'GDP Minting Cost',
  ftr_recall_costs:         'FTR Recall Costs',
  gdp_shortfall:            'GDP Shortfall',
  gdp_recovery:             'GDP Recovery',
  roi_investment_proceeds:  'ROI / Investment Proceeds',
  trade_profit:             'Trade Profit',
  tgdp_ftr_gic_jr_sale:     'TGDP / FTR / GIC / JR Sale',
  jewelry_designer_charges: 'Jewelry Designer Charges',
  cross_currency_gain:      'Cross-Currency Gain',
  system_support_charges:   'System Support Charges',
  other_collection:         'Other Collection',
  advisory_board_expense:   'Advisory Board Expense',
  taxes:                    'Taxes',
  investments:              'Investments',
  trust_beneficiary_income: 'Trust Beneficiary Income',
  cross_currency_loss:      'Cross-Currency Loss',
  operational_expense:      'Operational Expense',
  other_payment:            'Other Payment',
});

export const CF_TYPE_LABELS = Object.freeze({
  IRG_CF:       'IRG Super Corpus Fund',
  IRG_Local_CF: 'IRG Local Corpus Fund',
  Minter_CF:    "Minter's Corpus Fund",
  Jeweler_CF:   "Jeweler's Corpus Fund",
});

export const STATUS_VARIANTS = Object.freeze({
  pending:          'default',
  validated:        'info',
  pending_approval: 'warning',
  pending_dual:     'warning',
  pending_board:    'danger',
  approved:         'info',
  executed:         'success',
  failed:           'danger',
  court_pending:    'warning',
  cancelled:        'default',
});

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
export function isCollectionCategory(category) {
  // Anything not in the payment list is a collection (inflow).
  const PAYMENT_CATS = new Set([
    'advisory_board_expense', 'taxes', 'investments',
    'trust_beneficiary_income', 'cross_currency_loss',
    'operational_expense', 'other_payment',
    'recall_compensation', 'recall_insurance_claim',
    'ftr_recall_costs', 'gdp_shortfall',
  ]);
  return !PAYMENT_CATS.has(category);
}

export function getRoutingFor(category) {
  return CATEGORY_ROUTING[category] || 'IRG_Local_CF';
}

export function getOracleRequirementsFor(category) {
  return ORACLE_REQUIREMENTS[category] || [];
}

export function getApprovalLevelFor(usdAmount) {
  if (usdAmount >= APPROVAL_THRESHOLDS_USD.COURT_APPROVAL) return 'court';
  if (usdAmount >= APPROVAL_THRESHOLDS_USD.BOARD_APPROVAL) return 'board';
  if (usdAmount >= APPROVAL_THRESHOLDS_USD.DUAL_APPROVAL)  return 'dual';
  return 'single';
}

export default {
  PAYMENTS_SCHEMA_VERSION,
  USER_ROLES,
  CORPUS_FUND_TYPES,
  SUPER_CORPUS_FUND_TYPE,
  TRANSACTION_TYPES,
  TRANSACTION_CATEGORIES,
  TRANSACTION_STATUSES,
  SUPPORTED_CURRENCIES,
  CURRENCY_DECIMALS,
  CURRENCY_SYMBOLS,
  CATEGORY_ROUTING,
  ORACLE_REQUIREMENTS,
  ORACLE_TYPES,
  APPROVAL_THRESHOLDS_USD,
  DEFAULT_CHARGE_RATES,
  COMPLIANCE_FACTORS,
  AUDIT_ACTIONS,
  STORE_KEYS,
  CATEGORY_LABELS,
  CF_TYPE_LABELS,
  STATUS_VARIANTS,
  isCollectionCategory,
  getRoutingFor,
  getOracleRequirementsFor,
  getApprovalLevelFor,
};
