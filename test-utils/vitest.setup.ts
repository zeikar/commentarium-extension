import { vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";

// chrome.runtime.onMessage (existing — kept for the existing Demo/app test)
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

// chrome.identity.* (new) — Promise overload returns GetAuthTokenResult,
// not a bare string. The string is the (legacy) callback-API form.
const identityGetAuthToken = vi.fn(async (_details: unknown) => ({
  token: "stub-google-access-token",
  grantedScopes: ["openid", "email", "profile"],
}));
const identityClearAllCachedAuthTokens = vi.fn(async () => undefined);

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

// chrome.runtime.getPlatformInfo (used by signInGoogleOp's keepalive ping
// to extend the SW idle timer while interactive OAuth is in flight).
const runtimeGetPlatformInfo = vi.fn(async () => ({
  os: "mac" as chrome.runtime.PlatformOs,
  arch: "x86-64" as chrome.runtime.PlatformArch,
  nacl_arch: "x86-64" as chrome.runtime.PlatformNaclArch,
}));

(globalThis as unknown as { chrome: unknown }).chrome = {
  runtime: {
    onMessage: { addListener: onMessageAddListener, removeListener: onMessageRemoveListener },
    onMessageExternal: { addListener: onMessageExternalAddListener, removeListener: onMessageExternalRemoveListener },
    getPlatformInfo: runtimeGetPlatformInfo,
  },
  cookies: {
    set: cookiesSet,
    remove: cookiesRemove,
    getAll: cookiesGetAll,
    getPartitionKey: cookiesGetPartitionKey,
  },
  identity: {
    getAuthToken: identityGetAuthToken,
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

  identityGetAuthToken.mockClear();
  identityGetAuthToken.mockResolvedValue({
    token: "stub-google-access-token",
    grantedScopes: ["openid", "email", "profile"],
  });
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
