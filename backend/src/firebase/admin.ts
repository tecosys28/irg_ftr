/**
 * irg_ftr backend — Firebase Admin SDK bootstrap (irg-ftr-prod).
 *
 * Reads credentials from either:
 *   • GOOGLE_APPLICATION_CREDENTIALS env var pointing to service-account JSON
 *   • FIREBASE_CREDENTIALS_JSON env var with raw JSON (Cloud Run friendly)
 *   • Application Default Credentials on Google Cloud
 *
 * Exposes the initialised Firestore and Auth clients for cross-module use.
 * This module writes to irg-ftr-prod's Firestore ONLY.
 */
import * as admin from 'firebase-admin';

let _app: admin.app.App | undefined;

export function getFirebaseApp(): admin.app.App {
  if (_app) return _app;

  const projectId = process.env.FIREBASE_PROJECT_ID || 'irg-ftr-prod';

  const rawJson  = process.env.FIREBASE_CREDENTIALS_JSON;
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  let credential: admin.credential.Credential;
  if (rawJson) {
    credential = admin.credential.cert(JSON.parse(rawJson));
  } else if (credPath) {
    credential = admin.credential.cert(credPath);
  } else {
    credential = admin.credential.applicationDefault();
  }

  _app = admin.initializeApp({ credential, projectId });
  return _app;
}

export function getFirestore() {
  return getFirebaseApp().firestore();
}

export function getAuth() {
  return getFirebaseApp().auth();
}
