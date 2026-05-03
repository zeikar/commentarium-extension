import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchExternalMessage } from "../../../test-utils/vitest.setup";
import {
  GoogleAuthProvider,
  signInAnonymously,
  signInWithCredential,
  signOut,
} from "firebase/auth/web-extension";

vi.mock("./firebase", () => ({
  auth: {
    currentUser: null,
    authStateReady: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("firebase/auth/web-extension", () => ({
  signInAnonymously: vi.fn(),
  signInWithCredential: vi.fn(),
  signOut: vi.fn(),
  GoogleAuthProvider: { credential: vi.fn() },
}));

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  // Re-import auth.ts so its listener is freshly registered after the
  // setup file's beforeEach cleared `externalListeners`.
  await import("./auth");
});

describe("auth handler — sender gates", () => {
  it("drops messages from a non-commentarium origin", async () => {
    const result = await dispatchExternalMessage(
      { type: "commentarium.auth.signIn.anonymous" },
      { origin: "https://evil.example" }
    );
    expect(result).toBeUndefined();
  });

  it("drops messages without a `type` namespace", async () => {
    const result = await dispatchExternalMessage({ type: "foo" });
    expect(result).toBeUndefined();
  });

  it("drops getIdToken when sender.url path is not /auth/handoff", async () => {
    const result = await dispatchExternalMessage(
      { type: "commentarium.auth.getIdToken" },
      {
        url: "https://commentarium.app/comments?url=https%3A%2F%2Fexample.com%2F&surface=extension",
      }
    );
    expect(result).toBeUndefined();
  });

  it("drops signIn.* when sender.url path lacks surface=extension", async () => {
    const result = await dispatchExternalMessage(
      { type: "commentarium.auth.signIn.anonymous" },
      {
        url: "https://commentarium.app/comments?url=https%3A%2F%2Fexample.com%2F",
      }
    );
    expect(result).toBeUndefined();
  });

  it("drops signIn.* when sender.url path is /about", async () => {
    const result = await dispatchExternalMessage(
      { type: "commentarium.auth.signIn.anonymous" },
      {
        url: "https://commentarium.app/about?surface=extension",
      }
    );
    expect(result).toBeUndefined();
  });

  it("registers exactly one onMessageExternal listener", async () => {
    expect(chrome.runtime.onMessageExternal.addListener).toHaveBeenCalledTimes(
      1
    );
  });
});

const FIXTURE_PARTITION_KEY = {
  topLevelSite: "https://example.com",
  hasCrossSiteAncestor: true,
};

describe("signIn.anonymous", () => {
  it("signs in via Firebase and returns { ok: true, idToken } with no cookie/network side-effects", async () => {
    const firebase = await import("./firebase");
    const getIdToken = vi.fn().mockResolvedValue("anon-id-token");
    (firebase.auth as { currentUser: unknown }).currentUser = null;
    vi.mocked(signInAnonymously).mockImplementation(async () => {
      (firebase.auth as { currentUser: unknown }).currentUser = {
        uid: "anon-uid",
        getIdToken,
      };
      return { user: { uid: "anon-uid" } } as never;
    });

    // Defense: any accidental fetch from the SW must fail loudly. The CHIPS
    // contract has the iframe (not the SW) call /api/login.
    const fetchSpy = vi.fn(() => {
      throw new Error("SW must not call fetch under the CHIPS contract");
    });
    globalThis.fetch = fetchSpy as never;

    const result = await dispatchExternalMessage({
      type: "commentarium.auth.signIn.anonymous",
    });

    expect(result).toEqual({ ok: true, idToken: "anon-id-token" });
    expect(signInAnonymously).toHaveBeenCalledOnce();
    expect(getIdToken).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(chrome.cookies.set).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it("surfaces an error when Firebase signIn throws", async () => {
    vi.mocked(signInAnonymously).mockRejectedValueOnce({
      code: "auth/network-error",
      message: "transient",
    });

    const result = await dispatchExternalMessage({
      type: "commentarium.auth.signIn.anonymous",
    });

    expect(result).toMatchObject({
      error: expect.objectContaining({ code: "auth/network-error" }),
    });
  });
});

describe("signIn.google", () => {
  it("uses chrome.identity, signs in via Firebase credential, writes cookie", async () => {
    const firebase = await import("./firebase");
    const getIdToken = vi.fn().mockResolvedValue("google-id-token");
    (firebase.auth as { currentUser: unknown }).currentUser = null;

    vi.mocked(GoogleAuthProvider.credential).mockReturnValue({ providerId: "google.com" } as never);
    vi.mocked(signInWithCredential).mockImplementation(async () => {
      (firebase.auth as { currentUser: unknown }).currentUser = { uid: "google-uid", getIdToken };
      return { user: { uid: "google-uid" } } as never;
    });
    vi.mocked(chrome.identity.getAuthToken).mockResolvedValue({
      token: "google-access-token",
      grantedScopes: ["openid", "email", "profile"],
    } as never);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ session: "google-session", expiresAtSeconds: 1750000001 }),
    }) as never;

    const result = await dispatchExternalMessage({
      type: "commentarium.auth.signIn.google",
    });

    expect(result).toEqual({ ok: true });
    expect(chrome.identity.getAuthToken).toHaveBeenCalledWith({ interactive: true });
    // The handler extracts .token from the result object before building
    // the Google credential; signInWithCredential sees the access-token string.
    expect(GoogleAuthProvider.credential).toHaveBeenCalledWith(null, "google-access-token");
    expect(signInWithCredential).toHaveBeenCalledOnce();
    expect(chrome.cookies.set).toHaveBeenCalledOnce();
    expect(chrome.storage.local.set).toHaveBeenCalledOnce();
  });
});

