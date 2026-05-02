const ALLOWED_ORIGIN = "https://commentarium.app";
const TYPE_NAMESPACE = "commentarium.auth.";

type AuthRequest = { type: string };

type AuthResponseSuccess = { ok: true } | { idToken: string };
type AuthError = { code: string; message: string };
type AuthResponseFailure = { error: AuthError; signedOut?: boolean };
type AuthResponse = AuthResponseSuccess | AuthResponseFailure;

function isIframeSurface(url: string | undefined): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.origin !== ALLOWED_ORIGIN) return false;
  if (parsed.pathname !== "/comments") return false;
  return parsed.searchParams.get("surface") === "extension";
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

chrome.runtime.onMessageExternal.addListener(
  (rawMsg, sender, sendResponse): boolean => {
    if (sender.origin !== ALLOWED_ORIGIN) return false;
    const msg = rawMsg as Partial<AuthRequest> | null;
    const type = msg?.type;
    if (typeof type !== "string" || !type.startsWith(TYPE_NAMESPACE))
      return false;
    if (!pathAllowedForType(type, sender.url)) return false;
    if (sender.tab?.id == null || sender.frameId == null) return false;

    void handle(type, sender).then(
      (resp) => sendResponse(resp),
      (err) =>
        sendResponse({
          error: { code: "auth/internal-error", message: String(err) },
        } satisfies AuthResponseFailure)
    );
    return true; // keep sendResponse alive across the await
  }
);

async function handle(
  type: string,
  _sender: chrome.runtime.MessageSender
): Promise<AuthResponse> {
  // Per-op handlers added in Tasks 6–10. Until then every type returns a
  // not-implemented error so an accidentally-routed request fails loudly.
  return {
    error: {
      code: "auth/not-implemented",
      message: `unimplemented op: ${type}`,
    },
  };
}

export {};
