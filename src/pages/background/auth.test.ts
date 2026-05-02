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
  it("signs in, mints a partitioned cookie, and registers the partition", async () => {
    // Arrange — the firebase mock currentUser is set up after signIn.
    const getIdToken = vi.fn().mockResolvedValue("fixture-id-token");
    const firebase = await import("./firebase");
    (firebase.auth as { currentUser: unknown }).currentUser = null;
    vi.mocked(signInAnonymously).mockImplementation(async () => {
      (firebase.auth as { currentUser: unknown }).currentUser = {
        uid: "anon-uid",
        getIdToken,
      };
      return { user: { uid: "anon-uid" } } as never;
    });

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ session: "fixture-session-cookie", expiresAtSeconds: 1750000000 }),
    });
    globalThis.fetch = fetchSpy as never;

    // Act
    const result = await dispatchExternalMessage({
      type: "commentarium.auth.signIn.anonymous",
    });

    // Assert
    expect(result).toEqual({ ok: true });

    expect(signInAnonymously).toHaveBeenCalledOnce();
    expect(getIdToken).toHaveBeenCalledOnce();

    // /api/login was called with Bearer + surface header
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [calledUrl, calledInit] = fetchSpy.mock.calls[0];
    expect(calledUrl).toBe("https://commentarium.app/api/login");
    const headers = (calledInit as { headers: Record<string, string> }).headers;
    expect(headers["Authorization"]).toBe("Bearer fixture-id-token");
    expect(headers["X-Commentarium-Surface"]).toBe("extension");

    // Cookie was set with the resolved partition key + expiresAtSeconds verbatim
    expect(chrome.cookies.set).toHaveBeenCalledOnce();
    const cookieArgs = vi.mocked(chrome.cookies.set).mock.calls[0][0];
    expect(cookieArgs).toMatchObject({
      url: "https://commentarium.app/",
      name: "session",
      value: "fixture-session-cookie",
      expirationDate: 1750000000,
      secure: true,
      httpOnly: true,
      sameSite: "no_restriction",
      partitionKey: FIXTURE_PARTITION_KEY,
    });

    // Registry entry written under partitionRegistry:<canonical>
    expect(chrome.storage.local.set).toHaveBeenCalledOnce();
    const setArg = vi.mocked(chrome.storage.local.set).mock.calls[0][0] as Record<string, unknown>;
    const keys = Object.keys(setArg);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^partitionRegistry:/);
    expect(setArg[keys[0]]).toEqual(FIXTURE_PARTITION_KEY);
  });

  it("surfaces an error when /api/login fails", async () => {
    const firebase = await import("./firebase");
    const getIdToken = vi.fn().mockResolvedValue("fixture-id-token");
    (firebase.auth as { currentUser: unknown }).currentUser = null;
    vi.mocked(signInAnonymously).mockImplementation(async () => {
      (firebase.auth as { currentUser: unknown }).currentUser = { uid: "anon", getIdToken };
      return { user: { uid: "anon" } } as never;
    });
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) as never;

    const result = await dispatchExternalMessage({
      type: "commentarium.auth.signIn.anonymous",
    });

    expect(result).toMatchObject({
      error: expect.objectContaining({ code: expect.stringMatching(/^auth\//) }),
    });
    expect(chrome.cookies.set).not.toHaveBeenCalled();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it("surfaces auth/cookie-write-failed when chrome.cookies.set returns null", async () => {
    const firebase = await import("./firebase");
    const getIdToken = vi.fn().mockResolvedValue("fixture-id-token");
    (firebase.auth as { currentUser: unknown }).currentUser = null;
    vi.mocked(signInAnonymously).mockImplementation(async () => {
      (firebase.auth as { currentUser: unknown }).currentUser = { uid: "anon", getIdToken };
      return { user: { uid: "anon" } } as never;
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ session: "x", expiresAtSeconds: 1750000000 }),
    }) as never;
    // chrome.cookies.set resolves to null (Chrome's documented failure shape:
    // no exception, just no Cookie returned).
    vi.mocked(chrome.cookies.set).mockResolvedValueOnce(null as never);

    const result = await dispatchExternalMessage({
      type: "commentarium.auth.signIn.anonymous",
    });

    expect(result).toMatchObject({
      error: expect.objectContaining({ code: "auth/cookie-write-failed" }),
    });
    // Registry MUST NOT be written when the cookie itself wasn't persisted —
    // a phantom registry entry would mislead sign-out cleanup.
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });
});
