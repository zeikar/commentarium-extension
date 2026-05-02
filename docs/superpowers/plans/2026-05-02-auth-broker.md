# Auth Broker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the extension-side cycle ③ auth broker — service-worker Firebase Auth + chrome.identity + chrome.cookies partitioned writes — so that the iframed webapp can sign in / refresh / sign out via `chrome.runtime.sendMessage` from `https://commentarium.app/*`, and the handoff page can fetch a fresh ID token for 1st-party Firebase Auth bootstrap.

**Architecture:** All auth work lives in the SW (`src/pages/background/auth.ts`). The webapp talks directly to the SW via `chrome.runtime.sendMessage(EXT_ID, …)` gated by `externally_connectable.matches`; no content-script relay. Partition keys come from `chrome.cookies.getPartitionKey({ tabId, frameId })` per request. A registry of written partitions lives in `chrome.storage.local` (one key per partition) so sign-out can clean up cookies the API does not enumerate by default. The iframe URL gains `&surface=extension`. Webapp-side changes (handoff page, `/api/auth/exchange`, `X-Commentarium-Surface` header on all `/api/*`) are out of scope for this plan — they live in the private webapp repo.

**Tech Stack:** TypeScript 5.x, Vite 6, Vitest 4, jsdom, `firebase` (`firebase/auth/web-extension` entry), `@types/chrome ^0.1.40` plus a small ambient augmentation (`src/chrome-cookies-partition.d.ts`) for partitioned-cookie types not yet shipped on DefinitelyTyped (`partitionKey` field on `Cookie`/`SetDetails`/`Details`/`GetAllDetails`, `CookiePartitionKey` interface, `getPartitionKey()` function), Node 22, Chrome ≥132 (manifest `minimum_chrome_version`), MV3 service worker.

**Spec:** [docs/superpowers/specs/2026-05-02-auth-broker-design.md](../specs/2026-05-02-auth-broker-design.md)

---

## File Structure

| File | Operation | Task |
|---|---|---|
| `package.json` | modify (add `firebase` dep) | Task 1 |
| `package-lock.json` | regenerated | Task 1 |
| `.env.example` | create | Task 1 |
| `.env.local` | create locally (gitignored) | Task 1 |
| `src/chrome-cookies-partition.d.ts` | create — ambient augmentation for partitioned-cookie types | Task 1 |
| `manifest.ts` | rewrite as `buildManifest(env)` function + new fields | Task 2 |
| `vite.config.ts` | wrap export in `defineConfig(({ mode }) => …)`, call `loadEnv`, pass to manifest plugin | Task 2 |
| `src/vite-env.d.ts` | create — `ImportMetaEnv` / `ImportMeta` typings (script-context ambient file) | Task 2 |
| `src/pages/background/firebase.ts` | create | Task 3 |
| `test-utils/vitest.setup.ts` | extend chrome mocks (cookies / identity / storage / onMessageExternal) | Task 4 |
| `src/pages/background/auth.ts` | create — handler skeleton + sender gates | Task 5 |
| `src/pages/background/auth.test.ts` | create + grow with each handler | Tasks 5–10 |
| `src/pages/background/auth.ts` | grow — `signIn.anonymous` body | Task 6 |
| `src/pages/background/auth.ts` | grow — `signIn.google` body | Task 7 |
| `src/pages/background/auth.ts` | grow — `refreshSession` body | Task 8 |
| `src/pages/background/auth.ts` | grow — `signOut` body | Task 9 |
| `src/pages/background/auth.ts` | grow — `getIdToken` body | Task 10 |
| `src/pages/background/index.ts` | modify — import `./auth` so the listener registers | Task 5 |
| `src/pages/content/components/iframe/index.tsx` | modify — append `&surface=extension` | Task 11 |
| `src/pages/content/components/iframe/index.test.tsx` | create | Task 11 |

---

## Note on TDD

Each handler task follows the loop: **failing test → minimal implementation → green → commit**. Tasks 5–11 are TDD tasks. Tasks 1–3 are scaffolding (build-verified, not test-driven). Task 4 extends test infrastructure (verified by running existing tests + a single smoke test of the new helper). Task 12 is verification only (no commit).

**Test isolation pattern:** every handler test mocks `firebase/auth/web-extension` via `vi.mock(...)` so the real Firebase SDK never loads under jsdom. Each test sets up its mocks via `vi.resetAllMocks()` in `beforeEach`, then dispatches a synthetic `onMessageExternal` event using a helper added in Task 4.

## Note on env setup

From Task 2 onward `npm run build` requires a populated `.env.local`. Any non-empty placeholder values work for build verification — real Firebase / OAuth values are only needed when manually testing the loaded extension against the actual webapp. Recommended local file:

```
# .env.local — gitignored. Build-only placeholders below; replace with real values for runtime auth.
VITE_FIREBASE_API_KEY=test-api-key
VITE_FIREBASE_AUTH_DOMAIN=test.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=test-project
VITE_FIREBASE_APP_ID=test-app-id
VITE_GOOGLE_OAUTH_CLIENT_ID=test-client.apps.googleusercontent.com
```

`.env.local` is already covered by [.gitignore](../../../.gitignore) line 12.

---

### Task 1: Add `firebase` dependency and env scaffolding

**Why:** Subsequent tasks need the `firebase` package and the `.env.local` machinery. No behavior change yet — just dependency + docs.

**Files:**
- Modify: `package.json` (adds `firebase` to `dependencies`)
- Regenerated: `package-lock.json`
- Create: `.env.example`
- Create locally (gitignored): `.env.local`

- [ ] **Step 1: Install firebase as a runtime dependency**

Run:
```bash
npm install firebase
```
Expected: `firebase` appears under `dependencies` in [package.json](../../../package.json) (not `devDependencies` — the SW uses it at runtime). `package-lock.json` updates.

- [ ] **Step 2: Verify firebase landed in `dependencies`**

Run: `node -e "console.log(require('./package.json').dependencies.firebase)"`
Expected: prints a version string starting with `^` (e.g. `^11.x.x`). If undefined, move it manually from `devDependencies`.

- [ ] **Step 2b: Add ambient augmentation for partitioned-cookie chrome types**

`@types/chrome ^0.1.40` (current latest on DefinitelyTyped — `npm view @types/chrome version` returns `0.1.40`) ships the basic `chrome.cookies` namespace (`Cookie`, `SetDetails`, `Details`, `getAll`, `set`, `remove`, `sameSite`) but does **not** yet ship the partitioned-cookie additions Chrome added in 117/132: the `partitionKey` field on existing interfaces, the `CookiePartitionKey` interface, and `chrome.cookies.getPartitionKey`. We add a small ambient declaration file that augments the namespace via TypeScript declaration merging.

