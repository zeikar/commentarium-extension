# Vite/Vitest Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lift the toolchain to Vite 6 + TypeScript 5 + Node 22 + Rollup 4 (HMR), introduce Vitest 4 with one real test for the message-listener stability invariant, and wire that test into CI — all in three git-bisect-friendly commits.

**Architecture:** Three sequential commits, each must build green before the next: (1) coordinated dependency bump with any minimal build-time fixes the upgrade forces; (2) CI runner pinned to Node 22; (3) Vitest config inline in `vite.config.ts`, a chrome-runtime mock setup file, one test against `Demo/app.tsx`, and an `npm test` step appended to `build-zip.yml`.

**Tech Stack:** TypeScript 5.x, React 18.2, Vite 6, Vitest 4, jsdom, @testing-library/react 16, Rollup 4 (for HMR config), Chrome Extension Manifest V3, npm, GitHub Actions, Node 22.

**Spec:** [docs/superpowers/specs/2026-05-02-vite-vitest-upgrade-design.md](../specs/2026-05-02-vite-vitest-upgrade-design.md)

---

## File Structure

Files this plan touches:

| File | Operation | Task |
|---|---|---|
| `package.json` | modify (deps + engines) | Task 1 |
| `package.json` | modify (deps + scripts) | Task 3 |
| `package-lock.json` | regenerated | Task 1, Task 3 |
| `vite.config.ts` | modify (test block + reference directive) | Task 3 |
| `tsconfig.json` | modify (include test-utils) | Task 3 |
| `.github/workflows/build-zip.yml` | modify (node-version) | Task 2 |
| `.github/workflows/build-zip.yml` | modify (npm test step) | Task 3 |
| `test-utils/vitest.setup.ts` | create | Task 3 |
| `src/pages/content/components/Demo/app.test.tsx` | create | Task 3 |
| `utils/plugins/*.ts` | possibly modify (only if upgrade trips them) | Task 1 |
| `utils/reload/rollup.config.ts` | possibly modify (only if upgrade trips it) | Task 1 |

The custom Vite plugins and HMR rollup config are listed as "possibly modify" because the spec analysis indicates they should work as-is — they use rollup-standard hooks. If they don't, fix in Task 1 and document in the commit message.

## Note on TDD

The single test in this plan exercises **existing behavior** — there is no new feature to test-drive. To verify the test is not trivially passing (e.g., asserting things that always hold regardless of impl), Task 3 includes a deliberate-break sanity step: temporarily make the listener registration unstable in `app.tsx`, confirm the test fails on call-count, then revert. This is the discipline equivalent of "watch the test fail before you watch it pass" when the impl already exists.

The two production-code-path commits (Tasks 1 and 2) are not test-driven — they are dependency / config changes whose verification is build-based. The "test" is `npm run build` exits 0 and `dist/manifest.json` shape is unchanged.

---

### Task 1: Bump deps to Vite 6 + TS 5 + Rollup 4 (Commit 1)

