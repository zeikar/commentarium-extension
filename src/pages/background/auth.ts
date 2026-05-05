import {
  GoogleAuthProvider,
  signInAnonymously,
  signInWithCredential,
  signOut as firebaseSignOut,
} from "firebase/auth/web-extension";
import { auth } from "./firebase";

const ALLOWED_ORIGIN = "https://commentarium.app";
const TYPE_NAMESPACE = "commentarium.auth.";

type AuthError = { code: string; message: string };
type AuthResponse =
  | { ok: true }                  // signOut
  | { ok: true; idToken: string } // signIn.* + refreshSession
  | { idToken: string }           // getIdToken (handoff)
  | { error: AuthError; signedOut?: boolean };

function isIframeSurface(url: string | undefined): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.origin === ALLOWED_ORIGIN &&
    parsed.pathname === "/comments" &&
    parsed.searchParams.get("surface") === "extension"
  );
}

function isHandoffSurface(url: string | undefined): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.origin === ALLOWED_ORIGIN && parsed.pathname === "/auth/handoff"
  );
}

function pathAllowedForType(type: string, url: string | undefined): boolean {
  if (type === "commentarium.auth.getIdToken") return isHandoffSurface(url);
  return isIframeSurface(url);
}

function asAuthError(err: unknown): AuthError {
  if (err && typeof err === "object" && "code" in err && "message" in err) {
    const e = err as { code: unknown; message: unknown };
    if (typeof e.code === "string" && typeof e.message === "string") {
      return { code: e.code, message: e.message };
    }
  }
  return { code: "auth/internal-error", message: String(err) };
}

chrome.runtime.onMessageExternal.addListener(
  (rawMsg, sender, sendResponse): boolean => {
    if (sender.origin !== ALLOWED_ORIGIN) return false;
    const msg = rawMsg as { type?: string } | null;
    const type = msg?.type;
    if (typeof type !== "string" || !type.startsWith(TYPE_NAMESPACE))
      return false;
    if (!pathAllowedForType(type, sender.url)) return false;

    void handle(type).then(
      (resp) => sendResponse(resp),
      (err) =>
        sendResponse({ error: asAuthError(err) }),
    );
    return true;
  },
);

async function handle(type: string): Promise<AuthResponse> {
  await auth.authStateReady();
  switch (type) {
    case "commentarium.auth.signIn.anonymous":
      return signInAnonymousOp();
    case "commentarium.auth.signIn.google":
      return signInGoogleOp();
    case "commentarium.auth.refreshSession":
      return refreshSessionOp();
    case "commentarium.auth.signOut":
      return signOutOp();
    case "commentarium.auth.getIdToken":
      return getIdTokenOp();
    default:
      return {
        error: {
          code: "auth/not-implemented",
          message: `unimplemented op: ${type}`,
        },
      };
  }
}

async function signInAnonymousOp(): Promise<AuthResponse> {
  try {
    await signInAnonymously(auth);
    if (!auth.currentUser) {
      return {
        error: {
          code: "auth/no-current-user",
          message: "signInAnonymously did not produce a user",
        },
      };
    }
    const idToken = await auth.currentUser.getIdToken();
    return { ok: true, idToken };
  } catch (err) {
    return { error: asAuthError(err) };
  }
}

// Hard cap on the interactive OAuth flow. Past this we surface a clean
// timeout error to the iframe so the spinner can stop. Kept well below
// Chrome's ~5-min MV3 service-worker lifetime cap — at the cap the SW
// can be killed *before* the timer fires, dropping the response and
// landing the iframe back in the original "channel closed" failure mode.
// 60s is plenty for a normal OAuth flow (~15-30s) and short enough that
// a cancel reads as a clean timeout rather than a hang.
const SIGN_IN_GOOGLE_TIMEOUT_MS = 60 * 1000;

