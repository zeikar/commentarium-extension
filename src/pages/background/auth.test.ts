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
  it("uses chrome.identity, signs in via Firebase credential, returns { ok, idToken } with no cookie/network side-effects", async () => {
    const firebase = await import("./firebase");
    const getIdToken = vi.fn().mockResolvedValue("google-id-token");
    (firebase.auth as { currentUser: unknown }).currentUser = null;

    vi.mocked(GoogleAuthProvider.credential).mockReturnValue({
      providerId: "google.com",
    } as never);
    vi.mocked(signInWithCredential).mockImplementation(async () => {
      (firebase.auth as { currentUser: unknown }).currentUser = {
        uid: "google-uid",
        getIdToken,
      };
      return { user: { uid: "google-uid" } } as never;
    });
    vi.mocked(chrome.identity.getAuthToken).mockResolvedValue({
      token: "google-access-token",
      grantedScopes: ["openid", "email", "profile"],
    } as never);

    const fetchSpy = vi.fn(() => {
      throw new Error("SW must not call fetch under the CHIPS contract");
    });
    globalThis.fetch = fetchSpy as never;

    const result = await dispatchExternalMessage({
      type: "commentarium.auth.signIn.google",
    });

    expect(result).toEqual({ ok: true, idToken: "google-id-token" });
    expect(chrome.identity.getAuthToken).toHaveBeenCalledWith({
      interactive: true,
    });
    expect(GoogleAuthProvider.credential).toHaveBeenCalledWith(
      null,
      "google-access-token",
    );
    expect(signInWithCredential).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(chrome.cookies.set).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it("surfaces identity/no-token when chrome.identity.getAuthToken returns no token", async () => {
    vi.mocked(chrome.identity.getAuthToken).mockResolvedValue({
      token: undefined,
      grantedScopes: [],
    } as never);

    const result = await dispatchExternalMessage({
      type: "commentarium.auth.signIn.google",
    });

    expect(result).toMatchObject({
      error: expect.objectContaining({ code: "identity/no-token" }),
    });
    expect(signInWithCredential).not.toHaveBeenCalled();
  });
});