**Why:** Coordinated dependency lift — splitting these across commits would land an inconsistent intermediate state (e.g., TS 5 with rollup 2's `@rollup/plugin-typescript` 8 is incompatible). The custom Vite plugins use only stable Rollup hooks; expected impact on `utils/plugins/*` is zero.

**Files:**
- Capture: `dist/manifest.json` baseline (saved to `/tmp/baseline-manifest.json`)
- Modify: `package.json` (deps + engines field)
- Regenerated: `package-lock.json`
- Possibly modify: `utils/plugins/*.ts`, `utils/reload/rollup.config.ts`, `vite.config.ts`, `tsconfig.json`, source files (only if TS 5 / Rollup 4 trips them)

- [ ] **Step 1: Capture pre-upgrade baseline manifest**

The verification compares `dist/manifest.json` shape before and after the upgrade. Build the current state first.

Run:
```bash
npm run build
cp dist/manifest.json /tmp/baseline-manifest.json
```
Expected: `npm run build` exits 0. `/tmp/baseline-manifest.json` contains the current manifest with the contentStyle CSS asset name like `assets/css/contentStyle<somenumber>.chunk.css`.

- [ ] **Step 2: Bump dependencies via `npm install`**

Run a single `npm install` to bump all of the planned versions in one lockfile update:

```bash
npm install -D \
  vite@^6.0.0 \
  @vitejs/plugin-react@^4.3.0 \
  typescript@^5.6.0 \
  @types/node@^22.0.0 \
  @types/chrome@latest \
  rollup@^4.20.0 \
  @rollup/plugin-typescript@^12.0.0
```

Expected: `package.json` `devDependencies` updated; `package-lock.json` regenerated. No errors.

If npm warns about peer-dependency mismatches that are clearly transitive (e.g., a sub-dependency wanting an older `vite`), record the warning but do not chase fixes — only fix peer warnings on direct dependencies of this repo.

- [ ] **Step 3: Add `engines` field to `package.json`**

In [package.json](../../../package.json), insert the `engines` field immediately after the `"type": "module"` line (between `"type"` and `"dependencies"`):

```json
  "type": "module",
  "engines": {
    "node": ">=22"
  },
  "dependencies": {
```

- [ ] **Step 4: Run `npm run build` and capture failures**

Run: `npm run build`

(`npm run build` is `tsc --noEmit && vite build`. The HMR rollup config under `utils/reload/` is **not** exercised by `npm run build` — it is built by `npm run build:hmr`, which runs only as part of `npm run dev`. HMR-config failure mode is handled in Step 7.)

There are three plausible failure modes for `npm run build`. Address them in order, only as they appear:

**Failure mode A — TypeScript 5 strict regressions.** TS 5 has tightened a handful of inference paths since 4.8. If `tsc --noEmit` reports errors:
- Read the error. If it is a real type tightening (e.g., `unknown` no longer narrowable), fix the offending source file.
- If it is in `utils/plugins/*` or `utils/reload/*` and is a type-only issue (e.g., `PluginOption` import resolves but its constituent types changed), fix narrowly.
- Do not loosen the codebase by adding `// @ts-ignore`. Fix the type.

**Failure mode B — `@types/chrome` drift.** Going to `latest` may add nullability to e.g. `chrome.tabs.Tab.url` or rename event-listener type aliases. If the build complains in [src/pages/background/index.ts](../../../src/pages/background/index.ts) or [src/pages/content/components/Demo/app.tsx](../../../src/pages/content/components/Demo/app.tsx):
- Satisfy the new types. Typical fix: an `if (tab.url)` guard, or `(msg as ToggleMessage)` narrowing, or aligning a callback signature.
- Do not rewrite Chrome API usage; only adjust to compile.

**Failure mode C — vite.config.ts type drift.** If `defineConfig` or `PluginOption` type imports break, adjust the import (vite 6 still exports both from `vite`).

In all cases: minimum-touching fixes. Do not refactor adjacent code.

- [ ] **Step 5: Verify `dist/manifest.json` shape unchanged**

Run:
```bash
diff <(jq -S 'del(.content_scripts[].css)' /tmp/baseline-manifest.json) \
     <(jq -S 'del(.content_scripts[].css)' dist/manifest.json)
```

Expected: empty output. Every field except the `content_scripts[].css` array (which contains the rotating `<KEY>` hash) is byte-identical to the pre-upgrade baseline.

If output is non-empty, inspect the diff. The expected differences are: none. Any other diff (action.default_icon shape change, web_accessible_resources, manifest_version) means the upgrade altered manifest emission and needs investigation before the commit lands.

- [ ] **Step 6: Verify `dist/` entry-file shape**

Run: `find dist -name "*.js" | sort`

Expected (from current `entryFileNames: "src/pages/[name]/index.js"` in vite.config.ts):
```
dist/src/pages/background/index.js
dist/src/pages/content/index.js
```
(Plus any chunked `assets/js/*.js` files — those are allowed to differ in name and count.)

If the two top-level entry paths are missing or renamed, the upgrade has shifted the rollup output naming — fix in `vite.config.ts` `output.entryFileNames` before committing.

- [ ] **Step 7: Verify `npm run dev` produces a working extension (HMR Rollup config exercised here)**

Run: `npm run dev` in one terminal.

Expected: `npm run build:hmr` (the rollup-based compile of the HMR server scripts) completes, then `[HRS] Server listening at ws://localhost:8081`, then `vite v6.x.x building for development...`, build finishes, watch idle. No errors.

**Failure mode (HMR Rollup config — `utils/reload/rollup.config.ts`).** Rollup 4 may require `output.format` to be explicit; this surfaces here because `npm run build:hmr` is the step that actually runs the `utils/reload/rollup.config.ts` config. If it fails:
- Add `format: "cjs"` or `format: "esm"` (try `cjs` first — these scripts are loaded by Node) to each `output` block in [utils/reload/rollup.config.ts](../../../utils/reload/rollup.config.ts).
- If `@rollup/plugin-typescript` 12 complains about not finding a `tsconfig.json`, point it at the repo's tsconfig: `typescript({ tsconfig: "./tsconfig.json" })` in the `plugins` array.

Stop the dev server (`Ctrl+C`) — leaving it running is not required for the commit, only verifying the command starts cleanly.

(Manual end-to-end load — `chrome://extensions` → "Load unpacked" → click action icon — is recommended but not gating for this commit. The CI build artifact will be re-verified in Task 3 once tests exist.)

- [ ] **Step 8: Stage and commit**

```bash
git add package.json package-lock.json
# Plus any of the following only if Step 4 required edits:
# git add tsconfig.json vite.config.ts utils/plugins/*.ts utils/reload/rollup.config.ts src/...
git status   # confirm only intended files are staged
git commit -m "$(cat <<'EOF'
Upgrade to Vite 6 + TypeScript 5 + Node 22 + Rollup 4

Coordinated dependency lift to unblock Vitest 4 and put the toolchain on
a baseline that does not need to move again before the auth-broker work
(cycle ③). The custom Vite plugins under utils/plugins/* use only
rollup-standard hooks (buildStart/buildEnd/renderDynamicImport/
resolveId/load) and require no behavioral changes.

- vite 3.1.3 -> ^6.0.0
- @vitejs/plugin-react 2.2.0 -> ^4.3.0
- typescript 4.8.3 -> ^5.6.0
- @types/node 18.15.11 -> ^22.0.0
- @types/chrome 0.0.224 -> latest
- rollup 2.79.1 -> ^4.20.0
- @rollup/plugin-typescript ^8.5.0 -> ^12.0.0
- engines.node = ">=22"

React stays on 18.x; ESLint/Prettier deferred to separate cycles.
EOF
)"
```

If Step 4 required source/config edits to make the build pass, list those files in the commit body under a "Build-time fixes" section.

---

### Task 2: Pin CI to Node 22 (Commit 2)

**Why:** The package now requires Node ≥ 22 via `engines`. CI must run on a matching runner. The current [build-zip.yml](../../../.github/workflows/build-zip.yml) calls `actions/setup-node@v3` without a `node-version` input, which defaults to whatever the GitHub-hosted runner ships with. Pin it explicitly.

**Files:**
- Modify: `.github/workflows/build-zip.yml` (one new line under the setup-node block)

- [ ] **Step 1: Edit `build-zip.yml`**

In [.github/workflows/build-zip.yml](../../../.github/workflows/build-zip.yml) lines 17-20 currently read:

```yaml
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          cache: 'npm'
```

Change to:

```yaml
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '22'
          cache: 'npm'
```

(One added line: `node-version: '22'` above the existing `cache: 'npm'`.)

Do not bump action versions (`@v3` → `@v4`) — that is a separate concern and not in scope for this cycle.

- [ ] **Step 2: Verify YAML syntactically**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/build-zip.yml'))"`
Expected: no output (parse success). If it errors, indentation drifted — restore the two-space indent under `with:`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/build-zip.yml
git commit -m "$(cat <<'EOF'
Pin CI runner to Node 22

Matches package.json engines.node = ">=22" set in the previous commit.
The setup-node step previously had no node-version input and relied on
the runner's default; making it explicit avoids drift if GitHub changes
the default.
EOF
)"
```

---

### Task 3: Introduce Vitest 4 + first test + CI test step (Commit 3)

**Why:** The toolchain is now on Vite 6 / Node 22, which Vitest 4 requires. Bring up the runner, write the chrome-runtime mock that cycle ③ will reuse, write one test for the message-listener stability invariant ([CLAUDE.md](../../../CLAUDE.md) core rule #6), and wire `npm test` into CI so the test actually gates merges.

**Files:**
- Modify: `package.json` (add 4 devDeps + 2 scripts)
- Regenerated: `package-lock.json`
- Modify: `vite.config.ts` (reference directive + `test` block)
- Modify: `tsconfig.json` (include `test-utils`)
- Create: `test-utils/vitest.setup.ts`
- Create: `src/pages/content/components/Demo/app.test.tsx`
- Modify: `.github/workflows/build-zip.yml` (append `npm test` step)

- [ ] **Step 1: Install Vitest and testing-library deps**

Run:
```bash
npm install -D \
  vitest@^4.0.0 \
  jsdom@^25.0.0 \
  @testing-library/react@^16.0.0 \
  @testing-library/jest-dom@^6.5.0
