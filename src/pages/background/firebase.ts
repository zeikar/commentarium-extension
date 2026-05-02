import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth/web-extension";

const REQUIRED = [
  "VITE_FIREBASE_API_KEY",
  "VITE_FIREBASE_AUTH_DOMAIN",
  "VITE_FIREBASE_PROJECT_ID",
  "VITE_FIREBASE_APP_ID",
] as const;

function readConfig() {
  const env = import.meta.env;
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(
      `firebase.ts: missing required env keys: ${missing.join(", ")}. ` +
        `Set them in .env.local (see .env.example).`,
    );
  }
  return {
    apiKey: env.VITE_FIREBASE_API_KEY,
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: env.VITE_FIREBASE_PROJECT_ID,
    appId: env.VITE_FIREBASE_APP_ID,
  };
}

const app = initializeApp(readConfig());
export const auth = getAuth(app);