async function signInGoogleOp(): Promise<AuthResponse> {
  // Hold the SW alive while interactive auth is pending. Without periodic
  // chrome.* activity, the 30s idle timeout can close the message channel
  // before chrome.identity.getAuthToken's callback fires on the cancel
  // path — the iframe then sees a generic "channel closed" error instead
  // of a proper response.
  const keepAlive = setInterval(() => {
    void chrome.runtime.getPlatformInfo().catch(() => {});
  }, 20_000);
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(
      () =>
        reject({
          code: "identity/timeout",
          message:
            "interactive auth timed out (no response from chooser)",
        }),
      SIGN_IN_GOOGLE_TIMEOUT_MS,
    );
  });
  try {
    // The Promise form of chrome.identity.getAuthToken returns a
    // GetAuthTokenResult object, not a bare string. The string is the legacy
    // callback-API shape. Extract .token explicitly.
    // Race against the timeout so a Chrome quirk that drops the cancel
    // callback can't leave the request hanging.
    const tokenResult = await Promise.race([
      chrome.identity.getAuthToken({ interactive: true }),
      timeoutPromise,
    ]);
    const accessToken = tokenResult?.token;
    if (!accessToken) {
      return {
        error: {
          code: "identity/no-token",
          message: "chrome.identity.getAuthToken returned no token",
        },
      };
    }
    const credential = GoogleAuthProvider.credential(null, accessToken);
    await signInWithCredential(auth, credential);
    if (!auth.currentUser) {
      return {
        error: {
          code: "auth/no-current-user",
          message: "signInWithCredential did not produce a user",
        },
      };
    }
    const idToken = await auth.currentUser.getIdToken();
    return { ok: true, idToken };
  } catch (err) {
    return { error: asAuthError(err) };
  } finally {
    clearInterval(keepAlive);
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
  }
}

async function refreshSessionOp(): Promise<AuthResponse> {
  if (!auth.currentUser) {
    // No live Firebase user — run sign-out cleanup as best-effort so
    // chrome.identity OAuth tokens are dropped. Cleanup failure must NOT
    // suppress the signedOut signal: the webapp's UI flips to signed-out
    // only when it sees this flag.
    await performSignOutCleanupBestEffort();
    return {
      error: { code: "auth/no-current-user", message: "no signed-in user" },
      signedOut: true,
    };
  }
  let idToken: string;
  try {
    idToken = await auth.currentUser.getIdToken(true);
  } catch (err) {
    await performSignOutCleanupBestEffort();
    return { error: asAuthError(err), signedOut: true };
  }
  return { ok: true, idToken };
}

async function performSignOutCleanupBestEffort(): Promise<void> {
  try {
    await performSignOutCleanup();
  } catch {
    // Swallowed deliberately — cleanup is best-effort on the refresh
    // signed-out path. signOutOp keeps surfacing cleanup errors via its
    // own try/catch (different contract: there, the user explicitly asked
    // to sign out and wants to know if it failed).
  }
}

async function signOutOp(): Promise<AuthResponse> {
  try {
    await performSignOutCleanup();
    return { ok: true };
  } catch (err) {
    return { error: asAuthError(err) };
  }
}

async function getIdTokenOp(): Promise<AuthResponse> {
  if (!auth.currentUser) {
    return {
      error: {
        code: "auth/no-current-user",
        message: "no signed-in user",
      },
    };
  }
  try {
    const idToken = await auth.currentUser.getIdToken(true);
    return { idToken };
  } catch (err) {
    return { error: asAuthError(err) };
  }
}

async function performSignOutCleanup(): Promise<void> {
  let bestEffortError: unknown;

  // Best-effort: clear in-memory Firebase user state.
  try {
    await firebaseSignOut(auth);
  } catch (err) {
    bestEffortError = err;
  }

  // Best-effort: clear Chrome's OAuth-token cache so the next signIn.google
  // shows the chooser. Runs even when firebaseSignOut threw.
  try {
    await chrome.identity.clearAllCachedAuthTokens();
  } catch (err) {
    bestEffortError ??= err;
  }

  if (bestEffortError) throw bestEffortError;
}

export {};