The file MUST have no top-level `import` or `export` (otherwise it becomes a module and the augmentation no longer reaches the global namespace).

Create [src/chrome-cookies-partition.d.ts](../../../src/chrome-cookies-partition.d.ts):

```ts
// Ambient augmentation for chrome.cookies partitioned-cookie types not yet
// shipped on DefinitelyTyped (@types/chrome 0.1.40 is the latest as of
// 2026-05). Drop this file once @types/chrome includes them.

declare namespace chrome.cookies {
  interface CookiePartitionKey {
    topLevelSite?: string;
    hasCrossSiteAncestor?: boolean;
  }

  // Declaration merging: the existing interfaces in @types/chrome are
  // re-opened here with the partitioned-cookie field.
  interface Cookie {
    partitionKey?: CookiePartitionKey;
  }
  interface SetDetails {
    partitionKey?: CookiePartitionKey;
  }
  interface Details {
    partitionKey?: CookiePartitionKey;
  }
  interface GetAllDetails {
    partitionKey?: CookiePartitionKey;
  }

  function getPartitionKey(details: {
    tabId: number;
    frameId: number;
  }): Promise<{ partitionKey: CookiePartitionKey }>;
}
```

Verify the file is picked up by the TS program (it lives under `src/` which `tsconfig.json` includes by default):

Run: `npm run build`
Expected: `tsc --noEmit` passes. (No code uses the augmented types yet, so this confirms the augmentation does not itself break compilation.)

- [ ] **Step 3: Create `.env.example`**

Create [.env.example](../../../.env.example) with:

```
# Firebase web SDK config (browser-bundled — values are public, but committed
# placeholders only). Get real values from the Firebase console for your project.
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_APP_ID=

# Chrome OAuth client_id for chrome.identity.getAuthToken.
# Register a "Chrome App" client in Google Cloud Console for this extension's
# public key.
VITE_GOOGLE_OAUTH_CLIENT_ID=
```

- [ ] **Step 4: Create local `.env.local` with placeholder values**

Create [.env.local](../../../.env.local) (NOT committed — `.gitignore` covers it):

```
VITE_FIREBASE_API_KEY=test-api-key
VITE_FIREBASE_AUTH_DOMAIN=test.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=test-project
VITE_FIREBASE_APP_ID=test-app-id
VITE_GOOGLE_OAUTH_CLIENT_ID=test-client.apps.googleusercontent.com
```

- [ ] **Step 5: Verify `.env.local` is gitignored**

Run: `git check-ignore -v .env.local`
Expected: prints `.gitignore:12:.env.local	.env.local`. If it does not print anything, the file is tracked — abort and fix `.gitignore` before committing.

- [ ] **Step 6: Verify build still passes**

Run: `npm run build`
Expected: exits 0. (No code uses the new env vars yet, so build does not depend on `.env.local`.)

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json .env.example src/chrome-cookies-partition.d.ts
git commit -m "$(cat <<'EOF'
Add firebase dep + chrome cookies partition augmentation + env scaffolding

firebase enters as a runtime dependency (used by the service worker via
firebase/auth/web-extension).

@types/chrome 0.1.40 (current latest on DefinitelyTyped) ships the
basic chrome.cookies namespace but does not yet ship the partitioned-
cookie additions Chrome added in 117/132. src/chrome-cookies-partition.d.ts
is an ambient declaration that augments chrome.cookies via TypeScript
declaration merging: adds `partitionKey?: CookiePartitionKey` to
Cookie / SetDetails / Details / GetAllDetails, and declares
chrome.cookies.getPartitionKey. The file has no top-level imports/exports
so the augmentation reaches the global namespace; remove it once
DefinitelyTyped catches up.

.env.example documents the four Firebase web-config keys plus the Chrome
OAuth client_id; values flow through Vite's loadEnv into manifest.ts and
the SW Firebase init in subsequent commits. .env.local stays gitignored.
EOF
)"
```

---

### Task 2: Convert `manifest.ts` to `buildManifest(env)` + wire `loadEnv` in `vite.config.ts` + add all new manifest fields

**Why:** Vite does not auto-populate `process.env.VITE_*` during config evaluation, so the manifest builder must take env explicitly. Doing the function refactor and the field additions in one commit keeps the build green at every step (a half-refactored manifest with only some new fields would be a confusing intermediate state).

**Files:**
- Modify: `manifest.ts` (rewrite — convert default export to `buildManifest(env)` function, add new permissions / `host_permissions` / `oauth2` / `externally_connectable` / `minimum_chrome_version`)
- Modify: `vite.config.ts` (use `defineConfig(({ mode }) => …)` + `loadEnv(...)`, pass env into `makeManifest`)
- Create: `src/vite-env.d.ts` — `ImportMetaEnv` / `ImportMeta` typings (script-context ambient; cannot live in `src/global.d.ts` because that file is a module)

- [ ] **Step 1: Rewrite [manifest.ts](../../../manifest.ts)**

Replace the entire file with:

```ts
import packageJson from "./package.json";

export type ManifestEnv = {
  VITE_GOOGLE_OAUTH_CLIENT_ID?: string;
};

const REQUIRED_KEYS: (keyof ManifestEnv)[] = ["VITE_GOOGLE_OAUTH_CLIENT_ID"];

export function buildManifest(env: ManifestEnv): chrome.runtime.ManifestV3 {
  const missing = REQUIRED_KEYS.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(
      `buildManifest: missing required env keys: ${missing.join(", ")}. ` +
        `Set them in .env.local (see .env.example).`,
    );
  }

  return {
    manifest_version: 3,
    name: packageJson.name,
    version: packageJson.version,
    description: packageJson.description,
    minimum_chrome_version: "132",
    background: {
      service_worker: "src/pages/background/index.js",
      type: "module",
    },
    action: {},
    permissions: ["activeTab", "identity", "storage", "cookies"],
    host_permissions: ["https://commentarium.app/*"],
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
}
```

Key points:
- `minimum_chrome_version: "132"` — required for `chrome.cookies.getPartitionKey`.
- `permissions` adds `identity`, `storage`, `cookies`.
- `host_permissions` narrowed to commentarium.app.
- `externally_connectable.matches` lets webapp pages call `chrome.runtime.sendMessage(EXT_ID, …)`.
- `oauth2.client_id` filled from env; `buildManifest` throws if missing.
- `oauth2`, `externally_connectable`, `minimum_chrome_version`, `host_permissions` may not all appear on `chrome.runtime.ManifestV3` from `@types/chrome` — TypeScript may complain. If so, add a single `as chrome.runtime.ManifestV3` cast on the `return { … }` block, or declare a union type — keep it small. Verify in Step 4.

- [ ] **Step 2: Update [vite.config.ts](../../../vite.config.ts)**

The current file (read it first to confirm shape) statically calls `defineConfig({ … })` and imports `manifest` as a default export from `./manifest`. Replace lines 1-83 with:

```ts
/// <reference types="vitest" />
import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path, { resolve } from "path";
import makeManifest from "./utils/plugins/make-manifest";
import customDynamicImport from "./utils/plugins/custom-dynamic-import";
import addHmr from "./utils/plugins/add-hmr";
import { buildManifest } from "./manifest";