```

Expected: lockfile updated; no peer-warnings on direct dependencies.

`jsdom` is pinned to `^25.0.0` (not left unpinned) because newer `jsdom` majors have, in past releases, raised their Node minimum past `engines: ">=22"`. Pinning at `^25` keeps the floor compatible. If a future cycle wants newer jsdom features and they require Node > 22, that is its own decision; this cycle does not surface that drift.

- [ ] **Step 2: Add the Vitest setup file**

Create [test-utils/vitest.setup.ts](../../../test-utils/vitest.setup.ts) with this exact content:

```ts
import { vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";

type ChromeMessageListener = (msg: unknown, sender: unknown) => void;

const listeners: ChromeMessageListener[] = [];

const addListener = vi.fn((cb: ChromeMessageListener) => {
  listeners.push(cb);
});

const removeListener = vi.fn((cb: ChromeMessageListener) => {
  const i = listeners.indexOf(cb);
  if (i !== -1) listeners.splice(i, 1);
});

(globalThis as unknown as { chrome: unknown }).chrome = {
  runtime: {
    onMessage: { addListener, removeListener },
  },
};

beforeEach(() => {
  addListener.mockClear();
  removeListener.mockClear();
  listeners.length = 0;
});

export function dispatchChromeMessage(
  msg: unknown,
  sender: unknown = {}
): void {
  for (const l of [...listeners]) {
    l(msg, sender);
  }
}
```

What this does:
- Imports `vi` (test-double API) and the jest-dom matcher pack (which augments Vitest's `expect`).
- Installs a global `chrome.runtime.onMessage` shim with both `addListener` and `removeListener` as `vi.fn()` spies — `removeListener` is required because `Demo/app.tsx`'s effect cleanup calls it on unmount; without the spy, RTL's automatic cleanup between tests would throw.
- Resets spies and the captured-listeners array between tests so call counts don't leak across cases.
- Exports `dispatchChromeMessage` so tests can synthesize a runtime message by invoking each captured listener directly. This is the seed of the chrome-mocking pattern that cycle ③ will extend for postMessage / port-message tests.

- [ ] **Step 3: Add Vitest config to `vite.config.ts`**

In [vite.config.ts](../../../vite.config.ts), add the reference directive at the top of the file (line 1, before any imports):

```ts
/// <reference types="vitest" />
import { defineConfig } from "vite";
```

Then add a `test` block to the config object. The current config ends with the `build` block. Add `test` as a sibling, after `build`:

```ts
  build: {
    outDir,
    /* ...existing build block... */
  },
  test: {
    environment: "jsdom",
    globals: false,
    setupFiles: ["./test-utils/vitest.setup.ts"],
  },
});
```

Notes:
- `globals: false` — we use explicit imports (`import { describe, it, expect, vi } from "vitest"`) per the spec's mock setup. No global `describe`/`it`/`expect`. This keeps the test files self-documenting.
- `environment: "jsdom"` — required for React rendering in tests.
- `setupFiles` runs once per test file before tests; that is where the chrome global is installed.

If the `test` field produces a TypeScript error after the directive is added (e.g., "Object literal may only specify known properties"), fall back to importing `defineConfig` from `vitest/config` instead of `vite`:

```ts
import { defineConfig } from "vitest/config";
```

Both forms are documented for Vitest 4. The reference-directive form is what the spec mandates; the import-form is the fallback if the directive does not resolve.

- [ ] **Step 4: Update `tsconfig.json` to include `test-utils`**

In [tsconfig.json](../../../tsconfig.json), the `include` array currently reads:

```json
  "include": ["src", "utils", "vite.config.ts", "node_modules/@types"]
