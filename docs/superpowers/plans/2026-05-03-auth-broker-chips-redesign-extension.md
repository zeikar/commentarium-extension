# Auth Broker — CHIPS Redesign (Extension) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the extension repo onto the new CHIPS-backed auth contract: SW broker vends ID tokens only, the iframe writes the partitioned session cookie via `POST /api/login`, and the manifest drops every permission/host that existed only to support the old `chrome.cookies` path.

**Architecture:** The SW becomes a thin token vendor. `signIn.*` and `refreshSession` ops now return `{ ok: true, idToken }`; the iframe (1st-party `commentarium.app` context) handles `/api/login` itself and the browser writes `Set-Cookie: ...; Partitioned`. All `mintAndWriteCookie` / `chrome.cookies.*` / partition-registry plumbing is deleted, along with the dev-only manifest patches (`key`, `host_permissions: ["<all_urls>"]`, `cookies` permission). `minimum_chrome_version` drops from `"132"` to `"114"` (CHIPS floor).

**Tech Stack:** TypeScript 5.x, Vite 6, Vitest 4, jsdom, `firebase` (`firebase/auth/web-extension` entry), `@types/chrome`, MV3 service worker. Chrome ≥114.

**Spec:** `/Users/zeikar/Developer/Projects/commentarium/docs/superpowers/specs/2026-05-03-auth-broker-chips-redesign.md` — single source of truth covering both repos. Webapp side already merged on `origin/main` (commit `5aac46e`); this plan brings the extension repo onto the same wire contract.

**Coordination note (verbatim from spec):** "No backward compatibility layer. The extension has not been publicly shipped, so the old `chrome.cookies` broker contract is treated as pre-release only. Webapp ships first to expose the new CHIPS-backed `/api/login` contract; the extension's first Web Store publish targets only that contract."

**Resolved during review:** The committed dev `key` is removed (per the requesting-instruction `제거`), but to preserve unpacked-dev verifiability against the deployed webapp — which hardcodes the prod extension ID at `commentarium/src/app/_lib/surface.ts:5` (`PROD_EXTENSION_ID = "hogjejflnephnomijedgfocipidnkemf"`) — the manifest now sources `key` from a new optional `VITE_EXTENSION_KEY` env var, mirroring the existing `VITE_GOOGLE_OAUTH_CLIENT_ID` pattern.

