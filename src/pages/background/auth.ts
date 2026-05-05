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

async function signInGoogleOp(): Promise<AuthResponse> {
  // Drive the OAuth implicit flow through launchWebAuthFlow so the SW
  // gets a deterministic cancel signal: the Promise rejects when the
  // user closes the OAuth window, and the redirect URL fragment carries
  // error=access_denied if the provider denies. response_type=token
  // keeps the existing GoogleAuthProvider.credential(null, accessToken)
  // call unchanged from the legacy chrome.identity.getAuthToken path.
  const state = crypto.randomUUID();
  const params = new URLSearchParams({
    client_id: import.meta.env.VITE_GOOGLE_OAUTH_WEB_CLIENT_ID,
    redirect_uri: chrome.identity.getRedirectURL(),
    response_type: "token",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  });

  let responseUrl: string | undefined;
  try {
    responseUrl = await chrome.identity.launchWebAuthFlow({
      url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
      interactive: true,
    });
  } catch (err) {
    // Chrome rejects when the user closes the window before redirect.
    return {
      error: {
        code: "auth/popup-closed-by-user",
        message: err instanceof Error ? err.message : "Sign-in was cancelled.",
      },
    };
  }
  if (!responseUrl) {
    return {
      error: {
        code: "auth/popup-closed-by-user",
        message: "Sign-in was cancelled.",
      },
    };
  }

  // Defense at the OAuth boundary: a malformed redirect must not blow
  // up the SW with an uncaught URL parse exception.
  let parsed: URL;
  try {
    parsed = new URL(responseUrl);
  } catch {
    return {
      error: {
        code: "identity/invalid-redirect-url",
        message: "redirect URL from launchWebAuthFlow could not be parsed",
      },
    };
  }
  const fragment = new URLSearchParams(parsed.hash.slice(1));

  // Verify state first, before reading any other field from the redirect.
  // Both success and error responses echo state; gating downstream on
  // this check stops a CSRF response from being smuggled in as a cancel.
  if (fragment.get("state") !== state) {
    return {
      error: {
        code: "identity/state-mismatch",
        message: "OAuth state did not match; possible CSRF.",
      },
    };
  }

  const oauthError = fragment.get("error");
  if (oauthError) {
    return {
      error: {
        code:
          oauthError === "access_denied"
            ? "auth/popup-closed-by-user"
            : "identity/oauth-error",
        message: fragment.get("error_description") ?? oauthError,
      },
    };
  }
  const accessToken = fragment.get("access_token");
  if (!accessToken) {
    return {
      error: {
        code: "identity/no-access-token",
        message: "no access_token in redirect URL",
      },
    };
  }

  try {
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

  // Best-effort: clear any legacy chrome.identity.getAuthToken cache.
  // The current launchWebAuthFlow path forces the chooser via
  // prompt=select_account in the OAuth URL, so this call is defensive
  // cleanup of stale state from pre-migration sign-ins. Runs even when
  // firebaseSignOut threw.
  try {
    await chrome.identity.clearAllCachedAuthTokens();
  } catch (err) {
    bestEffortError ??= err;
  }

  if (bestEffortError) throw bestEffortError;
}

export {};
