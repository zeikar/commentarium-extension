import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  STUB_OAUTH,
  dispatchExternalMessage,
} from "../../../test-utils/vitest.setup";
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
  // Helper: build a redirect URL that echoes the inbound `state` so the
  // state check passes before exercising the field under test.
  function echoStateRedirect(
    fragmentExtras: Record<string, string>,
  ): (details: { url: string }) => Promise<string> {
    return async (details) => {
      const inboundState =
        new URL(details.url).searchParams.get("state") ?? "";
      const fragment = new URLSearchParams({
        ...fragmentExtras,
        state: inboundState,
      });
      return `${STUB_OAUTH.redirectURI}#${fragment}`;
    };
  }

  it("happy path: drives launchWebAuthFlow, signs in via Firebase credential, returns { ok, idToken } with no cookie/network side-effects", async () => {
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

    const fetchSpy = vi.fn(() => {
      throw new Error("SW must not call fetch under the CHIPS contract");
    });
    globalThis.fetch = fetchSpy as never;

    const result = await dispatchExternalMessage({
      type: "commentarium.auth.signIn.google",
    });

    expect(result).toEqual({ ok: true, idToken: "google-id-token" });
    expect(chrome.identity.launchWebAuthFlow).toHaveBeenCalledWith(
      expect.objectContaining({ interactive: true }),
    );
    // Inspect the URL passed to launchWebAuthFlow: must carry the OAuth
    // params we depend on (response_type=token keeps the access-token
    // path; prompt=select_account is what now drives the chooser).
    const launchArgs = vi.mocked(chrome.identity.launchWebAuthFlow).mock
      .calls[0][0] as { url: string };
    const launchUrl = new URL(launchArgs.url);
    expect(launchUrl.searchParams.get("response_type")).toBe("token");
    expect(launchUrl.searchParams.get("prompt")).toBe("select_account");
    expect(launchUrl.searchParams.get("scope")).toBe("openid email profile");
    expect(launchUrl.searchParams.get("redirect_uri")).toBe(
      STUB_OAUTH.redirectURI,
    );
    expect(launchUrl.searchParams.get("state")).toBeTruthy();

    expect(GoogleAuthProvider.credential).toHaveBeenCalledWith(
      null,
      STUB_OAUTH.accessToken,
    );
    expect(signInWithCredential).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(chrome.cookies.set).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it("maps launchWebAuthFlow rejection (window closed) to auth/popup-closed-by-user", async () => {
    vi.mocked(chrome.identity.launchWebAuthFlow).mockRejectedValueOnce(
      new Error("The user did not approve access."),
    );

    const result = await dispatchExternalMessage({
      type: "commentarium.auth.signIn.google",
    });

    expect(result).toMatchObject({
      error: expect.objectContaining({ code: "auth/popup-closed-by-user" }),
    });
    expect(signInWithCredential).not.toHaveBeenCalled();
  });

  it("maps fragment error=access_denied to auth/popup-closed-by-user", async () => {
    vi.mocked(chrome.identity.launchWebAuthFlow).mockImplementationOnce(
      echoStateRedirect({ error: "access_denied" }),
    );

    const result = await dispatchExternalMessage({
      type: "commentarium.auth.signIn.google",
    });

    expect(result).toMatchObject({
      error: expect.objectContaining({ code: "auth/popup-closed-by-user" }),
    });
    expect(signInWithCredential).not.toHaveBeenCalled();
  });

  it("maps fragment error=invalid_request to identity/oauth-error", async () => {
    vi.mocked(chrome.identity.launchWebAuthFlow).mockImplementationOnce(
      echoStateRedirect({
        error: "invalid_request",
        error_description: "bad request",
      }),
    );

    const result = await dispatchExternalMessage({
      type: "commentarium.auth.signIn.google",
    });

    expect(result).toMatchObject({
      error: expect.objectContaining({ code: "identity/oauth-error" }),
    });
    expect(signInWithCredential).not.toHaveBeenCalled();
  });

  it("returns identity/state-mismatch when the redirect echoes a different state (CSRF guard)", async () => {
    // Use a fixed state value that the SW's crypto.randomUUID() will not
    // collide with. signInWithCredential must not run.
    vi.mocked(chrome.identity.launchWebAuthFlow).mockResolvedValueOnce(
      `${STUB_OAUTH.redirectURI}#access_token=any&state=00000000-0000-4000-8000-000000000000` as never,
    );

    const result = await dispatchExternalMessage({
      type: "commentarium.auth.signIn.google",
    });

    expect(result).toMatchObject({
      error: expect.objectContaining({ code: "identity/state-mismatch" }),
    });
    expect(signInWithCredential).not.toHaveBeenCalled();
  });

  it("returns identity/no-access-token when the fragment is missing access_token", async () => {
    vi.mocked(chrome.identity.launchWebAuthFlow).mockImplementationOnce(
      echoStateRedirect({}),
    );

    const result = await dispatchExternalMessage({
      type: "commentarium.auth.signIn.google",
    });

    expect(result).toMatchObject({
      error: expect.objectContaining({ code: "identity/no-access-token" }),
    });
    expect(signInWithCredential).not.toHaveBeenCalled();
  });

  it("returns identity/invalid-redirect-url when the redirect URL cannot be parsed", async () => {
    // "http://[::1" is an unmistakably invalid URL the WHATWG URL
    // constructor rejects (unterminated IPv6 host).
    vi.mocked(chrome.identity.launchWebAuthFlow).mockResolvedValueOnce(
      "http://[::1" as never,
    );

    const result = await dispatchExternalMessage({
      type: "commentarium.auth.signIn.google",
    });

    expect(result).toMatchObject({
      error: expect.objectContaining({
        code: "identity/invalid-redirect-url",
      }),
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