```

Change to:

```json
  "include": ["src", "utils", "test-utils", "vite.config.ts", "node_modules/@types"]
```

(One element added: `"test-utils"`.) This makes `tsc --noEmit` (run as part of `npm run build`) type-check the setup file along with the rest of the project, so jest-dom matcher augmentation propagates to the test files via the setup-file import chain.

- [ ] **Step 5: Add `test` and `test:watch` scripts to `package.json`**

In [package.json](../../../package.json) the `scripts` block currently reads:

```json
  "scripts": {
    "build": "tsc --noEmit && vite build",
    "build:watch": "cross-env __DEV__=true vite build --watch",
    "build:hmr": "rollup --config utils/reload/rollup.config.ts",
    "wss": "node utils/reload/initReloadServer.js",
    "dev": "npm run build:hmr && (run-p wss build:watch)"
  },
```

Change to:

```json
  "scripts": {
    "build": "tsc --noEmit && vite build",
    "build:watch": "cross-env __DEV__=true vite build --watch",
    "build:hmr": "rollup --config utils/reload/rollup.config.ts",
    "wss": "node utils/reload/initReloadServer.js",
    "dev": "npm run build:hmr && (run-p wss build:watch)",
    "test": "vitest run",
    "test:watch": "vitest"
  },
```

(Add a comma to the `dev` line and append two new lines.)

- [ ] **Step 6: Write the listener-stability test (it should pass against current code)**

Create [src/pages/content/components/Demo/app.test.tsx](../../../src/pages/content/components/Demo/app.test.tsx) with this exact content:

```tsx
import { describe, it, expect } from "vitest";
import { render, act } from "@testing-library/react";
import App from "./app";
import { dispatchChromeMessage } from "../../../../../test-utils/vitest.setup";

