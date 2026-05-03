import {
  GoogleAuthProvider,
  signInAnonymously,
  signInWithCredential,
  signOut as firebaseSignOut,
} from "firebase/auth/web-extension";
import { auth } from "./firebase";

const ALLOWED_ORIGIN = "https://commentarium.app";
const TYPE_NAMESPACE = "commentarium.auth.";
const LOGIN_URL = "https://commentarium.app/api/login";
const COOKIE_URL = "https://commentarium.app/";
const COOKIE_NAME = "session";
const SURFACE_HEADER = "X-Commentarium-Surface";

type AuthError = { code: string; message: string };
type AuthResponse =
  | { ok: true }
  | { ok: true; idToken: string }
  | { idToken: string }
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

function canonicalPartitionKey(
  pk: chrome.cookies.CookiePartitionKey,
): string {
  const tls = pk.topLevelSite ?? "";
  const csa = pk.hasCrossSiteAncestor ? "1" : "0";
  return `${tls}|csa=${csa}`;
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

async function mintAndWriteCookie(args: {
  idToken: string;
  sender: chrome.runtime.MessageSender;
}): Promise<void> {
  const { idToken, sender } = args;
  const tabId = sender.tab!.id!;
  const frameId = sender.frameId!;

  const response = await fetch(LOGIN_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${idToken}`,
      [SURFACE_HEADER]: "extension",
      "Content-Type": "application/json",
    },
  });
  if (!response.ok) {
    throw {
      code: "auth/login-failed",
      message: `POST /api/login returned ${response.status}`,
    } satisfies AuthError;
  }
  const body = (await response.json()) as {
    session: string;
    expiresAtSeconds: number;
  };

  const { partitionKey } = await chrome.cookies.getPartitionKey({
    tabId,
    frameId,
  });

  const written = await chrome.cookies.set({
    url: COOKIE_URL,
    name: COOKIE_NAME,
    value: body.session,
    expirationDate: body.expiresAtSeconds,
    secure: true,
    httpOnly: true,
    sameSite: "no_restriction",
    partitionKey,
  });
  if (!written) {
    throw {
      code: "auth/cookie-write-failed",
      message: "chrome.cookies.set returned no cookie",
    } satisfies AuthError;
  }

  await chrome.storage.local.set({
    [`partitionRegistry:${canonicalPartitionKey(partitionKey)}`]: partitionKey,
  });
}

chrome.runtime.onMessageExternal.addListener(
  (rawMsg, sender, sendResponse): boolean => {
    if (sender.origin !== ALLOWED_ORIGIN) return false;
    const msg = rawMsg as { type?: string } | null;
    const type = msg?.type;
    if (typeof type !== "string" || !type.startsWith(TYPE_NAMESPACE))
      return false;
    if (!pathAllowedForType(type, sender.url)) return false;
    if (sender.tab?.id == null || sender.frameId == null) return false;

    void handle(type, sender).then(
      (resp) => sendResponse(resp),
      (err) =>
        sendResponse({ error: asAuthError(err) }),
    );
    return true;
  },
);

async function handle(
  type: string,
  sender: chrome.runtime.MessageSender,
): Promise<AuthResponse> {
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
  try {
    // The Promise form of chrome.identity.getAuthToken returns a
    // GetAuthTokenResult object, not a bare string. The string is the legacy
    // callback-API shape. Extract .token explicitly.
    const tokenResult = await chrome.identity.getAuthToken({
      interactive: true,
    });
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