To prevent the dev key from accidentally riding into a Web Store upload (Vite's `loadEnv` reads `.env.local` which is gitignored but lives on disk between builds), this plan also splits the build commands:

| Command | Purpose | `VITE_EXTENSION_KEY` source |
|---|---|---|
| `npm run dev` / `npm run build` | Daily local dev. Mirrors today. | `.env.local` (so unpacked builds get a stable prod-matching ID) |
| `npm run build:release` (new) | Release artifact for the Web Store. | **Forced empty** by `cross-env VITE_EXTENSION_KEY=` — shell env wins via a small vite.config.ts override that prefers `process.env.VITE_EXTENSION_KEY` when explicitly set. |

This satisfies spec coordination step #4 ("publish without `key`") cleanly: the dev never has to remember to scrub `.env.local` before packaging.

---

## File Structure

| File | Operation | Task |
|---|---|---|
| `manifest.ts` | modify — drop hardcoded `key` (drive from optional `VITE_EXTENSION_KEY`), drop `host_permissions`, drop `cookies` perm, `minimum_chrome_version: "132"` → `"114"` | Task 1 |
| `vite.config.ts` | modify — small override block so a shell-set `VITE_EXTENSION_KEY` (incl. empty) wins over `.env.local`, used by `build:release` | Task 1 |
| `package.json` | modify — add `build:release` script that scrubs `VITE_EXTENSION_KEY` via `cross-env` | Task 1 |
| `.env.example` | modify — document the new optional `VITE_EXTENSION_KEY` (public key only, not the private `.pem`) for unpacked-dev parity with the prod extension ID | Task 1 |
| `manifest.test.ts` (new) | create — pin manifest shape so dev patches can't silently slip back; cover both branches of the optional key | Task 1 |
| `src/pages/background/auth.ts` | modify — signIn ops return `{ ok: true, idToken }`; refresh too; signOut drops cookie/registry cleanup | Tasks 2–5 |
| `src/pages/background/auth.test.ts` | rewrite — replace cookie-mint / registry / fetch happy-path assertions with `{ ok, idToken }` assertions; keep `chrome.cookies.*).not.toHaveBeenCalled()` as regression guards | Tasks 2–5 |
| `src/pages/background/auth.ts` | modify — delete `mintAndWriteCookie`, `canonicalPartitionKey`, and `LOGIN_URL` / `COOKIE_URL` / `COOKIE_NAME` / `SURFACE_HEADER` constants | Task 6 |
| `test-utils/vitest.setup.ts` | modify — leave `chrome.cookies.*` mocks in place (regression guard for "SW must not call chrome.cookies"); add a one-line comment explaining why | Task 6 |
| `docs/superpowers/specs/2026-05-02-auth-broker-design.md` | modify — add a top-of-file `Status: Superseded` banner pointing to the new spec | Task 7 |
| `package.json` | modify — bump version `0.2.0` → `0.3.0` | Task 8 |

---

## Notes

**TDD style.** Tasks 2–5 each follow: change the existing test to the new shape (it then fails on current implementation) → minimal handler edit to make it green → commit. The `mintAndWriteCookie` function and other dead helpers stay live across Tasks 2–5 (callsites are removed one by one); they're only deleted in Task 6 once nothing references them.

**Test-isolation pattern (existing).** Each test mocks `firebase/auth/web-extension` via `vi.mock(...)` so the real Firebase SDK never loads under jsdom. Sender gates are validated by `dispatchExternalMessage(...)` from `test-utils/vitest.setup.ts`. Don't change this pattern.

**Defense against re-introducing fetch.** Tasks 2–5's tests stub `globalThis.fetch` to a `vi.fn()` that throws, then assert it was never called. If a future edit accidentally re-introduces a `fetch("/api/login", ...)` from the SW, the test fails loudly.

**`sender` parameter cleanup.** Individual op functions (`signInAnonymousOp`, `signInGoogleOp`, `refreshSessionOp`) currently take a `sender` argument they only need for `mintAndWriteCookie`'s tabId/frameId. After Task 6, drop the parameter from those op functions and from the `handle()` dispatcher. The listener-level sender gates (`origin`, `pathAllowedForType(...)`, tab/frameId presence) are unchanged — spec preserves them.

**Type cleanup.** The current `AuthResponse` union has a `{ ok: true }` arm and an `{ idToken: string }` arm. After this plan it should be:

```ts
type AuthResponse =
  | { ok: true }                                 // signOut
  | { ok: true; idToken: string }                // signIn.google, signIn.anonymous, refreshSession
  | { idToken: string }                          // getIdToken (handoff page)
  | { error: AuthError; signedOut?: boolean };
```

(`{ ok: true }` and `{ ok: true; idToken: string }` are structurally compatible — TS will not complain about the broader arm. The webapp validators distinguish with `isOk(v) && typeof v.idToken === "string"`.)

---

## Task 1: Manifest — drop dev patches, source `key` from env (with release scrub), lower Chrome floor, lock with a unit test

**Files:**
- Modify: [manifest.ts](../../../manifest.ts)
- Modify: [vite.config.ts](../../../vite.config.ts)
- Modify: [package.json](../../../package.json)
- Modify: [.env.example](../../../.env.example)
- Create: `manifest.test.ts` (repo root)

- [ ] **Step 1: Write the failing manifest test**

Create `manifest.test.ts` at the repo root:

```ts
import { describe, expect, it } from "vitest";
import { buildManifest } from "./manifest";

const baseEnv = {
  VITE_GOOGLE_OAUTH_CLIENT_ID: "test-client.apps.googleusercontent.com",
};

describe("buildManifest — CHIPS contract", () => {
  it("does NOT ship a hardcoded `key` field when VITE_EXTENSION_KEY is unset", () => {
    const m = buildManifest(baseEnv);
    expect((m as { key?: string }).key).toBeUndefined();
  });

  it("includes `key` from VITE_EXTENSION_KEY when the env var is set (unpacked-dev parity)", () => {
    const m = buildManifest({ ...baseEnv, VITE_EXTENSION_KEY: "DEV_KEY_VALUE" });
    expect((m as { key?: string }).key).toBe("DEV_KEY_VALUE");
  });

  it("does not include host_permissions", () => {
    const m = buildManifest(baseEnv);
    expect((m as { host_permissions?: unknown }).host_permissions).toBeUndefined();
  });

  it("does not include the `cookies` permission", () => {
    const m = buildManifest(baseEnv);
    expect(m.permissions).not.toContain("cookies");
  });

  it("permissions are exactly activeTab + identity + storage", () => {
    const m = buildManifest(baseEnv);
    expect(m.permissions?.sort()).toEqual(["activeTab", "identity", "storage"].sort());
  });

  it("minimum_chrome_version is 114 (CHIPS floor)", () => {
    const m = buildManifest(baseEnv);
    expect(m.minimum_chrome_version).toBe("114");
  });

  it("externally_connectable still pins to commentarium.app/*", () => {
    const m = buildManifest(baseEnv);
    expect(m.externally_connectable?.matches).toEqual(["https://commentarium.app/*"]);
  });
});
```

- [ ] **Step 2: Run the manifest test to verify the expected reds**

Run: `npx vitest run manifest.test.ts`
Expected: **6 FAIL, 1 PASS**. Specifically:
- FAIL: "does NOT ship a hardcoded `key` when VITE_EXTENSION_KEY is unset" — current `manifest.ts` always returns the leaked dev key regardless of env.
- FAIL: "includes `key` from VITE_EXTENSION_KEY when the env var is set" — current code never reads the env var; it always returns the hardcoded `MIIB...`, so the test sees `MIIB...` instead of `DEV_KEY_VALUE`.
- FAIL: "does not include host_permissions" — current ships `<all_urls>`.
- FAIL: "does not include the `cookies` permission" — current includes it.
- FAIL: "permissions are exactly activeTab + identity + storage" — current includes `cookies`.
- FAIL: "minimum_chrome_version is 114" — current is `"132"`.
- PASS: "externally_connectable still pins to commentarium.app/*" — already correct today.

- [ ] **Step 3: Edit `manifest.ts` — env-driven optional key + dropped dev patches**

Update the `ManifestEnv` type at the top of [manifest.ts](../../../manifest.ts):

```ts
export type ManifestEnv = {
  VITE_GOOGLE_OAUTH_CLIENT_ID?: string;
  /**
   * Optional: pin the unpacked-dev extension to a fixed ID by supplying the
   * extension's RSA public key (base64-encoded SubjectPublicKeyInfo). Used so
   * that local devs running an unpacked build can talk to the deployed
   * webapp, which hardcodes the prod extension ID. Production Web Store
   * publishes leave this unset — the Web Store assigns the ID.
   */
  VITE_EXTENSION_KEY?: string;
};
```

Then replace the body of `buildManifest` (the returned object literal at the bottom of the file) with:

```ts
  const manifest: chrome.runtime.ManifestV3 = {
    manifest_version: 3,
    name: packageJson.name,
    version: packageJson.version,
    description: packageJson.description,
    minimum_chrome_version: "114",
    background: {
      service_worker: "src/pages/background/index.js",
      type: "module",
    },
    action: {},
    permissions: ["activeTab", "identity", "storage"],
    externally_connectable: {
      matches: ["https://commentarium.app/*"],
    },
    oauth2: {
      client_id: env.VITE_GOOGLE_OAUTH_CLIENT_ID!,
      scopes: ["openid", "email", "profile"],
    },
    icons: {
      "32": "commentarium-logo-32.png",
      "48": "commentarium-logo-48.png",
      "128": "commentarium-logo-128.png",
    },
    content_scripts: [
      {
        matches: ["http://*/*", "https://*/*", "<all_urls>"],
        js: ["src/pages/content/index.js"],
        // KEY for cache invalidation
        css: ["assets/css/contentStyle<KEY>.chunk.css"],
      },
    ],
    web_accessible_resources: [
      {
        resources: [
          "assets/js/*.js",
          "assets/css/*.css",
          "commentarium-logo-128.png",
          "commentarium-logo-32.png",
        ],
        matches: ["*://*/*"],
      },
    ],
  };

  if (env.VITE_EXTENSION_KEY) {
    (manifest as chrome.runtime.ManifestV3 & { key: string }).key = env.VITE_EXTENSION_KEY;
  }

  return manifest;
```

The diff vs. today: remove the hardcoded `key: "MIIB..."` literal + `DO NOT COMMIT` comment; remove `host_permissions: ["<all_urls>"]` + comment; drop `"cookies"` from `permissions`; change `minimum_chrome_version: "132"` → `"114"`; add the env-driven optional key block at the bottom.

- [ ] **Step 4: Update `.env.example` (public key only — never paste a `.pem`)**

Append to [.env.example](../../../.env.example):

```
# OPTIONAL — only needed for unpacked local dev against the *deployed* webapp.
# The webapp's getExtensionId() defaults to the prod extension ID (see
# commentarium/src/app/_lib/surface.ts:5), so an unpacked build that wants to
# receive chrome.runtime.sendMessage from the deployed webapp needs the same ID,
# which means pinning the extension's public key here.
#
# THIS IS A PUBLIC KEY, not a private key. The manifest "key" field is the
# base64 encoding of the SubjectPublicKeyInfo (DER) for the extension's RSA
# keypair — derivable from the private .pem via:
#   openssl rsa -in <key>.pem -pubout -outform DER 2>/dev/null | openssl base64 -A
# but for THIS extension, the canonical value is whatever was previously
# committed at manifest.ts and now lives in the team's private build-config doc.
# DO NOT paste the contents of any .pem (private key) file here — that would
# be a credential leak, not a config value.
#
# Production Web Store publishes leave this UNSET (the Web Store assigns the
# ID). The new `npm run build:release` script enforces this regardless of
# what's in your .env.local.
VITE_EXTENSION_KEY=
```

- [ ] **Step 5: Add a shell-env override for `VITE_EXTENSION_KEY` in `vite.config.ts`**

In [vite.config.ts](../../../vite.config.ts), find the existing `loadEnv(...)` call and append this block immediately after it. Place it inside the `defineConfig(({ mode }) => { ... })` callback, after `const env = loadEnv(...)` and before `buildManifest(env)` is invoked:

```ts
    // Allow a shell-set VITE_EXTENSION_KEY (including an explicit empty
    // string from `cross-env VITE_EXTENSION_KEY=`) to win over .env.local.
    // Used by the `build:release` script to scrub the dev key ahead of a
    // Web Store upload, even when the dev's .env.local still has it set.
    if ("VITE_EXTENSION_KEY" in process.env) {
      env.VITE_EXTENSION_KEY = process.env.VITE_EXTENSION_KEY ?? "";
    }
```

This is the entire vite.config.ts change. The buildManifest call site is unchanged.

- [ ] **Step 6: Add the `build:release` script to `package.json`**

In [package.json](../../../package.json) `scripts`, add a new entry below the existing `"build"`:

```json
    "build:release": "tsc --noEmit && cross-env VITE_EXTENSION_KEY= vite build",
```

(`cross-env` is already a devDependency — used by the existing `build:watch` script.)

- [ ] **Step 7: Run the manifest test to verify it passes**

Run: `npx vitest run manifest.test.ts`
Expected: 7 PASS.

- [ ] **Step 8: Smoke-test both build flows**

```bash
# Daily-dev build — picks up VITE_EXTENSION_KEY from .env.local (if set)
npm run build
# Inspect dist/manifest.json: `key` MAY be present (depends on .env.local)
```

```bash
# Release build — scrubs the env var via cross-env regardless of .env.local
npm run build:release
# Inspect dist/manifest.json: `key` MUST be absent
```

In both cases: `permissions: ["activeTab", "identity", "storage"]`, `minimum_chrome_version: "114"`, no `host_permissions`.

- [ ] **Step 9: Commit**

```bash
git add manifest.ts manifest.test.ts vite.config.ts package.json .env.example
git commit -m "manifest: env-driven key + build:release scrub + drop cookies/host patches"
```

---

## Task 2: `signIn.anonymous` returns `{ ok: true, idToken }`

**Files:**
- Modify: [src/pages/background/auth.ts](../../../src/pages/background/auth.ts)
- Modify: [src/pages/background/auth.test.ts](../../../src/pages/background/auth.test.ts)

- [ ] **Step 1: Replace the existing `signIn.anonymous` test block with the new contract**

In [auth.test.ts](../../../src/pages/background/auth.test.ts), replace the entire `describe("signIn.anonymous", ...)` block (currently three tests asserting `chrome.cookies.set` + registry + `/api/login` fetch) with this single block:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/pages/background/auth.test.ts -t "signIn.anonymous"`
Expected: FAIL — current `signInAnonymousOp` returns `{ ok: true }` (no `idToken`) and calls `mintAndWriteCookie` (which fetches and calls `chrome.cookies.set`).

- [ ] **Step 3: Update the `AuthResponse` type in [auth.ts](../../../src/pages/background/auth.ts)**

Replace the type block at [auth.ts:16-20](../../../src/pages/background/auth.ts#L16-L20):

```ts
type AuthError = { code: string; message: string };
type AuthResponse =
  | { ok: true }
  | { ok: true; idToken: string }
  | { idToken: string }
  | { error: AuthError; signedOut?: boolean };
```

(Drop the now-redundant `AuthSuccessOk` / `AuthSuccessIdToken` / `AuthFailure` aliases. Inline the union — easier to read.)

Also update the listener's error path at [auth.ts:140](../../../src/pages/background/auth.ts#L140) — the `satisfies AuthFailure` annotation no longer compiles. Change:

```ts
sendResponse({ error: asAuthError(err) } satisfies AuthFailure),
```

to:

```ts
sendResponse({ error: asAuthError(err) }),
```

- [ ] **Step 4: Rewrite `signInAnonymousOp` to return idToken without minting a cookie**

Replace the `signInAnonymousOp` function at [auth.ts:172-191](../../../src/pages/background/auth.ts#L172-L191) with:

```ts
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
```

(`mintAndWriteCookie` call is gone. Sender parameter is gone — handler doesn't need it.)

Update the dispatcher at [auth.ts:152-153](../../../src/pages/background/auth.ts#L152-L153) so the call site no longer passes `sender`:

```ts
    case "commentarium.auth.signIn.anonymous":
      return signInAnonymousOp();
```

(Other dispatcher arms still pass sender — they'll be cleaned up in Tasks 3–5.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/pages/background/auth.test.ts -t "signIn.anonymous"`
Expected: 2 PASS.

- [ ] **Step 6: Commit**

```bash
git add src/pages/background/auth.ts src/pages/background/auth.test.ts
git commit -m "auth: signIn.anonymous returns { ok, idToken } (no cookie write)"
```

---

## Task 3: `signIn.google` returns `{ ok: true, idToken }`

**Files:**
- Modify: [src/pages/background/auth.ts](../../../src/pages/background/auth.ts)
- Modify: [src/pages/background/auth.test.ts](../../../src/pages/background/auth.test.ts)

- [ ] **Step 1: Replace the existing `signIn.google` test block**

In [auth.test.ts](../../../src/pages/background/auth.test.ts), replace the `describe("signIn.google", ...)` block with:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/pages/background/auth.test.ts -t "signIn.google"`
Expected: FAIL on the happy-path test — current `signInGoogleOp` returns `{ ok: true }` (no `idToken`) and calls `mintAndWriteCookie`.

- [ ] **Step 3: Rewrite `signInGoogleOp`**

Replace the `signInGoogleOp` function at [auth.ts:193-228](../../../src/pages/background/auth.ts#L193-L228) with:

```ts
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
```

Update the dispatcher arm at [auth.ts:154-155](../../../src/pages/background/auth.ts#L154-L155):

```ts
    case "commentarium.auth.signIn.google":
      return signInGoogleOp();
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/pages/background/auth.test.ts -t "signIn.google"`
Expected: 2 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pages/background/auth.ts src/pages/background/auth.test.ts
git commit -m "auth: signIn.google returns { ok, idToken } (no cookie write)"
```

---

## Task 4: `refreshSession` returns `{ ok: true, idToken }`

**Files:**
- Modify: [src/pages/background/auth.ts](../../../src/pages/background/auth.ts)
- Modify: [src/pages/background/auth.test.ts](../../../src/pages/background/auth.test.ts)

- [ ] **Step 1: Replace the existing `refreshSession` test block**

In [auth.test.ts](../../../src/pages/background/auth.test.ts), replace the `describe("refreshSession", ...)` block with:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/pages/background/auth.test.ts -t "refreshSession"`
Expected: FAIL on the happy-path test (current code returns `{ ok: true }` and writes a cookie).

- [ ] **Step 3: Rewrite `refreshSessionOp` (cleanup is best-effort, never blocks `signedOut: true`)**

Replace the `refreshSessionOp` function at [auth.ts:230-258](../../../src/pages/background/auth.ts#L230-L258) with:

```ts
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
```

Update the dispatcher arm at [auth.ts:156-157](../../../src/pages/background/auth.ts#L156-L157):

```ts
    case "commentarium.auth.refreshSession":
      return refreshSessionOp();
```

(`performSignOutCleanup` is still the chrome.cookies + registry version at this point. It still works against the existing mocks. Task 5 simplifies it; Task 6 deletes the helpers it relied on.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/pages/background/auth.test.ts -t "refreshSession"`
Expected: 4 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pages/background/auth.ts src/pages/background/auth.test.ts
git commit -m "auth: refreshSession returns { ok, idToken } (no cookie write)"
```

---

## Task 5: `signOut` drops cookie/registry cleanup

**Files:**
- Modify: [src/pages/background/auth.ts](../../../src/pages/background/auth.ts)
- Modify: [src/pages/background/auth.test.ts](../../../src/pages/background/auth.test.ts)

- [ ] **Step 1: Replace the existing `signOut` test block (with a seeded-registry red guard)**

In [auth.test.ts](../../../src/pages/background/auth.test.ts), replace the `describe("signOut", ...)` block with:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/pages/background/auth.test.ts -t "signOut"`
Expected: the "ignores any pre-existing partitionRegistry entries" test FAILS — current `performSignOutCleanup` walks the registry and calls `chrome.cookies.remove` twice. The other two tests may pass or fail (passes if the registry is empty); the seeded test is the load-bearing red.

- [ ] **Step 3: Rewrite `performSignOutCleanup` and `signOutOp`**

Replace the `performSignOutCleanup` function at [auth.ts:286-334](../../../src/pages/background/auth.ts#L286-L334) with:

```ts
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
```

Replace `signOutOp` at [auth.ts:260-267](../../../src/pages/background/auth.ts#L260-L267) with:

```ts
async function signOutOp(): Promise<AuthResponse> {
  try {
    await performSignOutCleanup();
    return { ok: true };
  } catch (err) {
    return { error: asAuthError(err) };
  }
}
```

(Functionally identical to before — `signOutOp` already wraps `performSignOutCleanup`. The cleanup itself is what shrank.)

- [ ] **Step 4: Run all tests to verify the signOut suite (and adjacent suites) still pass**

Run: `npx vitest run src/pages/background/auth.test.ts -t "signOut"`
Expected: 3 PASS.

Run: `npx vitest run src/pages/background/auth.test.ts -t "refreshSession"`
Expected: 4 PASS — Task 4's tests still green because `performSignOutCleanup` still does Firebase + identity cleanup, just no cookies/registry. The cleanup-throws-still-returns-signedOut test stays green because `performSignOutCleanupBestEffort` swallows the throws.

- [ ] **Step 5: Commit**

```bash
git add src/pages/background/auth.ts src/pages/background/auth.test.ts
git commit -m "auth: signOut drops cookie/partition-registry cleanup"
```

---

## Task 6: Delete dead code (mintAndWriteCookie, helpers, constants) + add note to test setup

**Files:**
- Modify: [src/pages/background/auth.ts](../../../src/pages/background/auth.ts)
- Modify: [test-utils/vitest.setup.ts](../../../test-utils/vitest.setup.ts)

After Tasks 2–5, these are unused in production code: `LOGIN_URL`, `COOKIE_URL`, `COOKIE_NAME`, `SURFACE_HEADER`, `canonicalPartitionKey`, `mintAndWriteCookie`, and the `sender` parameter on the `handle()` dispatcher (no op uses it any more).

**Why we keep `chrome.cookies.*` mocks** (revised after review): the mocks themselves stay in `test-utils/vitest.setup.ts` so the `expect(chrome.cookies.set).not.toHaveBeenCalled()` regression guards in Tasks 2–5 keep working — and so any future regression that re-introduces a `chrome.cookies.*` callsite fails loudly in tests instead of silently. We add a short comment so the next reader understands why mocks for an absent permission still exist.

- [ ] **Step 1: Delete dead constants and helpers from `auth.ts`**

Locate by name (line numbers will have drifted from earlier tasks; identifiers haven't):

- Constants `LOGIN_URL`, `COOKIE_URL`, `COOKIE_NAME`, `SURFACE_HEADER` at the top of the file — delete the four `const` lines.
- Function `canonicalPartitionKey(pk)` — delete the entire 7-line function.
- Function `mintAndWriteCookie({ idToken, sender })` — delete the entire 50-line `async function`.

- [ ] **Step 2: Drop the `sender` parameter from `handle()` and the listener call site**

The dispatcher signature is currently:

```ts
async function handle(
  type: string,
  sender: chrome.runtime.MessageSender,
): Promise<AuthResponse> {
```

Change to:

```ts
async function handle(type: string): Promise<AuthResponse> {
```

In the `chrome.runtime.onMessageExternal.addListener(...)` body, update the call site from `void handle(type, sender).then(...)` to:

```ts
    void handle(type).then(
```

The pre-handler sender gates (`origin`, `pathAllowedForType(type, sender.url)`, tab/frameId presence) stay. Spec is explicit: "Sender origin/url gates, authStateReady wait: unchanged."

- [ ] **Step 3: Add a regression-guard comment in `vitest.setup.ts`**

Above the `cookiesSet` definition in [test-utils/vitest.setup.ts](../../../test-utils/vitest.setup.ts) (around the existing `// chrome.cookies.* (new)` comment), replace the comment with:

```ts
// chrome.cookies.* — kept mocked even though the manifest no longer requests
// the `cookies` permission under the CHIPS contract. The mocks exist so
// auth.test.ts's `expect(chrome.cookies.set).not.toHaveBeenCalled()` regression
// guards have something to assert against; if a future change re-introduces a
// chrome.cookies.* callsite in auth.ts, those guards fail loudly. `set` resolves
// to a minimal Cookie-like object so any accidental call returns a plausible
// shape and the test that catches the call gets a useful diff.
```

Do not change any of the mock function definitions themselves.

- [ ] **Step 4: Run typecheck + full tests**

Run: `npm run build`
Expected: `tsc --noEmit` passes (no unused-symbol errors). `dist/` builds clean.

Run: `npx vitest run`
Expected: all auth tests + manifest test PASS. The `expect(chrome.cookies.*).not.toHaveBeenCalled()` guards from Tasks 2–5 are still in place and still green (because the rewritten ops don't call them).

- [ ] **Step 5: Commit**

```bash
git add src/pages/background/auth.ts test-utils/vitest.setup.ts
git commit -m "auth: delete mintAndWriteCookie + chrome.cookies dead code"
```

---

## Task 7: Mark the old extension-side spec superseded

**Files:**
- Modify: [docs/superpowers/specs/2026-05-02-auth-broker-design.md](../specs/2026-05-02-auth-broker-design.md)

The new master spec already declares supersession in its header. Add a forward marker to the old spec so a reader landing there isn't misled.

- [ ] **Step 1: Insert a Status banner at the top of the old spec**

At the very top of [docs/superpowers/specs/2026-05-02-auth-broker-design.md](../specs/2026-05-02-auth-broker-design.md), prepend:

```markdown
> **Status: Superseded.** This spec was superseded on 2026-05-03 by
> [auth-broker — CHIPS redesign](../../../../commentarium/docs/superpowers/specs/2026-05-03-auth-broker-chips-redesign.md)
> (single source of truth across the webapp + extension repos). The
> `chrome.cookies`-based broker design described here was never publicly
> shipped — Manual E2E surfaced a Chrome `host_permissions` constraint that
> the CHIPS redesign sidesteps by having the server write the partitioned
> cookie via `Set-Cookie: ...; Partitioned`.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-05-02-auth-broker-design.md
git commit -m "docs: mark 2026-05-02 auth-broker spec superseded by CHIPS redesign"
```

---

## Task 8: Bump version

**Files:**
- Modify: [package.json](../../../package.json)

Project convention (see commit `6996684`) is a dedicated `chore: bump extension version` commit. Pre-1.0, contract-breaking changes get a minor bump.

- [ ] **Step 1: Bump `version` in `package.json`**

In [package.json](../../../package.json), change:

```json
  "version": "0.2.0",
```

to:

```json
  "version": "0.3.0",
```

- [ ] **Step 2: Run a final smoke against the release build path**

Use `build:release` here (not `build`) so the smoke verifies the actual artifact that would ship. `npm run build` may legitimately include `key` from your `.env.local`; the release path must not.

Run: `npm run build:release && npx vitest run`
Expected: `dist/manifest.json` has `"version": "0.3.0"`, `"minimum_chrome_version": "114"`, `"permissions": ["activeTab", "identity", "storage"]`, **no `host_permissions`**, **no `key`** (regardless of what's in `.env.local`). All tests PASS.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: bump extension version to 0.3.0"
```

---

## Manual verification (post-merge, when paired with deployed webapp)

These are not plan tasks — they're the manual E2E steps from spec §Verification, scoped to what an extension developer can confirm locally after publishing. Run after the extension is loaded unpacked (with `VITE_EXTENSION_KEY` set in `.env.local` so the unpacked build's ID matches the deployed webapp's hardcoded prod ID at `commentarium/src/app/_lib/surface.ts:5`), or once installed from the Web Store, against deployed `commentarium.app`:

- **Manifest tightness (delta only).** Open `chrome://extensions`, expand the extension card. The permission list no longer carries the cookies-API warning that ships with the `"cookies"` permission, and `chrome://extensions` → Details → Site access shows the SW does not request access to any host (was `<all_urls>` for the cookies workaround). The broad "Read and change all your data on the websites you visit" warning **stays** — it is driven by `content_scripts.matches` (which still includes `<all_urls>` to mount the panel on every page), not by `host_permissions`. Eliminating that warning would require a different content-script injection strategy and is out of scope for this redesign.
- **3rd-party-cookie blocking ON.** Sign in on `example.com` via the side panel. DevTools → Application → Cookies → filter by `commentarium.app`. The `session` cookie has the **Partitioned** column checked, with partition key `https://example.com`.
- **Cross-partition cold start.** Open the panel on a fresh top-level (`developer.mozilla.org`). Bootstrap fires `refreshSession` → iframe POSTs `/api/login` → new partition gets its own `Set-Cookie: ...; Partitioned`. Comments render signed-in. **No** sign-in modal.
- **`/api/login` replay defense.** Capture a stale ID token (e.g. paused breakpoint after sign-in), then sign out (`/api/logout` revokes refresh tokens). Replay the captured ID token against `/api/login` with the surface header. Server response: 401. Without `verifyIdToken(_, true)` on the server, this would have minted a fresh cookie.
- **Settings handoff.** From the iframe user menu, click the Settings link → handoff page → `/api/auth/exchange` → `signInWithCustomToken` → `/settings`. The 1st-party tab is signed in.

If any of these fail, file a regression — do not modify the spec or plan to "match reality" without coordination across both repos.