describe("App message listener stability", () => {
  it("registers exactly once and does not re-register when shown toggles", () => {
    const { container } = render(<App />);

    // Mount: the listener was registered exactly once.
    expect(chrome.runtime.onMessage.addListener).toHaveBeenCalledTimes(1);

    const panel = container.querySelector(".commentarium-view");
    expect(panel).not.toBeNull();
    expect(panel).not.toHaveClass("open");

    // First toggle: panel opens.
    act(() => {
      dispatchChromeMessage({ type: "toggle", url: "https://example.com/" });
    });
    expect(panel).toHaveClass("open");

    // Second toggle: panel hides.
    act(() => {
      dispatchChromeMessage({ type: "toggle", url: "https://example.com/" });
    });
    expect(panel).not.toHaveClass("open");

    // The listener was NOT re-registered when shown toggled.
    expect(chrome.runtime.onMessage.addListener).toHaveBeenCalledTimes(1);
  });
});
```

The relative import path `../../../../../test-utils/vitest.setup` is correct from `src/pages/content/components/Demo/app.test.tsx` (five `..` to reach the repo root, then into `test-utils/`).

- [ ] **Step 7: Run the test — it should pass**

Run: `npm test`

Expected: 1 test in 1 file passes.

```
✓ src/pages/content/components/Demo/app.test.tsx (1)
  ✓ App message listener stability
    ✓ registers exactly once and does not re-register when shown toggles

Test Files  1 passed (1)
     Tests  1 passed (1)
```

If the test fails: read the failure carefully. Possible legitimate failures and what they mean:
- "chrome is not defined" → setup file is not running. Verify `setupFiles` path in vite.config.ts and that the test-utils path is correct.
- "Cannot find module '../../../../../test-utils/vitest.setup'" → path drift. Recount the `..` levels.
- jest-dom matcher unknown (`toHaveClass is not a function`) → jest-dom import in setup file is not augmenting the right `expect`. Confirm the import is `@testing-library/jest-dom/vitest` (the `/vitest` subpath, not the bare package).

- [ ] **Step 8: Sanity-check — deliberately break the impl, confirm the test fails on the right thing, then revert**

This step proves the test discriminates the invariant we care about (call count 1) and not just panel-class-toggle behavior.

In [src/pages/content/components/Demo/app.tsx:50](../../../src/pages/content/components/Demo/app.tsx#L50), temporarily change the second `useEffect`'s dependency array from empty to `[shown]`:

```tsx
  useEffect(() => {
    console.log("content view loaded");

    chrome.runtime.onMessage.addListener(messageListener);

    return () => {
      chrome.runtime.onMessage.removeListener(messageListener);
    };
  }, [shown]); // <-- DELIBERATELY UNSTABLE
```

Run: `npm test`

Expected: the test fails on the **final** assertion — `expected to have been called 1 times, but got called 3 times` (or similar). The intermediate panel-class assertions still pass because the panel toggling itself isn't broken; only the listener-stability invariant is.

If the test fails on a different assertion (e.g., the panel-class one), the test is conflating two checks — go back to Step 6 and tighten before reverting.

If the test passes despite the deliberate break — that means the test isn't actually checking what we think. Stop and rework the test before continuing.

After the failure-on-the-right-thing is confirmed, **revert the change manually** by editing [src/pages/content/components/Demo/app.tsx:50](../../../src/pages/content/components/Demo/app.tsx#L50) and changing the dependency array back to `[]`:

```tsx
  }, []); // Empty dependency array - only runs on mount/unmount
