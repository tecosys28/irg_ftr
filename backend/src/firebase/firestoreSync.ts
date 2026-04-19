/**
 * irg_ftr backend — Prisma ↔ Firestore sync bridge.
 *
 * Register as a Prisma extension so every create/update on the tracked
 * models mirrors into Firestore under irg-ftr-prod. This keeps the MICS
 * aggregate reader (`getMICSDigest`) authoritative.
 *
 * Usage (once, near Prisma client init):
 *   import { attachFirestoreSync } from './firebase/firestoreSync';
 *   export const prisma = new PrismaClient().$extends(attachFirestoreSync());
 */
import { getFirestore } from './admin';

type SyncHandler = (model: string, op: string, data: any, result: any) => Promise<void>;

const handlers: Record<string, SyncHandler> = {
  Project: async (_m, _op, _data, result) => {
    if (!result?.id) return;
    const fs = getFirestore();
    await fs.collection('ftr_projects').doc(String(result.id)).set({
      minterId:     result.minterId ?? null,
      name:         result.name ?? null,
      industry:     result.industry ?? null,
      countryCode:  result.countryCode ?? null,
      status:       result.status ?? null,
      registeredAt: result.registeredAt?.toISOString?.() ?? null,
      faceValue:    result.faceValue ?? null,
      roi:          result.roi ?? null,
      _source:      'prisma',
      _syncedAt:    new Date().toISOString()
    }, { merge: true });
  },

  FTRUnit: async (_m, _op, _data, result) => {
    if (!result?.id) return;
    const fs = getFirestore();
    await fs.collection('ftr_units').doc(String(result.id)).set({
      projectId:  result.projectId ?? null,
      holderId:   result.holderId ?? null,
      minterId:   result.minterId ?? null,
      industry:   result.industry ?? null,
      faceValue:  result.faceValue ?? null,
      issuedAt:   result.issuedAt?.toISOString?.() ?? null,
      status:     result.status ?? null,
      _source:    'prisma'
    }, { merge: true });
  },

  ROIOverride: async (_m, _op, _data, result) => {
    if (!result?.id) return;
    const fs = getFirestore();
    await fs.collection('roi_overrides').doc(String(result.id)).set({
      projectId:    result.projectId ?? null,
      consultantId: result.consultantId ?? null,
      baseROI:      result.baseROI ?? null,
      proposedROI:  result.proposedROI ?? null,
      category:     result.category ?? null,
      status:       result.status ?? null,
      submittedAt:  result.submittedAt?.toISOString?.() ?? null,
      _source:      'prisma'
    }, { merge: true });
  },

  Complaint: async (_m, _op, _data, result) => {
    if (!result?.id) return;
    const fs = getFirestore();
    await fs.collection('complaints').doc(String(result.id)).set({
      module:     result.module ?? null,
      status:     result.status ?? null,
      filedBy:    result.filedById ?? null,
      respondent: result.respondentId ?? null,
      ombudsman:  result.ombudsmanId ?? null,
      filedAt:    result.filedAt?.toISOString?.() ?? null,
      _source:    'prisma'
    }, { merge: true });
  }
};

export function attachFirestoreSync() {
  return {
    name: 'firestoreSync',
    query: {
      async $allOperations({ model, operation, args, query }: any) {
        const result = await query(args);
        const handler = handlers[model];
        if (handler && ['create', 'update', 'upsert'].includes(operation)) {
          // Fire-and-forget; never block the request on a mirror failure
          handler(model, operation, args, result).catch((err: any) => {
            // eslint-disable-next-line no-console
            console.warn(`[firestoreSync] ${model}.${operation} mirror failed:`, err?.message || err);
          });
        }
        return result;
      }
    }
  };
}
