import { vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";

// chrome.runtime.onMessage (existing — kept for the existing panel/app test)
type ChromeMessageListener = (msg: unknown, sender: unknown) => void;
const messageListeners: ChromeMessageListener[] = [];
const onMessageAddListener = vi.fn((cb: ChromeMessageListener) => {
  messageListeners.push(cb);
});
const onMessageRemoveListener = vi.fn((cb: ChromeMessageListener) => {
  const i = messageListeners.indexOf(cb);
  if (i !== -1) messageListeners.splice(i, 1);
});

// chrome.runtime.onMessageExternal (new)
type ChromeExternalListener = (
  msg: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
) => boolean | void;
const externalListeners: ChromeExternalListener[] = [];
const onMessageExternalAddListener = vi.fn((cb: ChromeExternalListener) => {
  externalListeners.push(cb);
});
const onMessageExternalRemoveListener = vi.fn((cb: ChromeExternalListener) => {
  const i = externalListeners.indexOf(cb);
  if (i !== -1) externalListeners.splice(i, 1);
});

// chrome.cookies.* — kept mocked even though the manifest no longer requests
// the `cookies` permission under the CHIPS contract. The mocks exist so
// auth.test.ts's `expect(chrome.cookies.set).not.toHaveBeenCalled()` regression
// guards have something to assert against; if a future change re-introduces a
// chrome.cookies.* callsite in auth.ts, those guards fail loudly. `set` resolves
// to a minimal Cookie-like object so any accidental call returns a plausible
// shape and the test that catches the call gets a useful diff.
const cookiesSet = vi.fn(async (details: chrome.cookies.SetDetails) => ({
  domain: "commentarium.app",
  name: details.name ?? "session",
  value: details.value ?? "",
  path: "/",
  secure: details.secure ?? true,
  httpOnly: details.httpOnly ?? true,
  sameSite: (details.sameSite ?? "no_restriction") as chrome.cookies.SameSiteStatus,
  storeId: "0",
  hostOnly: false,
  session: false,
  expirationDate: details.expirationDate,
  partitionKey: details.partitionKey,
}));
const cookiesRemove = vi.fn(async (_details: unknown) => undefined);
const cookiesGetAll = vi.fn(async (_details: unknown) => [] as unknown[]);
const cookiesGetPartitionKey = vi.fn(
  async (_details: { tabId: number; frameId: number }) => ({
    partitionKey: { topLevelSite: "https://example.com", hasCrossSiteAncestor: true },
  }),
);

// chrome.identity.* — launchWebAuthFlow drives the Google sign-in flow.
// The default mock echoes the inbound `state` query param into the
// redirect URL fragment so auth.ts's state check passes; tests override
// this for state-mismatch / oauth-error / cancel cases.
export const STUB_OAUTH = {
  redirectURI: "https://stub-extension-id.chromiumapp.org/",
  accessToken: "stub-google-access-token",
};
const identityLaunchWebAuthFlow = vi.fn(
  async (details: { url: string; interactive?: boolean }) => {
    const inboundState =
      new URL(details.url).searchParams.get("state") ?? "";
    return `${STUB_OAUTH.redirectURI}#access_token=${STUB_OAUTH.accessToken}&state=${inboundState}&token_type=Bearer&expires_in=3599`;
  },
);
const identityGetRedirectURL = vi.fn(
  (_path?: string) => STUB_OAUTH.redirectURI,
);
const identityClearAllCachedAuthTokens = vi.fn(async () => undefined);

// auth.ts reads VITE_GOOGLE_OAUTH_WEB_CLIENT_ID via import.meta.env at
// signInGoogleOp call time. Stub once for the whole test run.
vi.stubEnv(
  "VITE_GOOGLE_OAUTH_WEB_CLIENT_ID",
  "stub-web-client-id.apps.googleusercontent.com",
);

// chrome.storage.local (new) — backed by an in-memory map so per-key writes
// behave atomically per call (matching real chrome.storage.local semantics).
const storageMap = new Map<string, unknown>();
const storageLocalSet = vi.fn(async (items: Record<string, unknown>) => {
  for (const [k, v] of Object.entries(items)) storageMap.set(k, v);
});
const storageLocalGet = vi.fn(async (keys: string | string[] | null) => {
  if (keys === null) return Object.fromEntries(storageMap.entries());
  const arr = Array.isArray(keys) ? keys : [keys];
  return Object.fromEntries(arr.filter((k) => storageMap.has(k)).map((k) => [k, storageMap.get(k)]));
});
const storageLocalRemove = vi.fn(async (keys: string | string[]) => {
  const arr = Array.isArray(keys) ? keys : [keys];
  for (const k of arr) storageMap.delete(k);
});

(globalThis as unknown as { chrome: unknown }).chrome = {
  runtime: {
    onMessage: { addListener: onMessageAddListener, removeListener: onMessageRemoveListener },
    onMessageExternal: { addListener: onMessageExternalAddListener, removeListener: onMessageExternalRemoveListener },
  },
  cookies: {
    set: cookiesSet,
    remove: cookiesRemove,
    getAll: cookiesGetAll,
    getPartitionKey: cookiesGetPartitionKey,
  },
  identity: {
    launchWebAuthFlow: identityLaunchWebAuthFlow,
    getRedirectURL: identityGetRedirectURL,
    clearAllCachedAuthTokens: identityClearAllCachedAuthTokens,
  },
  storage: {
    local: { set: storageLocalSet, get: storageLocalGet, remove: storageLocalRemove },
  },
};

beforeEach(() => {
  onMessageAddListener.mockClear();
  onMessageRemoveListener.mockClear();
  messageListeners.length = 0;

  onMessageExternalAddListener.mockClear();
  onMessageExternalRemoveListener.mockClear();
  externalListeners.length = 0;

  cookiesSet.mockClear();
  cookiesRemove.mockClear();
  cookiesGetAll.mockClear();
  cookiesGetPartitionKey.mockClear();
  cookiesGetPartitionKey.mockResolvedValue({
    partitionKey: { topLevelSite: "https://example.com", hasCrossSiteAncestor: true },
  });

  identityLaunchWebAuthFlow.mockClear();
  identityLaunchWebAuthFlow.mockImplementation(async (details) => {
    const inboundState =
      new URL(details.url).searchParams.get("state") ?? "";
    return `${STUB_OAUTH.redirectURI}#access_token=${STUB_OAUTH.accessToken}&state=${inboundState}&token_type=Bearer&expires_in=3599`;
  });
  identityGetRedirectURL.mockClear();
  identityGetRedirectURL.mockReturnValue(STUB_OAUTH.redirectURI);
  identityClearAllCachedAuthTokens.mockClear();

  storageLocalSet.mockClear();
  storageLocalGet.mockClear();
  storageLocalRemove.mockClear();
  storageMap.clear();
});

// --- helpers exported for test use --------------------------------

export function dispatchChromeMessage(
  msg: unknown,
  sender: unknown = {},
): void {
  for (const l of [...messageListeners]) {
    l(msg, sender);
  }
}

/**
 * Dispatch a synthetic onMessageExternal event. Returns the value the handler
 * gave to sendResponse (or undefined if the handler dropped silently / never
 * called sendResponse).
 */
export function dispatchExternalMessage(
  msg: unknown,
  sender: Partial<chrome.runtime.MessageSender> = {},
): Promise<unknown> {
  return new Promise((resolve) => {
    const fullSender: chrome.runtime.MessageSender = {
      origin: "https://commentarium.app",
      url: "https://commentarium.app/comments?url=https%3A%2F%2Fexample.com%2F&surface=extension",
      tab: { id: 42 } as chrome.tabs.Tab,
      frameId: 0,
      ...sender,
    };
    let called = false;
    const sendResponse = (response?: unknown) => {
      called = true;
      resolve(response);
    };
    let kept = false;
    for (const l of [...externalListeners]) {
      const ret = l(msg, fullSender, sendResponse);
      if (ret === true) kept = true;
    }
    if (!kept && !called) {
      // Handler did not return true and did not call sendResponse synchronously.
      // Treat as a silent drop.
      setTimeout(() => resolve(undefined), 0);
    }
  });
}