describe("refreshSession", () => {
  it("happy path: forces ID token refresh and returns { ok, idToken }", async () => {
    const firebase = await import("./firebase");
    const getIdToken = vi.fn().mockResolvedValue("refreshed-id-token");
    (firebase.auth as { currentUser: unknown }).currentUser = {
      uid: "user-x",
      getIdToken,
    };

    const fetchSpy = vi.fn(() => {
      throw new Error("SW must not call fetch under the CHIPS contract");
    });
    globalThis.fetch = fetchSpy as never;

    const result = await dispatchExternalMessage({
      type: "commentarium.auth.refreshSession",
    });

    expect(result).toEqual({ ok: true, idToken: "refreshed-id-token" });
    expect(getIdToken).toHaveBeenCalledWith(true); // force refresh
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(chrome.cookies.set).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it("user-gone: getIdToken(true) rejects → firebaseSignOut + signedOut: true", async () => {
    const firebase = await import("./firebase");
    const getIdToken = vi
      .fn()
      .mockRejectedValue({ code: "auth/user-not-found", message: "user gone" });
    (firebase.auth as { currentUser: unknown }).currentUser = {
      uid: "user-x",
      getIdToken,
    };

    const result = await dispatchExternalMessage({
      type: "commentarium.auth.refreshSession",
    });

    expect(result).toMatchObject({
      error: expect.objectContaining({ code: expect.stringMatching(/^auth\//) }),
      signedOut: true,
    });
    expect(signOut).toHaveBeenCalledOnce();
    expect(chrome.identity.clearAllCachedAuthTokens).toHaveBeenCalledOnce();
    expect(chrome.cookies.remove).not.toHaveBeenCalled();
    expect(chrome.cookies.set).not.toHaveBeenCalled();
  });

  it("no current user: runs Firebase + identity cleanup and returns signedOut: true", async () => {
    const firebase = await import("./firebase");
    (firebase.auth as { currentUser: unknown }).currentUser = null;

    const result = await dispatchExternalMessage({
      type: "commentarium.auth.refreshSession",
    });

    expect(result).toMatchObject({
      error: expect.objectContaining({ code: "auth/no-current-user" }),
      signedOut: true,
    });
    expect(chrome.cookies.remove).not.toHaveBeenCalled();
    expect(chrome.identity.clearAllCachedAuthTokens).toHaveBeenCalledOnce();
  });

  it("still returns signedOut: true even when cleanup throws (best-effort)", async () => {
    // Why this matters: webapp pivots UI to signed-out only when it sees
    // signedOut: true. If a transient cleanup throw (e.g. clearAllCachedAuthTokens
    // rejecting on a flaky chrome.identity call) escapes the op, the listener's
    // error path returns plain { error } without signedOut, and the iframe
    // stays "signed-in" client-side until the next 401. Cleanup must not gate
    // the signed-out signal.
    const firebase = await import("./firebase");
    const getIdToken = vi
      .fn()
      .mockRejectedValue({ code: "auth/user-not-found", message: "user gone" });
    (firebase.auth as { currentUser: unknown }).currentUser = {
      uid: "user-x",
      getIdToken,
    };
    vi.mocked(signOut).mockRejectedValueOnce(new Error("transient firebase failure"));
    vi.mocked(chrome.identity.clearAllCachedAuthTokens).mockRejectedValueOnce(
      new Error("transient identity failure"),
    );

    const result = await dispatchExternalMessage({
      type: "commentarium.auth.refreshSession",
    });

    expect(result).toMatchObject({
      // The originating error is preserved — not the cleanup error.
      error: expect.objectContaining({ code: "auth/user-not-found" }),
      signedOut: true,
    });
  });
});

describe("signOut", () => {
  it("calls Firebase signOut and clears chrome.identity OAuth cache", async () => {
    const firebase = await import("./firebase");
    (firebase.auth as { currentUser: unknown }).currentUser = { uid: "x" };

    const result = await dispatchExternalMessage({
      type: "commentarium.auth.signOut",
    });

    expect(result).toEqual({ ok: true });
    expect(signOut).toHaveBeenCalledOnce();
    expect(chrome.identity.clearAllCachedAuthTokens).toHaveBeenCalledOnce();
    expect(chrome.cookies.remove).not.toHaveBeenCalled();
    expect(chrome.storage.local.remove).not.toHaveBeenCalled();
  });

  it("ignores any pre-existing partitionRegistry entries (cookie path is gone)", async () => {
    const firebase = await import("./firebase");
    (firebase.auth as { currentUser: unknown }).currentUser = { uid: "x" };

    // Pre-seed the registry to verify the new signOut implementation does NOT
    // walk it. Under the CHIPS contract, partition cookies are owned by the
    // server (via /api/logout) — the SW must not touch them. This is the
    // load-bearing red test for Task 5: today's code walks the registry and
    // calls chrome.cookies.remove; the new code must not.
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

    const result = await dispatchExternalMessage({
      type: "commentarium.auth.signOut",
    });

    expect(result).toEqual({ ok: true });
    expect(chrome.cookies.remove).not.toHaveBeenCalled();
    expect(chrome.storage.local.remove).not.toHaveBeenCalled();
  });

  it("still clears the chrome.identity OAuth cache when firebaseSignOut throws", async () => {
    const firebase = await import("./firebase");
    (firebase.auth as { currentUser: unknown }).currentUser = { uid: "x" };

    vi.mocked(signOut).mockRejectedValueOnce(
      new Error("firebase signOut transient failure"),
    );

    const result = await dispatchExternalMessage({
      type: "commentarium.auth.signOut",
    });

    expect(result).toMatchObject({
      error: expect.objectContaining({ code: expect.stringMatching(/^auth\//) }),
    });
    // chrome.identity cleanup still ran — important so a retried signIn.google
    // shows the chooser instead of being held hostage by stale OAuth tokens.
    expect(chrome.identity.clearAllCachedAuthTokens).toHaveBeenCalledOnce();
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
