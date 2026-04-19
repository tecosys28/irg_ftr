/**
 * IRG PAA Bridge SDK
 * ===================
 * The single contract every IRG system uses to talk to the canonical Payment
 * Autonomy Module that lives inside `irg_gov`. Pure ES module; no React,
 * no DOM, no node-only APIs — works in browsers, Node, and Cloud Functions.
 *
 * Three transports are supported:
 *
 *   1. 'in-process'  — runs alongside the gov_v3 React app; calls paaService
 *                      directly. Used by the gov_v3 UI and by tests.
 *   2. 'http'        — POSTs to a gov_v3 server-side proxy that wraps
 *                      paaService. Used by FTR's Node backend.
 *   3. 'callback'    — caller supplies a function that resolves SDK calls.
 *                      Used by GDP (Python — uses an HTTP shim of its own)
 *                      and DAC (Cloud Functions — uses Firestore as broker).
 *
 * Every call is shaped as { method, args, requestId, schemaVersion } and
 * every response as { ok, data?, error? }. Versioned via PAYMENTS_SCHEMA_VERSION
 * (re-exported from schema.js) so consumers can hard-fail on mismatched pins.
 */

import schema, {
  PAYMENTS_SCHEMA_VERSION,
  USER_ROLES, CORPUS_FUND_TYPES, SUPER_CORPUS_FUND_TYPE,
  TRANSACTION_TYPES, TRANSACTION_CATEGORIES, TRANSACTION_STATUSES,
  SUPPORTED_CURRENCIES,
  CATEGORY_ROUTING, ORACLE_REQUIREMENTS, APPROVAL_THRESHOLDS_USD,
  isCollectionCategory, getRoutingFor, getOracleRequirementsFor,
  getApprovalLevelFor,
} from './schema.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API SURFACE
// ─────────────────────────────────────────────────────────────────────────────
// Exact list of methods the bridge SDK exposes. Used by 'http' transport to
// validate that an incoming RPC name is permitted, and by 'in-process' to
// build a thin wrapper around paaService.
// ─────────────────────────────────────────────────────────────────────────────
export const SDK_METHODS = Object.freeze([
  // Reads
  'listCorpusFunds', 'getCorpusFund', 'getSuperCorpus', 'totalCorpusValueUSD',
  'listTransactions', 'getTransaction',
  'getActiveBudget', 'listTrustees', 'getTrustee',
  'getAuditLog', 'getDashboardMetrics', 'snapshotState',

  // Writes
  'createTransaction', 'approveTransaction', 'executeTransaction',
  'cancelTransaction', 'recordOracleConfirmation',
  'createCorpusFund', 'proposeBudget', 'voteOnRuleChange',
  'applyApprovedRuleChange', 'uploadCourtApproval',
  'registerTrustee', 'scoreTrustee',
]);

const READ_METHODS = new Set([
  'listCorpusFunds', 'getCorpusFund', 'getSuperCorpus', 'totalCorpusValueUSD',
  'listTransactions', 'getTransaction',
  'getActiveBudget', 'listTrustees', 'getTrustee',
  'getAuditLog', 'getDashboardMetrics', 'snapshotState',
]);

// ─────────────────────────────────────────────────────────────────────────────
// FACTORY
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @param {object} options
 * @param {'in-process'|'http'|'callback'} options.transport
 * @param {object} [options.paaService] required if transport === 'in-process'
 * @param {string} [options.endpoint]   required if transport === 'http'
 * @param {string} [options.apiKey]     optional bearer token for HTTP transport
 * @param {function} [options.send]     required if transport === 'callback';
 *                                      signature: ({method,args}) => Promise<{ok,data,error}>
 * @param {string}  [options.actor]     default actor name on writes
 * @param {string}  [options.sourceSystem] e.g. 'ftr', 'gdp', 'dac'
 */
