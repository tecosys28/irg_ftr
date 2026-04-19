/**
 * irg_ftr — Firebase client config for the Vite/TS frontend.
 * Project: irg-ftr-prod (sovereign)
 */
import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth, connectAuthEmulator } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore';
import { getFunctions, connectFunctionsEmulator } from 'firebase/functions';
import { getStorage, connectStorageEmulator } from 'firebase/storage';

const cfg = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN  || 'irg-ftr-prod.firebaseapp.com',
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID   || 'irg-ftr-prod',
  storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET|| 'irg-ftr-prod.appspot.com',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId:             import.meta.env.VITE_FIREBASE_APP_ID
};

export const firebaseApp = getApps().length ? getApp() : initializeApp(cfg);
export const auth      = getAuth(firebaseApp);
export const db        = getFirestore(firebaseApp);
export const functions = getFunctions(firebaseApp, 'asia-south1');
export const storage   = getStorage(firebaseApp);

if (import.meta.env.VITE_USE_EMULATORS === 'true' && typeof window !== 'undefined') {
  try {
    connectAuthEmulator(auth, 'http://localhost:9099', { disableWarnings: true });
    connectFirestoreEmulator(db,        'localhost', 8080);
    connectFunctionsEmulator(functions, 'localhost', 5001);
    connectStorageEmulator(storage,     'localhost', 9199);
  } catch { /* already connected */ }
}

export default firebaseApp;