const root = resolve(__dirname, "src");
const pagesDir = resolve(root, "pages");
const assetsDir = resolve(root, "assets");
const outDir = resolve(__dirname, "dist");
const publicDir = resolve(__dirname, "public");

const isDev = process.env.__DEV__ === "true";
const isProduction = !isDev;

// ENABLE HMR IN BACKGROUND SCRIPT
const enableHmrInBackgroundScript = true;

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  return {
    resolve: {
      alias: {
        "@src": root,
        "@assets": assetsDir,
        "@pages": pagesDir,
      },
    },
    plugins: [
      react(),
      makeManifest(buildManifest(env), {
        isDev,
        contentScriptCssKey: regenerateCacheInvalidationKey(),
      }),
      customDynamicImport(),
      addHmr({ background: enableHmrInBackgroundScript, view: true }),
    ],
    publicDir,
    build: {
      outDir,
      minify: isProduction,
      reportCompressedSize: isProduction,
      rollupOptions: {
        input: {
          content: resolve(pagesDir, "content", "index.ts"),
          background: resolve(pagesDir, "background", "index.ts"),
          contentStyle: resolve(pagesDir, "content", "style.scss"),
        },
        watch: {
          include: ["src/**", "vite.config.ts"],
          exclude: ["node_modules/**", "src/**/*.spec.ts"],
        },
        output: {
          entryFileNames: "src/pages/[name]/index.js",
          chunkFileNames: isDev
            ? "assets/js/[name].js"
            : "assets/js/[name].[hash].js",
          assetFileNames: (assetInfo) => {
            const sourceFiles = assetInfo.originalFileNames ?? [];
            const isContentStyle = sourceFiles.some((f) =>
              f.endsWith("src/pages/content/style.scss"),
            );
            if (isContentStyle) {
              return `assets/css/contentStyle${cacheInvalidationKey}.chunk.css`;
            }
            const assetName = assetInfo.names?.[0] ?? assetInfo.name ?? "asset";
            const { dir, name: _name } = path.parse(assetName);
            const assetFolder = dir.split("/").at(-1) ?? "";
            const name = assetFolder + firstUpperCase(_name);
            return `assets/[ext]/${name}.chunk.[ext]`;
          },
        },
      },
    },
    test: {
      environment: "jsdom",
      globals: false,
      setupFiles: ["./test-utils/vitest.setup.ts"],
    },
  };
});

function firstUpperCase(str: string) {
  const firstAlphabet = new RegExp(/( |^)[a-z]/, "g");
  return str.toLowerCase().replace(firstAlphabet, (L) => L.toUpperCase());
}

let cacheInvalidationKey: string = generateKey();
function regenerateCacheInvalidationKey() {
  cacheInvalidationKey = generateKey();
  return cacheInvalidationKey;
}

function generateKey(): string {
  return `${(Date.now() / 100).toFixed()}`;
}
```

Four structural changes:
1. `loadEnv` is imported from `"vite"` (not `"vitest/config"` — that module re-exports `defineConfig` only).
2. `import { buildManifest } from "./manifest"` (named import) replaces the default `manifest` import.
3. `defineConfig(({ mode }) => { const env = loadEnv(mode, process.cwd(), "VITE_"); return { … }; })`.
4. `makeManifest(buildManifest(env), { … })` replaces `makeManifest(manifest, { … })`.

Everything else is preserved.

- [ ] **Step 3: Create `src/vite-env.d.ts`**

[src/global.d.ts](../../../src/global.d.ts) is a module (it begins with `import Chrome from "chrome"`), so adding `interface ImportMetaEnv {...}` there would create a module-scoped interface that does not augment the global `ImportMeta`. The augmentation must live in a script-context file (no top-level `import` / `export`).

Create [src/vite-env.d.ts](../../../src/vite-env.d.ts):

```ts
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FIREBASE_API_KEY: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN: string;
  readonly VITE_FIREBASE_PROJECT_ID: string;
  readonly VITE_FIREBASE_APP_ID: string;
  readonly VITE_GOOGLE_OAUTH_CLIENT_ID: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
```

The triple-slash reference pulls in Vite's base `ImportMetaEnv` definition; our `interface ImportMetaEnv { … }` block then declaration-merges our `VITE_*` keys into it.

- [ ] **Step 4: Run `npm run build` with `.env.local` populated**

Run: `npm run build`
Expected: exits 0. If `tsc --noEmit` fails because `chrome.runtime.ManifestV3` lacks `minimum_chrome_version` / `oauth2` / `externally_connectable` / `host_permissions`, edit the return statement in `manifest.ts` to add `as chrome.runtime.ManifestV3` cast and re-run.

- [ ] **Step 5: Verify the produced manifest contains the new fields**

Run:
```bash
node -e '
  const m = require("./dist/manifest.json");
  const checks = [
    ["minimum_chrome_version", m.minimum_chrome_version === "132"],
    ["permissions has identity", m.permissions.includes("identity")],
    ["permissions has storage", m.permissions.includes("storage")],
    ["permissions has cookies", m.permissions.includes("cookies")],
    ["host_permissions", JSON.stringify(m.host_permissions) === JSON.stringify(["https://commentarium.app/*"])],
    ["externally_connectable", JSON.stringify(m.externally_connectable.matches) === JSON.stringify(["https://commentarium.app/*"])],
    ["oauth2.client_id", m.oauth2.client_id === "test-client.apps.googleusercontent.com"],
    ["oauth2.scopes", JSON.stringify(m.oauth2.scopes) === JSON.stringify(["openid", "email", "profile"])],
  ];
  for (const [name, ok] of checks) console.log((ok ? "PASS " : "FAIL ") + name);
  if (checks.some(([, ok]) => !ok)) process.exit(1);
'
```
Expected: every line says `PASS`. Exits 0.

- [ ] **Step 6: Verify `buildManifest` throws when env is missing**

Run:
```bash
node --experimental-vm-modules -e '
  process.env = {};
  import("./manifest.ts").then((m) => {
    try { m.buildManifest({}); console.log("FAIL: did not throw"); process.exit(1); }
    catch (e) { if (String(e).includes("VITE_GOOGLE_OAUTH_CLIENT_ID")) console.log("PASS: throws"); else { console.log("FAIL: wrong error: " + e); process.exit(1); } }
  });
