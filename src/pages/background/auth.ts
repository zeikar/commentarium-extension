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
type AuthSuccessOk = { ok: true };
type AuthSuccessIdToken = { idToken: string };
type AuthFailure = { error: AuthError; signedOut?: boolean };
type AuthResponse = AuthSuccessOk | AuthSuccessIdToken | AuthFailure;

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
        sendResponse({ error: asAuthError(err) } satisfies AuthFailure),
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
      return signInAnonymousOp(sender);
    default:
      return {
        error: {
          code: "auth/not-implemented",
          message: `unimplemented op: ${type}`,
        },
      };
  }
}

async function signInAnonymousOp(
  sender: chrome.runtime.MessageSender,
): Promise<AuthResponse> {
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
    await mintAndWriteCookie({ idToken, sender });
    return { ok: true };
  } catch (err) {
    return { error: asAuthError(err) };
  }
}

export {};
