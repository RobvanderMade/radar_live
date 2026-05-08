import { initializeApp, type FirebaseApp } from 'firebase/app'
import { getDatabase } from 'firebase/database'

let app: FirebaseApp | undefined

export function getFirebaseApp(): FirebaseApp {
  if (app) return app

  const config = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
  }

  if (!config.databaseURL) {
    throw new Error(
      'VITE_FIREBASE_DATABASE_URL ontbreekt. Kopieer .env.example naar .env en vul je Firebase-config in.',
    )
  }

  app = initializeApp(config)
  return app
}

export function getRtdb() {
  return getDatabase(getFirebaseApp())
}