'
```
Expected: prints `PASS: throws`. (If the import syntax for raw `.ts` files fails on your Node, instead temporarily delete `.env.local`, run `npm run build`, and verify it exits non-zero with the missing-key error; restore `.env.local` afterwards.)

- [ ] **Step 7: Run existing tests**

Run: `npm test`
Expected: 1 test passes (the existing message-listener test). No regression.

- [ ] **Step 8: Commit**

```bash
git add manifest.ts vite.config.ts src/vite-env.d.ts
git commit -m "$(cat <<'EOF'
Convert manifest to buildManifest(env) + add cycle ③ permissions

manifest.ts becomes a function so that values from .env*.local can be
injected at build time; vite.config.ts now wraps its export in
defineConfig(({ mode }) => ...) and calls loadEnv to populate the env
argument. buildManifest throws fast if VITE_GOOGLE_OAUTH_CLIENT_ID is
missing.

New manifest fields:
- minimum_chrome_version: "132" (chrome.cookies.getPartitionKey floor)
- permissions += identity, storage, cookies
- host_permissions: ["https://commentarium.app/*"]
- externally_connectable.matches: ["https://commentarium.app/*"]
- oauth2 (client_id from env, openid/email/profile scopes)

import.meta.env keys typed in a new src/vite-env.d.ts (script-context
ambient file — augments the global ImportMeta interface, which is not
possible from src/global.d.ts since it has top-level imports).
EOF
)"
```

---

### Task 3: Create `src/pages/background/firebase.ts` Firebase init module

**Why:** The auth handler needs an `Auth` instance. Isolating the init keeps `auth.ts` focused on the message handler. `firebase.ts` reads `import.meta.env.VITE_FIREBASE_*` and throws on missing keys.

**Files:**
- Create: `src/pages/background/firebase.ts`

- [ ] **Step 1: Create [src/pages/background/firebase.ts](../../../src/pages/background/firebase.ts)**

```ts
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth/web-extension";

const REQUIRED = [
  "VITE_FIREBASE_API_KEY",
  "VITE_FIREBASE_AUTH_DOMAIN",
  "VITE_FIREBASE_PROJECT_ID",
  "VITE_FIREBASE_APP_ID",
] as const;

function readConfig() {
  const env = import.meta.env;
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(
      `firebase.ts: missing required env keys: ${missing.join(", ")}. ` +
        `Set them in .env.local (see .env.example).`,
    );
  }
  return {
    apiKey: env.VITE_FIREBASE_API_KEY,
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: env.VITE_FIREBASE_PROJECT_ID,
    appId: env.VITE_FIREBASE_APP_ID,
  };
}

const app = initializeApp(readConfig());
export const auth = getAuth(app);
```

Notes:
- `firebase/auth/web-extension` is the SW-compatible build (default persistence is `indexedDBLocalPersistence`, which survives SW restarts on MV3).
- Use `getAuth(app)` — not `initializeAuth(app)` without deps. `getAuth` is the documented entry point for the web-extension build and wires the platform's default persistence; `initializeAuth(app)` without an explicit `persistence` argument bypasses that default and would degrade to in-memory, breaking SW-restart and browser-restart user retention.
- Module-scope side effect (`initializeApp` + `getAuth` at import time) is intentional: SW imports `auth` once and the singleton is ready.

- [ ] **Step 2: Verify build passes**

Run: `npm run build`
Expected: exits 0. (The module is not imported anywhere yet, so it does not affect the SW bundle.)

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: 1 existing test passes. No regression.

- [ ] **Step 4: Commit**

```bash
git add src/pages/background/firebase.ts
git commit -m "$(cat <<'EOF'
Add SW Firebase init module

firebase.ts reads VITE_FIREBASE_* from import.meta.env, throws on missing
keys, and exports a single Auth instance built from the
firebase/auth/web-extension entry, default persistence is
indexedDBLocalPersistence — survives SW restart on MV3).
The auth handler in the next commit will import this Auth singleton.
EOF
)"
```

---

### Task 4: Extend chrome mocks in `test-utils/vitest.setup.ts`

**Why:** Subsequent tests need `chrome.runtime.onMessageExternal`, `chrome.cookies.*`, `chrome.identity.*`, `chrome.storage.local.*`, and `chrome.tabs.*`. The current mock only stubs `chrome.runtime.onMessage`. We extend it with stubs that capture listener registrations and expose dispatch helpers.

**Files:**
- Modify: `test-utils/vitest.setup.ts`

- [ ] **Step 1: Replace [test-utils/vitest.setup.ts](../../../test-utils/vitest.setup.ts)**

Replace the entire file with:

```ts
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

// chrome.cookies.* (new) — `set` resolves to the resulting Cookie on
// success (or null/undefined on failure). Default to a minimal Cookie-like
// object so the SW's success path proceeds; tests that exercise the
// failure path override per-call with mockResolvedValueOnce(null).
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
```

Highlights:
- `chrome.cookies.getPartitionKey` returns `{ partitionKey: { topLevelSite, hasCrossSiteAncestor } }` — the wrapper shape Chrome actually returns (the value the SW passes back to `chrome.cookies.set` is `partitionKey.partitionKey`).
- `chrome.storage.local` is backed by an in-memory `Map`, so per-key writes are atomic per call (no shared-list lost updates by construction).
- `dispatchExternalMessage` returns a promise that resolves with whatever the handler passes to `sendResponse`. If the handler returns `true` (asynchronous response), we wait for `sendResponse` indefinitely; otherwise we resolve `undefined` on the next tick to model a silent drop.
- The default sender mirrors a typical iframe call: origin commentarium.app, url under `/comments` with `surface=extension`, valid `tab.id` and `frameId`.

- [ ] **Step 2: Run existing tests**

Run: `npm test`
Expected: the existing message-listener test still passes (it imports `dispatchChromeMessage` from this file, which is still exported).

- [ ] **Step 3: Verify the helper compiles by adding a tiny smoke test**

This step writes a throwaway test, runs it, then deletes it before commit — a sanity-check that the new helpers are usable. (No real production code uses the new helpers yet.)

Create a temporary file `src/pages/background/auth.test.ts` (will be expanded in later tasks but for now is a smoke test):

```ts
import { describe, it, expect } from "vitest";
import { dispatchExternalMessage } from "../../../test-utils/vitest.setup";