describe("refreshSession", () => {
  it("happy path: forces ID token refresh, writes cookie, returns ok", async () => {
    const firebase = await import("./firebase");
    const getIdToken = vi.fn().mockResolvedValue("refreshed-id-token");
    (firebase.auth as { currentUser: unknown }).currentUser = { uid: "user-x", getIdToken };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ session: "refreshed-session", expiresAtSeconds: 1750000099 }),
    }) as never;

    const result = await dispatchExternalMessage({
      type: "commentarium.auth.refreshSession",
    });

    expect(result).toEqual({ ok: true });
    expect(getIdToken).toHaveBeenCalledWith(true); // force refresh
    expect(chrome.cookies.set).toHaveBeenCalledOnce();
    expect(chrome.storage.local.set).toHaveBeenCalledOnce();
  });

  it("user-gone: getIdToken(true) rejects → signOut + cookie cleanup + signedOut: true", async () => {
    const firebase = await import("./firebase");
    const getIdToken = vi
      .fn()
      .mockRejectedValue({ code: "auth/user-not-found", message: "user gone" });
    (firebase.auth as { currentUser: unknown }).currentUser = { uid: "user-x", getIdToken };

    // Pre-seed the registry so cleanup actually iterates entries
    await chrome.storage.local.set({
      "partitionRegistry:https://example.com|csa=1": {
        topLevelSite: "https://example.com",
        hasCrossSiteAncestor: true,
      },
    });
    vi.mocked(chrome.storage.local.set).mockClear();

    const result = await dispatchExternalMessage({
      type: "commentarium.auth.refreshSession",
    });

    expect(result).toMatchObject({
      error: expect.objectContaining({ code: expect.stringMatching(/^auth\//) }),
      signedOut: true,
    });
    expect(signOut).toHaveBeenCalledOnce();
    expect(chrome.cookies.remove).toHaveBeenCalledTimes(1);
    expect(chrome.identity.clearAllCachedAuthTokens).toHaveBeenCalledOnce();
    // Registry was cleared
    expect(chrome.storage.local.remove).toHaveBeenCalledOnce();
  });

  it("no current user: runs cleanup and returns signedOut: true", async () => {
    const firebase = await import("./firebase");
    (firebase.auth as { currentUser: unknown }).currentUser = null;

    // Pre-seed the registry to verify cleanup actually happens — registry +
    // partitioned cookies could persist from a prior session even when the
    // Firebase user is gone.
    await chrome.storage.local.set({
      "partitionRegistry:https://example.com|csa=1": {
        topLevelSite: "https://example.com",
        hasCrossSiteAncestor: true,
      },
    });
    vi.mocked(chrome.storage.local.set).mockClear();

    const result = await dispatchExternalMessage({
      type: "commentarium.auth.refreshSession",
    });

    expect(result).toMatchObject({
      error: expect.objectContaining({ code: "auth/no-current-user" }),
      signedOut: true,
    });
    expect(chrome.cookies.set).not.toHaveBeenCalled();
    // Cleanup: registry-driven cookie removal happened.
    expect(chrome.cookies.remove).toHaveBeenCalledTimes(1);
    expect(chrome.storage.local.remove).toHaveBeenCalledOnce();
    expect(chrome.identity.clearAllCachedAuthTokens).toHaveBeenCalledOnce();
  });
});

describe("signOut", () => {
  it("calls Firebase signOut, clears OAuth cache, removes every registered partition cookie", async () => {
    const firebase = await import("./firebase");
    (firebase.auth as { currentUser: unknown }).currentUser = { uid: "x" };

    await chrome.storage.local.set({
      "partitionRegistry:https://example.com|csa=1": {
        topLevelSite: "https://example.com",
        hasCrossSiteAncestor: true,
      },
      "partitionRegistry:https://other.example|csa=1": {
        topLevelSite: "https://other.example",
        hasCrossSiteAncestor: true,
      },
      "partitionRegistry:https://third.example|csa=0": {
        topLevelSite: "https://third.example",
        hasCrossSiteAncestor: false,
      },
      "unrelated:noise": "should-not-touch",
    });
    vi.mocked(chrome.storage.local.set).mockClear();

    const result = await dispatchExternalMessage({
      type: "commentarium.auth.signOut",
    });

    expect(result).toEqual({ ok: true });
    expect(signOut).toHaveBeenCalledOnce();
    expect(chrome.identity.clearAllCachedAuthTokens).toHaveBeenCalledOnce();

    expect(chrome.cookies.remove).toHaveBeenCalledTimes(3);
    const removedPartitions = vi
      .mocked(chrome.cookies.remove)
      .mock.calls.map(
        (c) =>
          (c[0] as { partitionKey: chrome.cookies.CookiePartitionKey })
            .partitionKey,
      );
    expect(removedPartitions).toContainEqual({
      topLevelSite: "https://example.com",
      hasCrossSiteAncestor: true,
    });
    expect(removedPartitions).toContainEqual({
      topLevelSite: "https://other.example",
      hasCrossSiteAncestor: true,
    });
    expect(removedPartitions).toContainEqual({
      topLevelSite: "https://third.example",
      hasCrossSiteAncestor: false,
    });

    // Only the registry keys were cleared; unrelated entries kept.
    expect(chrome.storage.local.remove).toHaveBeenCalledOnce();
    const removedKeys = vi.mocked(chrome.storage.local.remove).mock
      .calls[0][0] as string[];
    expect(removedKeys).toHaveLength(3);
    expect(removedKeys.every((k) => k.startsWith("partitionRegistry:"))).toBe(
      true,
    );
  });

  it("succeeds even when the registry is empty", async () => {
    const firebase = await import("./firebase");
    (firebase.auth as { currentUser: unknown }).currentUser = { uid: "x" };

    const result = await dispatchExternalMessage({
      type: "commentarium.auth.signOut",
    });

    expect(result).toEqual({ ok: true });
    expect(chrome.cookies.remove).not.toHaveBeenCalled();
    expect(chrome.storage.local.remove).not.toHaveBeenCalled();
  });

  it("clears partitioned cookies even when firebaseSignOut throws", async () => {
    const firebase = await import("./firebase");
    (firebase.auth as { currentUser: unknown }).currentUser = { uid: "x" };

    await chrome.storage.local.set({
      "partitionRegistry:https://example.com|csa=1": {
        topLevelSite: "https://example.com",
        hasCrossSiteAncestor: true,
      },
      "partitionRegistry:https://other.example|csa=1": {
        topLevelSite: "https://other.example",
        hasCrossSiteAncestor: true,
      },
    });
    vi.mocked(chrome.storage.local.set).mockClear();

    // Simulate Firebase signOut crashing — registry-driven cookie cleanup
    // is the security-critical step and MUST still run.
    vi.mocked(signOut).mockRejectedValueOnce(
      new Error("firebase signOut transient failure"),
    );

    const result = await dispatchExternalMessage({
      type: "commentarium.auth.signOut",
    });

    // Op response surfaces the error.
    expect(result).toMatchObject({
      error: expect.objectContaining({ code: expect.stringMatching(/^auth\//) }),
    });

    // But cookie cleanup STILL ran.
    expect(chrome.cookies.remove).toHaveBeenCalledTimes(2);
    expect(chrome.storage.local.remove).toHaveBeenCalledOnce();
  });
});

describe("getIdToken (handoff)", () => {
  const HANDOFF_SENDER = {
    url: "https://commentarium.app/auth/handoff?next=/settings",
    origin: "https://commentarium.app",
    tab: { id: 99 } as chrome.tabs.Tab,
    frameId: 0,
  };

  it("returns a fresh ID token for the current Firebase user", async () => {
    const firebase = await import("./firebase");
    const getIdToken = vi.fn().mockResolvedValue("handoff-id-token");
    (firebase.auth as { currentUser: unknown }).currentUser = {
      uid: "anon-uid",
      getIdToken,
    };

    const result = await dispatchExternalMessage(
      { type: "commentarium.auth.getIdToken" },
      HANDOFF_SENDER,
    );

    expect(result).toEqual({ idToken: "handoff-id-token" });
    expect(getIdToken).toHaveBeenCalledWith(true); // force refresh
  });

  it("returns an error when no user is signed in", async () => {
    const firebase = await import("./firebase");
    (firebase.auth as { currentUser: unknown }).currentUser = null;

    const result = await dispatchExternalMessage(
      { type: "commentarium.auth.getIdToken" },
      HANDOFF_SENDER,
    );

    expect(result).toMatchObject({
      error: expect.objectContaining({ code: "auth/no-current-user" }),
    });
  });
});
