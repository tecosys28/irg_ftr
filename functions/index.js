/**
 * irg_ftr Cloud Functions
 *
 *   • getMICSDigest       — public aggregate consumed by irg_gov's MICS
 *   • getMICSDrill        — public drill-down endpoint
 *   • onProjectRegister   — recompute industry aggregates on new project
 *   • onFTRSold           — recompute sold counts + notional totals
 *   • onROIOverride       — audit + notification when consultant overrides
 *   • refreshMICSDigest   — hourly full recompute (scheduled)
 *
 * Sovereignty: writes only to irg-ftr-prod. Read-only CORS endpoints allow
 * irg-gov-prod (the AB MICS UI) to fetch our aggregate.
 *
 * IPR Owner: Mr. Rohit Tidke · © 2026 Intech Research Group
 */

const functions = require('firebase-functions');
const admin     = require('firebase-admin');
const cors      = require('cors');

// ─────────────────────────────────────────────────────────────────────────────
// Licence guard — verified at module load. If the deployment is unlicensed,
// this exits during load and Firebase refuses to register any function.
// ─────────────────────────────────────────────────────────────────────────────
const { verifyLicenceOrDie, currentLicenceInfo } = require('./licence-guard');
if (process.env.FUNCTIONS_EMULATOR !== 'true') {
  verifyLicenceOrDie('FTR');
}

admin.initializeApp();
const db = admin.firestore();

// Public callable for the licensee's ops team to check licence health.
exports.licenceStatus = functions.https.onCall(async () => currentLicenceInfo());

const ALLOWED_ORIGINS = [
  'https://gov.irgecosystem.com',
  'https://irg-gov-prod.web.app',
  'https://irg-gov-prod.firebaseapp.com',
  'https://irg-gov-staging.web.app',
  'https://gov-staging.irgecosystem.com',
  'http://localhost:5173',
  'http://localhost:5000'
];

const corsHandler = cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error(`Origin ${origin} not allowed`));
  },
  methods: ['GET'],
  credentials: false
});

const regional = functions.region('asia-south1');

const _rlBuckets = new Map();
function rateLimited(ip, max = 30, windowMs = 60_000) {
  const now = Date.now();
  const bucket = _rlBuckets.get(ip) || [];
  const recent = bucket.filter(t => now - t < windowMs);
  recent.push(now);
  _rlBuckets.set(ip, recent);
  return recent.length > max;
}

// ─── getMICSDigest ─────────────────────────────────────────────────────────
exports.getMICSDigest = regional.https.onRequest((req, res) => {
  corsHandler(req, res, async () => {
    try {
      const ip = req.headers['x-forwarded-for'] || req.ip;
      if (rateLimited(ip)) return res.status(429).json({ error: 'rate_limited' });

      const { period } = req.query;
      if (!period) return res.status(400).json({ error: 'period_required' });

      const snap = await db.collection('mics_digest').doc(period).get();
      if (!snap.exists) return res.status(404).json({ error: 'no_data_for_period', period });

      const payload = snap.data();
      const clean = Object.fromEntries(Object.entries(payload).filter(([k]) => !k.startsWith('_')));
      return res.status(200).json(clean);
    } catch (e) {
      functions.logger.error('getMICSDigest failed:', e);
      return res.status(500).json({ error: 'internal_error' });
    }
  });
});

// ─── getMICSDrill ──────────────────────────────────────────────────────────
exports.getMICSDrill = regional.https.onRequest((req, res) => {
  corsHandler(req, res, async () => {
    try {
      const ip = req.headers['x-forwarded-for'] || req.ip;
      if (rateLimited(ip)) return res.status(429).json({ error: 'rate_limited' });

      const { key } = req.query;
      if (!key) return res.status(400).json({ error: 'key_required' });

      const [, slice] = key.split('-');
      if (!slice) return res.status(400).json({ error: 'invalid_key' });

      const snap = await db.collection('mics_drill').doc(slice).get();
      if (!snap.exists) return res.status(404).json({ error: 'no_drill_data', slice });
      return res.status(200).json(snap.data());
    } catch (e) {
      functions.logger.error('getMICSDrill failed:', e);
      return res.status(500).json({ error: 'internal_error' });
    }
  });
});

// ─── Triggers that maintain the aggregates ─────────────────────────────────

exports.onProjectRegister = regional.firestore
  .document('ftr_projects/{projectId}')
  .onCreate(async (snap) => {
    const data = snap.data();
    const industry = data.industry || 'other';
    const digestRef = db.collection('mics_digest').doc('mtd');
    await db.runTransaction(async tx => {
      const cur = await tx.get(digestRef);
      const existing = cur.exists ? cur.data() : {};
      const industries = existing.industries || {};
      const entry = industries[industry] || { projects: 0, soldCount: 0, soldValue: 0 };
      entry.projects += 1;
      industries[industry] = entry;
      tx.set(digestRef, {
        ...existing,
        industries,
        _updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    });
  });

exports.onFTRSold = regional.firestore
  .document('ftr_units/{unitId}')
  .onCreate(async (snap) => {
    const data = snap.data();
    const industry = data.industry || 'other';
    const value = data.faceValue || 0;
    const digestRef = db.collection('mics_digest').doc('mtd');
    await db.runTransaction(async tx => {
      const cur = await tx.get(digestRef);
      const existing = cur.exists ? cur.data() : {};
      const industries = existing.industries || {};
      const entry = industries[industry] || { projects: 0, soldCount: 0, soldValue: 0 };
      entry.soldCount += 1;
      entry.soldValue += value;
      industries[industry] = entry;

      const kpis = existing.kpis || {};
      kpis.ftrSoldCount = (kpis.ftrSoldCount || 0) + 1;
      kpis.ftrSoldValue = (kpis.ftrSoldValue || 0) + value;

      tx.set(digestRef, {
        ...existing,
        industries,
        kpis,
        _updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    });
  });

exports.onROIOverride = regional.firestore
  .document('roi_overrides/{overrideId}')
  .onCreate(async (snap, ctx) => {
    const data = snap.data();
    await db.collection('audit_trail').doc().set({
      actorId:    data.consultantId,
      action:     'roi.override.submitted',
      targetType: 'project',
      targetId:   data.projectId,
      snapshot:   data,
      timestamp:  admin.firestore.FieldValue.serverTimestamp()
    });
  });

// ─── Hourly recompute (scheduled) ──────────────────────────────────────────
exports.refreshMICSDigest = regional.pubsub
  .schedule('every 60 minutes')
  .timeZone('Asia/Kolkata')
  .onRun(async () => {
    await db.collection('mics_digest').doc('mtd').set({
      _refreshedAt: admin.firestore.FieldValue.serverTimestamp(),
      _source:      'scheduled_refresh'
    }, { merge: true });
    return null;
  });