describe("dispatchExternalMessage helper", () => {
  it("resolves to undefined when no listener is registered", async () => {
    const result = await dispatchExternalMessage({ type: "noop" });
    expect(result).toBeUndefined();
  });
});
```

Run: `npm test`
Expected: 2 tests pass (the existing one + this smoke test).

Leave the file in place — Task 5 will expand it with real handler tests.

- [ ] **Step 4: Commit**

```bash
git add test-utils/vitest.setup.ts src/pages/background/auth.test.ts
git commit -m "$(cat <<'EOF'
Extend chrome mocks for cycle ③ auth tests

vitest.setup.ts gains stubs for chrome.runtime.onMessageExternal,
chrome.cookies (set/remove/getAll/getPartitionKey), chrome.identity
(getAuthToken/clearAllCachedAuthTokens), and chrome.storage.local
(set/get/remove backed by an in-memory Map for atomic per-key writes).

dispatchExternalMessage helper synthesizes an onMessageExternal event
with a default sender shaped like an iframe call from commentarium.app
under /comments?...&surface=extension. Tests can override sender bits
to exercise origin and url-path gates.

Adds a smoke test for the new helper as a placeholder; will grow into
the real auth handler tests in subsequent commits.
EOF
)"
```

---

### Task 5: Auth module skeleton — `onMessageExternal` listener with sender-origin and per-op `sender.url` path gates

**Why:** Defense-in-depth gates come before any handler logic. Both gates are silent drops — handler exits without calling `sendResponse`, so the webapp caller times out on its end (acceptable: a malformed call should never look successful).

**Files:**
- Modify: `src/pages/background/auth.test.ts` (replace smoke test with the real first tests)
- Create: `src/pages/background/auth.ts`
- Modify: `src/pages/background/index.ts` (import auth module)

- [ ] **Step 1: Write the failing tests**

Replace [src/pages/background/auth.test.ts](../../../src/pages/background/auth.test.ts) with:

```ts
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
      { origin: "https://evil.example" },
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
      },
    );
    expect(result).toBeUndefined();
  });

  it("drops signIn.* when sender.url path lacks surface=extension", async () => {
    const result = await dispatchExternalMessage(
      { type: "commentarium.auth.signIn.anonymous" },
      {
        url: "https://commentarium.app/comments?url=https%3A%2F%2Fexample.com%2F",
      },
    );
    expect(result).toBeUndefined();
  });

  it("drops signIn.* when sender.url path is /about", async () => {
    const result = await dispatchExternalMessage(
      { type: "commentarium.auth.signIn.anonymous" },
      {
        url: "https://commentarium.app/about?surface=extension",
      },
    );
    expect(result).toBeUndefined();
  });

  it("registers exactly one onMessageExternal listener", async () => {
    expect(chrome.runtime.onMessageExternal.addListener).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test src/pages/background/auth.test.ts`
Expected: FAIL — `Cannot find module './auth'` or all six tests fail.

- [ ] **Step 3: Create [src/pages/background/auth.ts](../../../src/pages/background/auth.ts)**

```ts
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
  return parsed.origin === ALLOWED_ORIGIN && parsed.pathname === "/auth/handoff";
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
    if (typeof type !== "string" || !type.startsWith(TYPE_NAMESPACE)) return false;
    if (!pathAllowedForType(type, sender.url)) return false;
    if (sender.tab?.id == null || sender.frameId == null) return false;

    void handle(type, sender).then(
      (resp) => sendResponse(resp),
      (err) =>
        sendResponse({
          error: { code: "auth/internal-error", message: String(err) },
        } satisfies AuthResponseFailure),
    );
    return true; // keep sendResponse alive across the await
  },
);

async function handle(
  type: string,
  _sender: chrome.runtime.MessageSender,
): Promise<AuthResponse> {
  // Per-op handlers added in Tasks 6–10. Until then every type returns a
  // not-implemented error so an accidentally-routed request fails loudly.
  return {
    error: { code: "auth/not-implemented", message: `unimplemented op: ${type}` },
  };
}
```

Notes:
- The listener is registered at module scope. Importing the module (Task 5 step 5 wires this in `background/index.ts`) registers it once.
- `pathAllowedForType` runs after the namespace check. Unknown `commentarium.auth.*` types coming from `/comments?surface=extension` *do* reach `handle` (where they hit the default branch and return `auth/not-implemented`). Unknown types coming from any other URL get dropped at the path-gate stage. Adding a new op only requires extending the switch in `handle`; the gates already cover any `commentarium.auth.*` URL pattern that matches the right surface.
- Returning `true` keeps `sendResponse` open across the async work; per Chrome's MV3 contract this is required for any handler that calls `sendResponse` after an `await`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test src/pages/background/auth.test.ts`
Expected: all six tests PASS.

- [ ] **Step 5: Wire auth module into the background entry**

Modify [src/pages/background/index.ts](../../../src/pages/background/index.ts) by adding the import as the first line under the existing `reloadOnUpdate` imports. The full file becomes:

```ts
import reloadOnUpdate from "virtual:reload-on-update-in-background-script";

import "./auth";

reloadOnUpdate("pages/background");

/**
 * Extension reloading is necessary because the browser automatically caches the css.
 * If you do not use the css of the content script, please delete it.
 */
reloadOnUpdate("pages/content/style.scss");

console.log("background loaded");

chrome.action.onClicked.addListener((tab) => {
  const event = { type: "toggle", url: tab.url };
  chrome.tabs.sendMessage(tab.id, event);
  console.log("message sent", event);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    const event = { type: "urlChange", url: changeInfo.url };
    chrome.tabs.sendMessage(tabId, event);
    console.log("message sent", event);
  }
});
```

The single-line `import "./auth";` is the only change.

- [ ] **Step 6: Verify build still passes**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/pages/background/auth.ts src/pages/background/auth.test.ts src/pages/background/index.ts
git commit -m "$(cat <<'EOF'
Add SW auth module with origin and per-op URL gates

src/pages/background/auth.ts registers a chrome.runtime.onMessageExternal
listener that drops silently on:
 - sender.origin !== https://commentarium.app
 - msg.type missing the commentarium.auth.* namespace
 - getIdToken from anywhere other than /auth/handoff
 - signIn / signOut / refreshSession from anywhere other than
   /comments?surface=extension

