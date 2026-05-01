# Baseline cleanup design

**Date:** 2026-05-02
**Status:** Approved (pending spec review)

## Context

This repo is on an old version of [chrome-extension-boilerplate-react-vite](https://github.com/Jonghakseo/chrome-extension-boilerplate-react-vite) (npm + React 18 + Vite 3 + Node 18). The latest upstream (`v0.5.0`) is a pnpm/turbo monorepo with React 19 / Vite 6 / Node ≥22 and 9 page workspaces.

We considered a full migration to the new boilerplate. Decision (after Codex review): **don't**. Custom surface is ~150 lines (background, sliding panel, iframe wrapper) and the new boilerplate's 3000+ lines of scaffolding bring scope, permission warnings, and dependency churn far in excess of any value for this extension. Future updates will be **incremental** to the current structure.

This spec covers the smallest sensible first step: clean up a broken baseline so subsequent dependency upgrades have honest CI signal and no dead code in the way.

**Sequencing.** Substantive auth work is on the way — the companion app (`commentarium`) needs the extension to act as an auth broker for partitioned-cookie iframe login, which is the kind of code that needs real test coverage. Planned order: ① baseline cleanup (this spec) → ② Vite/Vitest upgrade → ③ auth broker work. Cleaning first means later upgrades land on a single-package-manager, no-dead-code baseline.

## Scope

Five small, independent changes. Each commits separately.

### 1. Fix SVG attribute in header

[`src/pages/content/components/Demo/header.tsx`](../../../src/pages/content/components/Demo/header.tsx) uses `fill-rule="evenodd"` on a `<path>`. JSX requires camelCase for SVG attributes — this throws a React dev-mode warning on every render of the close button.

**Change:** `fill-rule` → `fillRule`. (`fill="#000000"` is already correct since `fill` is a single word.)

No behavior change. The kebab form happens to work in the rendered DOM but logs a console warning under React 18+.

### 2. Remove broken test infrastructure

**Current state:** [`app.test.tsx`](../../../src/pages/content/components/Demo/app.test.tsx) renders `<App />` without a `chrome` mock — `App` calls `chrome.runtime.onMessage.addListener` in `useEffect`, which throws `chrome is not defined` under jsdom. The assertion (`screen.getByText("content view")`) targets a string that doesn't exist in the rendered DOM. The test would fail on both counts if anyone actually ran it. CI runs it (`yarn test`) but presumably has been failing or never had the test exercised meaningfully.

**Why remove rather than fix:** the test would need to be rewritten from scratch (mock + new assertions). Doing that against jest, only to migrate to vitest in the next cycle (when vite is upgraded — vitest 1.x+ requires vite ≥5), is double work. Keeping a placeholder zero-coverage test isn't worth the dependency surface.

**Deletions:**
- [`src/pages/content/components/Demo/app.test.tsx`](../../../src/pages/content/components/Demo/app.test.tsx)
- [`jest.config.js`](../../../jest.config.js)
- [`test-utils/`](../../../test-utils/) (only contains `jest.setup.js`, dead with jest)
- [`.github/workflows/test.yml`](../../../.github/workflows/test.yml) — workflow has nothing to run after jest removal. CI build coverage stays via `build-zip.yml`.

**`package.json`:**
- Remove `"test": "jest"` from `scripts`
- Remove from `devDependencies`: `jest`, `ts-jest`, `jest-environment-jsdom`, `@types/jest`, `@testing-library/react`

**Followup for next cycle:** vitest will be introduced together with the vite 3→5/6 upgrade. The first real test will be written against vitest at that point.

### 3. Consolidate on a single package manager (npm)

**Current state:** the repo has both `package-lock.json` and `yarn.lock`. The `package.json` `scripts` section uses npm-style invocations (`run-p`, `npm-run-all`), and CI uses yarn — which is internally inconsistent (e.g. `build-zip.yml` caches `package-lock.json` but installs with `yarn`).

**Decision:** standardize on **npm**. This matches `package.json` and avoids tooling drift. (We're explicitly not adopting pnpm — that comes only if we ever fully migrate to the new boilerplate.)

**Changes:**
- Delete [`yarn.lock`](../../../yarn.lock)
- [`.github/workflows/build-zip.yml`](../../../.github/workflows/build-zip.yml):
  - `cache: 'yarn'` → `cache: 'npm'`
  - `yarn install` → `npm ci`
  - `yarn build` → `npm run build`
- Verify no other yarn references in the repo (`.gitignore`, README, etc.)

### 4. Remove dead options/ stub

**Current state:** [`src/pages/options/`](../../../src/pages/options/) (4 files: `index.tsx`, `index.css`, `Options.tsx`, `Options.css`) renders a stub page that says "Options". It is **not** registered in [`manifest.ts`](../../../manifest.ts) (no `options_page` / `options_ui`) and **not** included in [`vite.config.ts`](../../../vite.config.ts)'s rollup input map (the corresponding line is commented out: `//options: resolve(...)`). This is dead code carried over from the boilerplate.

**Decision:** delete it. If we ever need an options page, re-adding the boilerplate scaffolding for it is trivial.

**Changes:**
- Delete [`src/pages/options/`](../../../src/pages/options/) (entire directory)
- Remove the commented-out `//options:` line from [`vite.config.ts`](../../../vite.config.ts) rollup input map
- Update [`CLAUDE.md`](../../../CLAUDE.md) "Common pitfalls" — remove the "options page is wired in source but not in manifest" bullet
- Update [`docs/architecture.md`](../../architecture.md) "Three entry points" table — remove the options row

### 5. Update docs/development.md "Tests" section

**Current state:** the section describes the placeholder test and recommends "fix this test first." After this cleanup that recommendation is stale.

**Change:** rewrite the section to: "No tests currently. Vitest will be introduced together with the planned vite upgrade — first real test will be written against vitest."

## Non-scope (explicit deferrals)

- React 18 → 19, Vite 3 → 5/6, TypeScript 4.8 → 5.x, Node 18 → 22 — separate cycles.
- Jest → Vitest migration — bundled with the vite upgrade (vitest 1.x+ requires vite ≥5).
- Shadow DOM content-ui pattern from new boilerplate — backport only if/when CSS conflicts are observed.
- ESLint 8 → 9 flat config, Prettier 2 → 3 — separate cycle.
- Permission/manifest changes — none. `activeTab` stays the only permission.
- Full pnpm/turbo monorepo migration — declined.

## Verification

After each commit:
- `npm run build` — passes (currently passes; this scope shouldn't change that)
- Built `dist/manifest.json` is byte-identical before and after the entire cleanup (no manifest input changes)
- `dist/` content shape (entry files, asset filenames) unchanged

After the lockfile change specifically:
- Local `npm ci` succeeds from a clean `node_modules`
- `build-zip.yml` GitHub Actions run succeeds on the PR

After all changes:
- `git ls-files | grep -i 'jest\|yarn\|options'` returns nothing unexpected
- `npm run dev` still produces a working extension under `chrome://extensions` "Load unpacked"

## Risks / open questions

- **CI cache key drift.** `build-zip.yml` already keys its `node_modules` cache on `**/package-lock.json` even though it currently installs with yarn — internally inconsistent today. The cache key is already correct for our target state (npm), so it can stay as-is through the yarn→npm switch.

## Out-of-band notes captured during brainstorming

- The `chrome.tabs.onUpdated` listener in `background/index.ts` reads `changeInfo.url`. With only `activeTab`, this field is populated only after the user has invoked the extension on that tab (`activeTab` grant). This works in practice for our flow (user clicks icon → activeTab grant → subsequent SPA navigations on that tab fire `urlChange`), but is worth a comment in code at some point. Not in scope here.