```

Then verify the file is exactly as it was before the deliberate break:

```bash
git diff src/pages/content/components/Demo/app.tsx
```
Expected: no output. (If anything other than the dep array shows up, the manual revert missed something — fix before continuing.)

Run `npm test` again to confirm we're back to passing.

(Why not `git checkout -- <path>`: that command is destructive in the general case — it would also wipe any unrelated uncommitted edits to the same file. The two-line manual edit + `git diff` confirmation is safer and more legible to a reviewer.)

- [ ] **Step 9: Append `npm test` step to `build-zip.yml`**

In [.github/workflows/build-zip.yml](../../../.github/workflows/build-zip.yml) the steps block currently ends:

```yaml
      - run: npm ci

      - run: npm run build

      - uses: actions/upload-artifact@v4
        with:
          path: dist/*
```

Insert a `npm test` step between `npm run build` and `upload-artifact`:

```yaml
      - run: npm ci

      - run: npm run build

      - run: npm test

      - uses: actions/upload-artifact@v4
        with:
          path: dist/*
```

Why test runs *after* build, not before: the build proves the code compiles (TS-noEmit + Vite). If the build is broken, the test results are noise. Run them in order; CI fails fast on whichever step trips first.

- [ ] **Step 10: Verify YAML syntactically**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/build-zip.yml'))"`
Expected: no output.

- [ ] **Step 11: Final local verification — build and test together**

Run:
```bash
npm run build
npm test
```

Both must exit 0. The build assertion: `dist/manifest.json` shape diff against `/tmp/baseline-manifest.json` (from Task 1 Step 1) is still empty modulo the rotating `<KEY>`:

```bash
diff <(jq -S 'del(.content_scripts[].css)' /tmp/baseline-manifest.json) \
     <(jq -S 'del(.content_scripts[].css)' dist/manifest.json)
```
Expected: empty.

- [ ] **Step 12: Stage and commit**

```bash
git add package.json package-lock.json \
        vite.config.ts tsconfig.json \
        test-utils/vitest.setup.ts \
        src/pages/content/components/Demo/app.test.tsx \
        .github/workflows/build-zip.yml
git status   # confirm only intended files are staged
git commit -m "$(cat <<'EOF'
Add Vitest 4 with first test for message-listener stability

Brings up the test runner on the Vite 6 / Node 22 baseline established
in the previous commits. The first test pins the message-listener
stability invariant from CLAUDE.md core rule #6: the listener registers
exactly once and is not re-registered when the panel's shown state
toggles. This also seeds the chrome-runtime mock (addListener +
removeListener spies) that cycle ③ will extend for postMessage / port
tests.

Added devDeps: vitest@^4, jsdom, @testing-library/react@^16,
@testing-library/jest-dom@^6.5. Added scripts: "test", "test:watch".

CI: build-zip.yml runs `npm test` after `npm run build`, so the test
gates merges.

No coverage tooling — one test does not justify a coverage reporter.
EOF
)"
```

---

## Final verification (after all three commits)

Run these once at the end:

- [ ] `npm run build` — exits 0
- [ ] `npm test` — exits 0, 1 test passes
- [ ] `git log --oneline -5` — shows the three upgrade commits + the cycle ① cleanup commits
- [ ] Manifest shape comparison still empty:
  ```bash
  diff <(jq -S 'del(.content_scripts[].css)' /tmp/baseline-manifest.json) \
       <(jq -S 'del(.content_scripts[].css)' dist/manifest.json)
  ```
- [ ] Load `dist/` as unpacked at `chrome://extensions` on a real page; click action icon → sliding panel opens with `commentarium.app/comments?url=…` iframe; SPA navigation triggers iframe URL update on the open panel — behavior identical to pre-upgrade
- [ ] PR CI runs both `npm run build` and `npm test` on Node 22 and both pass
- [ ] `cat package.json | jq -r .engines.node` → `>=22`
- [ ] `cat package.json | jq -r '.devDependencies | keys[]'` includes `vitest`, `jsdom`, `@testing-library/react`, `@testing-library/jest-dom`; does **not** include `jest`, `ts-jest`, `jest-environment-jsdom`, `@types/jest` (those were removed in cycle ①)