The handler stub returns auth/not-implemented for every op pending
Tasks 6–10. Background entry imports the module so the listener
registers at SW startup.
EOF
)"
```

---

### Task 6: `signIn.anonymous` handler — Firebase + cookie + registry

**Why:** First real op. Establishes the pattern every other sign-in / refresh op follows: `await authStateReady`, sign in, fetch fresh ID token, POST `/api/login`, `chrome.cookies.set` with `getPartitionKey`-derived partition, write registry.

**Files:**
- Modify: `src/pages/background/auth.test.ts` (add tests)
- Modify: `src/pages/background/auth.ts` (implement op)

- [ ] **Step 1: Write the failing test**

Append to [src/pages/background/auth.test.ts](../../../src/pages/background/auth.test.ts) (the `signInAnonymously` import is already at the top from Task 5):

```ts
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test src/pages/background/auth.test.ts`
Expected: FAIL — both new tests fail with `auth/not-implemented`.

- [ ] **Step 3: Implement `signIn.anonymous` in [src/pages/background/auth.ts](../../../src/pages/background/auth.ts)**

Replace the stub `handle` function with the dispatcher and add the helper utilities. The full updated file:

```ts
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
  try { parsed = new URL(url); } catch { return false; }
  return (
    parsed.origin === ALLOWED_ORIGIN &&
    parsed.pathname === "/comments" &&
    parsed.searchParams.get("surface") === "extension"
  );
}

function isHandoffSurface(url: string | undefined): boolean {
  if (!url) return false;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  return parsed.origin === ALLOWED_ORIGIN && parsed.pathname === "/auth/handoff";
}

function pathAllowedForType(type: string, url: string | undefined): boolean {
  if (type === "commentarium.auth.getIdToken") return isHandoffSurface(url);
  return isIframeSurface(url);
}

function canonicalPartitionKey(pk: chrome.cookies.CookiePartitionKey): string {
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
  const body = (await response.json()) as { session: string; expiresAtSeconds: number };

  const { partitionKey } = await chrome.cookies.getPartitionKey({ tabId, frameId });

  // chrome.cookies.set resolves to the resulting Cookie on success or
  // `null`/`undefined` on failure (no exception). Check explicitly so we
  // never declare success and write to the registry for a cookie that
  // wasn't actually persisted.
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
    if (typeof type !== "string" || !type.startsWith(TYPE_NAMESPACE)) return false;
    if (!pathAllowedForType(type, sender.url)) return false;
    if (sender.tab?.id == null || sender.frameId == null) return false;

    void handle(type, sender).then(
      (resp) => sendResponse(resp),
      (err) => sendResponse({ error: asAuthError(err) } satisfies AuthFailure),
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
      return { error: { code: "auth/not-implemented", message: `unimplemented op: ${type}` } };
  }
}

async function signInAnonymousOp(
  sender: chrome.runtime.MessageSender,
): Promise<AuthResponse> {
  try {
    await signInAnonymously(auth);
    if (!auth.currentUser) {
      return { error: { code: "auth/no-current-user", message: "signInAnonymously did not produce a user" } };
    }
    const idToken = await auth.currentUser.getIdToken();
    await mintAndWriteCookie({ idToken, sender });
    return { ok: true };
  } catch (err) {
    return { error: asAuthError(err) };
  }
}
```

Notes:
- Imports of `signInWithCredential`, `firebaseSignOut`, `GoogleAuthProvider` are already in place — Tasks 7 / 9 will use them. Adding them in this commit avoids a churn of repeated imports.
- `mintAndWriteCookie` is the shared core that Tasks 7 (signIn.google) and 8 (refreshSession) reuse.
- `canonicalPartitionKey` returns e.g. `https://example.com|csa=1`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test src/pages/background/auth.test.ts`
Expected: all 8 tests pass (6 from Task 5 + 2 new).

- [ ] **Step 5: Run build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/pages/background/auth.ts src/pages/background/auth.test.ts
git commit -m "$(cat <<'EOF'
Implement signIn.anonymous broker op

SW signs in via firebase/auth/web-extension, mints a fresh ID token,
POSTs commentarium.app/api/login with Authorization: Bearer + the
X-Commentarium-Surface: extension header, then writes the resulting
session cookie via chrome.cookies.set with the partition key resolved
from chrome.cookies.getPartitionKey({ tabId, frameId }) on the sender
frame. The partition is then registered under
partitionRegistry:<canonical> in chrome.storage.local so sign-out can
clean up later (chrome.cookies.getAll does not enumerate partitioned
cookies by default).

Refactors the listener into a per-op switch so subsequent ops slot in
without restructuring; introduces shared mintAndWriteCookie helper used
by signIn.google and refreshSession in the next commits.
EOF
)"
```

---

### Task 7: `signIn.google` handler — `chrome.identity` + `signInWithCredential`

**Why:** Same shape as anonymous, but the credential comes from `chrome.identity.getAuthToken` rather than `signInAnonymously`. Reuses `mintAndWriteCookie`.

**Files:**
- Modify: `src/pages/background/auth.test.ts` (add tests)
- Modify: `src/pages/background/auth.ts` (add op)

- [ ] **Step 1: Write the failing test**

Append to [src/pages/background/auth.test.ts](../../../src/pages/background/auth.test.ts) (the `signInWithCredential` and `GoogleAuthProvider` imports are already at the top from Task 5):

```ts
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
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test src/pages/background/auth.test.ts`
Expected: FAIL — the new test gets `auth/not-implemented`.

- [ ] **Step 3: Implement `signIn.google`**

In [src/pages/background/auth.ts](../../../src/pages/background/auth.ts), inside the `handle` switch, add a case before the default:

```ts
    case "commentarium.auth.signIn.google":
      return signInGoogleOp(sender);