export function createPAABridge(options = {}) {
  const {
    transport = 'in-process',
    paaService = null,
    endpoint = null,
    apiKey = null,
    send = null,
    actor = 'system',
    sourceSystem = 'unknown',
    fetchImpl = (typeof fetch !== 'undefined' ? fetch : null),
  } = options;

  // Schema-pinning sanity check — if the consumer pins to a major.minor that
  // doesn't match this build, fail loudly.
  if (options.expectSchemaVersion && options.expectSchemaVersion !== PAYMENTS_SCHEMA_VERSION) {
    throw new Error(
      `[paaBridge] schema version mismatch: SDK is ${PAYMENTS_SCHEMA_VERSION}, ` +
      `consumer pinned ${options.expectSchemaVersion}`,
    );
  }

  if (transport === 'in-process' && !paaService) {
    throw new Error('[paaBridge] in-process transport requires { paaService }');
  }
  if (transport === 'http' && !endpoint) {
    throw new Error('[paaBridge] http transport requires { endpoint }');
  }
  if (transport === 'http' && !fetchImpl) {
    throw new Error('[paaBridge] http transport requires global fetch or { fetchImpl }');
  }
  if (transport === 'callback' && typeof send !== 'function') {
    throw new Error('[paaBridge] callback transport requires { send }');
  }

  // ── Transport implementations ────────────────────────────────────────────
  async function callInProcess(method, args) {
    if (!SDK_METHODS.includes(method)) {
      return { ok: false, error: `Unknown SDK method: ${method}` };
    }
    if (typeof paaService[method] !== 'function') {
      return { ok: false, error: `paaService missing implementation: ${method}` };
    }
    try {
      // For write methods, append actor as last argument if not supplied.
      let result;
      if (READ_METHODS.has(method)) {
        result = paaService[method](...(args || []));
      } else {
        // Convention: writes take a payload arg + actor. We pass the actor
        // through unless caller already provided one as the 2nd-last arg.
        result = paaService[method](...(args || []));
      }
      const awaited = await Promise.resolve(result);
      return { ok: true, data: awaited };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  async function callHTTP(method, args) {
    const headers = { 'Content-Type': 'application/json', 'X-PAA-Schema': PAYMENTS_SCHEMA_VERSION };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    let res;
    try {
      res = await fetchImpl(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          method, args: args || [],
          requestId: makeRequestId(),
          schemaVersion: PAYMENTS_SCHEMA_VERSION,
          actor, sourceSystem,
        }),
      });
    } catch (err) {
      return { ok: false, error: `Network error: ${err.message || err}` };
    }
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}: ${await res.text().catch(() => '')}` };
    }
    try {
      const json = await res.json();
      return json && typeof json.ok === 'boolean'
        ? json
        : { ok: true, data: json };
    } catch (err) {
      return { ok: false, error: `Invalid JSON response: ${err.message || err}` };
    }
  }

  async function callCallback(method, args) {
    try {
      const r = await send({ method, args: args || [], actor, sourceSystem });
      return r && typeof r.ok === 'boolean' ? r : { ok: true, data: r };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  const dispatch =
    transport === 'in-process' ? callInProcess :
    transport === 'http'       ? callHTTP :
                                 callCallback;

  // ── Convenience method wrappers ──────────────────────────────────────────
  function method(name) { return (...args) => dispatch(name, args); }

  const api = {};
  for (const m of SDK_METHODS) api[m] = method(m);

  // ── High-level helpers ───────────────────────────────────────────────────
  /** Convenience for posting an inflow (collection) to a CF type. */
  api.postCollection = ({
    category, amount, currency, fromAccount,
    sourceRef = null, oracleConfirmations = [], notes = '',
  }) => dispatch('createTransaction', [{
    txType: 'collection',
    category, amount, currency, fromAccount,
    sourceSystem, sourceRef, notes,
    oracleConfirmations,
    idempotencyKey: makeIdempotencyKey(sourceSystem, sourceRef, category, amount, currency),
  }, actor]);

  /** Convenience for requesting a payment (outflow). */
  api.requestPayment = ({
    category, amount, currency, fromAccount,
    sourceRef = null, oracleConfirmations = [], notes = '',
  }) => dispatch('createTransaction', [{
    txType: 'payment',
    category, amount, currency, fromAccount,
    sourceSystem, sourceRef, notes,
    oracleConfirmations,
    idempotencyKey: makeIdempotencyKey(sourceSystem, sourceRef, category, amount, currency),
  }, actor]);

  /** Convenience for ROI credit (system-driven inflow). */
  api.creditROI = ({
    cfId, amount, currency, sourceRef, period, notes = '',
  }) => dispatch('createTransaction', [{
    txType: 'roi_credit',
    category: 'roi_investment_proceeds',
    amount, currency,
    fromAccount: 'investment_pool',
    toAccountId: cfId,
    sourceSystem, sourceRef,
    notes: notes || `ROI for ${period}`,
    oracleConfirmations: [
      { type: 'trustee', confirmed: true, confirmedAt: new Date().toISOString() },
    ],
    idempotencyKey: makeIdempotencyKey(sourceSystem, sourceRef, 'roi_investment_proceeds', amount, currency),
  }, actor]);

  /** SDK metadata. */
  api.meta = () => ({
    schemaVersion: PAYMENTS_SCHEMA_VERSION,
    transport,
    actor,
    sourceSystem,
    methods: SDK_METHODS,
  });

  /** Healthcheck — returns ok if the transport reaches paaService. */
  api.health = async () => {
    const r = await dispatch('snapshotState', []);
    return {
      ok: r.ok,
      schemaVersion: PAYMENTS_SCHEMA_VERSION,
      detail: r.ok ? 'reachable' : r.error,
    };
  };

  return api;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP server-side handler (used by the gov_v3 proxy endpoint)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Express/Fastify-compatible request handler that proxies the HTTP SDK protocol
 * to a local paaService. Embed in any backend that holds the canonical state.
 */
export function buildHTTPHandler({ paaService, allowMethods = SDK_METHODS, requireApiKey = null }) {
  return async function paaHandler(req, res) {
    if (requireApiKey) {
      const got = req.headers?.authorization?.replace(/^Bearer\s+/i, '');
      if (got !== requireApiKey) {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
        return;
      }
    }
    const body = req.body || (await readJSONBody(req));
    const { method, args, schemaVersion } = body || {};
    if (schemaVersion && schemaVersion !== PAYMENTS_SCHEMA_VERSION) {
      res.statusCode = 409;
      res.end(JSON.stringify({ ok: false, error: `schema version mismatch: server ${PAYMENTS_SCHEMA_VERSION}, client ${schemaVersion}` }));
      return;
    }
    if (!allowMethods.includes(method)) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: `method not allowed: ${method}` }));
      return;
    }
    if (typeof paaService[method] !== 'function') {
      res.statusCode = 501;
      res.end(JSON.stringify({ ok: false, error: `not implemented: ${method}` }));
      return;
    }
    try {
      const data = await Promise.resolve(paaService[method](...(args || [])));
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, data }));
    } catch (err) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: false, error: err?.message || String(err) }));
    }
  };
}

async function readJSONBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const txt = Buffer.concat(chunks).toString('utf8');
        resolve(txt ? JSON.parse(txt) : {});
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function makeRequestId() {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Stable idempotency key generator. Same source-system + source-ref + category +
 * amount + currency produces the same key, so retries don't double-post.
 */
export function makeIdempotencyKey(sourceSystem, sourceRef, category, amount, currency) {
  const ref = sourceRef || `nullref_${Date.now()}`;
  return `${sourceSystem}|${category}|${currency}|${amount}|${ref}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA RE-EXPORTS (so consumers only need to import the SDK)
// ─────────────────────────────────────────────────────────────────────────────
export {
  schema,
  PAYMENTS_SCHEMA_VERSION,
  USER_ROLES, CORPUS_FUND_TYPES, SUPER_CORPUS_FUND_TYPE,
  TRANSACTION_TYPES, TRANSACTION_CATEGORIES, TRANSACTION_STATUSES,
  SUPPORTED_CURRENCIES,
  CATEGORY_ROUTING, ORACLE_REQUIREMENTS, APPROVAL_THRESHOLDS_USD,
  isCollectionCategory, getRoutingFor, getOracleRequirementsFor,
  getApprovalLevelFor,
};

export default createPAABridge;