```

Then add the function below `signInAnonymousOp`:

```ts
async function signInGoogleOp(
  sender: chrome.runtime.MessageSender,
): Promise<AuthResponse> {
  try {
    // The Promise form of chrome.identity.getAuthToken returns a
    // GetAuthTokenResult object, not a bare string. The string is the legacy
    // callback-API shape. Extract .token explicitly.
    const tokenResult = await chrome.identity.getAuthToken({ interactive: true });
    const accessToken = tokenResult?.token;
    if (!accessToken) {
      return { error: { code: "identity/no-token", message: "chrome.identity.getAuthToken returned no token" } };
    }
    const credential = GoogleAuthProvider.credential(null, accessToken);
    await signInWithCredential(auth, credential);
    if (!auth.currentUser) {
      return { error: { code: "auth/no-current-user", message: "signInWithCredential did not produce a user" } };
    }
    const idToken = await auth.currentUser.getIdToken();
    await mintAndWriteCookie({ idToken, sender });
    return { ok: true };
  } catch (err) {
    return { error: asAuthError(err) };
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test src/pages/background/auth.test.ts`
Expected: 9 tests pass.

- [ ] **Step 5: Build verification**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/pages/background/auth.ts src/pages/background/auth.test.ts
git commit -m "Implement signIn.google broker op (chrome.identity + signInWithCredential)"
```

---

### Task 8: `refreshSession` handler — happy path + user-gone path

**Why:** The webapp calls `refreshSession` on cold start (with broker user but no partitioned cookie for this site) and on every 401. Two distinct outcomes: success → `{ ok: true }`; user gone → trigger sign-out cleanup and respond `{ error, signedOut: true }`.

**Files:**
- Modify: `src/pages/background/auth.test.ts`
- Modify: `src/pages/background/auth.ts`

- [ ] **Step 1: Write the failing tests**

Append to [src/pages/background/auth.test.ts](../../../src/pages/background/auth.test.ts):

```ts
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
```

The `signOut` import is already at the top of the test file from Task 5; `vi.mocked(signOut)` is unnecessary because the mocked module's exports *are* the spy functions — `expect(signOut).toHaveBeenCalledOnce()` works directly.

- [ ] **Step 2: Verify failure**

Run: `npm test src/pages/background/auth.test.ts`
Expected: 3 new tests fail with `auth/not-implemented`.

- [ ] **Step 3: Implement `refreshSession` and the shared sign-out cleanup**

In [src/pages/background/auth.ts](../../../src/pages/background/auth.ts) add to the switch:

```ts
    case "commentarium.auth.refreshSession":
      return refreshSessionOp(sender);
```

Add the implementation after `signInGoogleOp`:

```ts
async function refreshSessionOp(
  sender: chrome.runtime.MessageSender,
): Promise<AuthResponse> {
  if (!auth.currentUser) {
    // Stale registry / partitioned cookies could outlive the Firebase user
    // (e.g., user was cleared in another SW context but cookies in
    // chrome.cookies + the registry are still around). Run the same cleanup
    // path as a real sign-out so the response and the actual stored state
    // match.
    await performSignOutCleanup();
    return {
      error: { code: "auth/no-current-user", message: "no signed-in user" },
      signedOut: true,
    };
  }
  let idToken: string;
  try {
    idToken = await auth.currentUser.getIdToken(true);
  } catch (err) {
    await performSignOutCleanup();
    return { error: asAuthError(err), signedOut: true };
  }
  try {
    await mintAndWriteCookie({ idToken, sender });
    return { ok: true };
  } catch (err) {
    return { error: asAuthError(err) };
  }
}

async function performSignOutCleanup(): Promise<void> {
  await firebaseSignOut(auth);
  await chrome.identity.clearAllCachedAuthTokens();

  const all = (await chrome.storage.local.get(null)) as Record<string, unknown>;
  const registryKeys = Object.keys(all).filter((k) => k.startsWith("partitionRegistry:"));
  for (const key of registryKeys) {
    const partitionKey = all[key] as chrome.cookies.CookiePartitionKey;
    try {
      await chrome.cookies.remove({
        url: COOKIE_URL,
        name: COOKIE_NAME,
        partitionKey,
      });
    } catch {
      // Ignore — registry may have drifted (user manually cleared cookies).
    }
  }
  if (registryKeys.length > 0) {
    await chrome.storage.local.remove(registryKeys);
  }
}
```

- [ ] **Step 4: Verify pass**

Run: `npm test src/pages/background/auth.test.ts`
Expected: 12 tests pass.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/pages/background/auth.ts src/pages/background/auth.test.ts
git commit -m "$(cat <<'EOF'
Implement refreshSession broker op

Three branches, all idempotent w.r.t. registry / cookie state:
 - currentUser is null → run shared sign-out cleanup (so any stale
   registry entries + partitioned cookies are cleared) and return
   signedOut: true
 - getIdToken(true) succeeds → POST /api/login + chrome.cookies.set, ok
 - getIdToken(true) rejects (user gone) → run shared sign-out cleanup
   and return signedOut: true

The shared cleanup helper performSignOutCleanup is reused by Task 9's
signOut op.
EOF
)"
```

---

### Task 9: `signOut` handler — registry-driven cookie cleanup

**Why:** Sign-out must clear every partitioned session cookie this extension wrote. Direct `chrome.cookies.getAll({ domain: "commentarium.app" })` returns only unpartitioned cookies, so the registry in `chrome.storage.local` is the only reliable enumeration.

**Files:**
- Modify: `src/pages/background/auth.test.ts`
- Modify: `src/pages/background/auth.ts`

- [ ] **Step 1: Write the failing test**

Append to [src/pages/background/auth.test.ts](../../../src/pages/background/auth.test.ts):

```ts
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
      .mock.calls.map((c) => (c[0] as { partitionKey: chrome.cookies.CookiePartitionKey }).partitionKey);
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
    const removedKeys = vi.mocked(chrome.storage.local.remove).mock.calls[0][0] as string[];
    expect(removedKeys).toHaveLength(3);
    expect(removedKeys.every((k) => k.startsWith("partitionRegistry:"))).toBe(true);
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
});
```

- [ ] **Step 2: Verify failure**

Run: `npm test src/pages/background/auth.test.ts`
Expected: 2 new tests fail with `auth/not-implemented`.

- [ ] **Step 3: Implement `signOut`**

In [src/pages/background/auth.ts](../../../src/pages/background/auth.ts) add to the switch:

```ts
    case "commentarium.auth.signOut":
      return signOutOp();
```

Add the function (it just delegates to the shared cleanup helper from Task 8):

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

- [ ] **Step 4: Verify pass**

Run: `npm test src/pages/background/auth.test.ts`
Expected: 14 tests pass.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/pages/background/auth.ts src/pages/background/auth.test.ts
git commit -m "$(cat <<'EOF'
Implement signOut broker op (registry-driven cookie cleanup)

signOutOp delegates to performSignOutCleanup, which iterates every
chrome.storage.local key under partitionRegistry: and calls
chrome.cookies.remove with the recorded partition key, then bulk-removes
just those registry keys. Unrelated chrome.storage entries are
untouched. chrome.identity.clearAllCachedAuthTokens drops Chrome's
OAuth-token cache so the next signIn.google shows the chooser.

chrome.cookies.getAll({ domain }) is not used — it returns only
unpartitioned cookies by default, so the registry is the only reliable
enumeration of writes this extension performed.
EOF
)"
```

---

### Task 10: `getIdToken` handler — handoff page only

**Why:** The handoff page (`/auth/handoff`) needs a fresh ID token to POST to `/api/auth/exchange`. The path gate from Task 5 already restricts this op to that surface; the handler returns `{ idToken }` or an error.

**Files:**
- Modify: `src/pages/background/auth.test.ts`
- Modify: `src/pages/background/auth.ts`

- [ ] **Step 1: Write the failing tests**

Append to [src/pages/background/auth.test.ts](../../../src/pages/background/auth.test.ts):

```ts
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
    (firebase.auth as { currentUser: unknown }).currentUser = { uid: "anon-uid", getIdToken };

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
```

- [ ] **Step 2: Verify failure**

Run: `npm test src/pages/background/auth.test.ts`
Expected: 2 new tests fail.

- [ ] **Step 3: Implement `getIdToken`**

In [src/pages/background/auth.ts](../../../src/pages/background/auth.ts) add to the switch:

```ts
    case "commentarium.auth.getIdToken":
      return getIdTokenOp();
```

Add the function:

```ts
async function getIdTokenOp(): Promise<AuthResponse> {
  if (!auth.currentUser) {
    return { error: { code: "auth/no-current-user", message: "no signed-in user" } };
  }
  try {
    const idToken = await auth.currentUser.getIdToken(true);
    return { idToken };
  } catch (err) {
    return { error: asAuthError(err) };
  }
}
```

- [ ] **Step 4: Verify pass**

Run: `npm test src/pages/background/auth.test.ts`
Expected: 16 tests pass.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/pages/background/auth.ts src/pages/background/auth.test.ts
git commit -m "$(cat <<'EOF'
Implement getIdToken broker op for handoff page

getIdTokenOp returns { idToken } from auth.currentUser.getIdToken(true).
The /auth/handoff path gate (Task 5) already restricts this op to the
handoff surface — any other commentarium.app page calling it gets a
silent drop, not a token.

This is the only op that returns an actual ID token to the page; the
iframe surface ops (signIn.*, refreshSession, signOut) only return
{ ok: true } or { error: ... } and rely on the partitioned session
cookie as the source of truth.
EOF
)"
```

---

### Task 11: Append `&surface=extension` to iframe URL

**Why:** The webapp uses this query parameter to detect that it is running inside the extension's panel and switch to broker mode (skip Firebase Auth web SDK init, route sign-in via `chrome.runtime.sendMessage(EXT_ID, …)`, send `X-Commentarium-Surface: extension` on every API call).

**Files:**
- Modify: `src/pages/content/components/iframe/index.tsx` (one-line change)
- Create: `src/pages/content/components/iframe/index.test.tsx`

- [ ] **Step 1: Write the failing test**

Create [src/pages/content/components/iframe/index.test.tsx](../../../src/pages/content/components/iframe/index.test.tsx):

```tsx
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import IFrame from "./index";

describe("IFrame", () => {
  it("renders the commentarium URL with surface=extension appended", () => {
    const { container } = render(<IFrame url="https://example.com/page?x=1" />);
    const iframe = container.querySelector("iframe");
    expect(iframe).not.toBeNull();
    const src = iframe!.getAttribute("src");
    expect(src).toBe(
      "https://commentarium.app/comments?url=" +
        encodeURIComponent("https://example.com/page?x=1") +
        "&surface=extension",
    );
  });

  it("renders an empty-state placeholder when url is empty", () => {
    const { container } = render(<IFrame url="" />);
    expect(container.textContent).toContain("No URL");
    expect(container.querySelector("iframe")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test src/pages/content/components/iframe/index.test.tsx`
Expected: the first test FAILS — `src` ends with the encoded URL, not with `&surface=extension`.

- [ ] **Step 3: Update [src/pages/content/components/iframe/index.tsx](../../../src/pages/content/components/iframe/index.tsx)**

Modify line 30. The current file (read it first to confirm) has:

```tsx
        src={"https://commentarium.app/comments?url=" + encodeURIComponent(url)}
```

Change to:

```tsx
        src={"https://commentarium.app/comments?url=" + encodeURIComponent(url) + "&surface=extension"}
```

That is the only change in this file.

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test src/pages/content/components/iframe/index.test.tsx`
Expected: 2 tests pass.

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: all tests pass (existing message-listener test + auth tests + iframe tests).

- [ ] **Step 6: Build**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/pages/content/components/iframe/index.tsx src/pages/content/components/iframe/index.test.tsx
git commit -m "$(cat <<'EOF'
Append &surface=extension to iframe URL

The webapp uses this query parameter to detect the extension surface
and switch to broker mode (no in-iframe Firebase Auth SDK; route
sign-in/sign-out/refresh through chrome.runtime.sendMessage(EXT_ID, …);
attach X-Commentarium-Surface: extension to every /api/* request).

Adds index.test.tsx covering both the URL-encoded happy path and the
empty-url placeholder branch.
EOF
)"
```

---

### Task 12: Final verification

**Why:** End-of-cycle sanity. No commit produced.

- [ ] **Step 1: Confirm clean tree and full test/build pass**

Run:
```bash
git status
npm test
npm run build
```
Expected:
- `git status` reports working tree clean (everything committed).
- `npm test` reports 16 auth tests + 2 iframe tests + 1 message-listener test passing — total 19 tests.
- `npm run build` exits 0.

- [ ] **Step 2: Inspect produced manifest**

Run: `cat dist/manifest.json | python3 -m json.tool | head -40`
Expected: top-level keys include `minimum_chrome_version`, `permissions` (with `cookies`, `identity`, `storage`), `host_permissions`, `externally_connectable`, `oauth2`. Background/action/content_scripts unchanged from cycle ②.

- [ ] **Step 3: Inspect commit log**

Run: `git log --oneline -12`
Expected: 11 commits from Tasks 1–11 plus the spec/plan commit (this plan and the spec will be committed together at the end of the writing-plans flow).

- [ ] **Step 4: Manual unpacked load (best-effort, optional in this session)**

If a Chrome browser is available:
1. Build: `npm run build`.
2. Open `chrome://extensions` → "Developer mode" ON → "Load unpacked" → pick `dist/`.
3. Verify the extension loads without errors. The Web Store install warnings should now read "Read and change your data on commentarium.app" plus the existing OAuth scope notice.
4. Click the action icon on any HTTPS page — panel slides in, iframe loads `commentarium.app/comments?url=...&surface=extension`. Until the **webapp deploys its parallel changes**, the iframe still shows the existing direct-Firebase UI (and is broken under 3rd-party cookie blocking, exactly as today).
5. Open the SW devtools (`chrome://extensions` → the extension's "Inspect views: service worker"). Confirm no errors at startup.

Full E2E (CHIPS cookie writes, signed-in second-site bootstrap, handoff to settings, delete-propagation) requires the webapp half to ship — out of scope here.

---

## Final verification (after all eleven tasks)

- [ ] `npm run build` — passes
- [ ] `npm test` — 19 tests pass
- [ ] `git log --oneline` shows 11 cycle-③ commits with terse, descriptive messages
- [ ] `dist/manifest.json` contains `minimum_chrome_version`, `cookies` permission, `host_permissions`, `externally_connectable`, `oauth2`
- [ ] No regressions in `dist/manifest.json` shape vs cycle ② (other than the new fields and the rotating contentStyle CSS asset hash)
