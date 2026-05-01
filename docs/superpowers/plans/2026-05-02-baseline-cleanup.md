# Baseline Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clean up the broken baseline so subsequent dependency upgrades have honest CI signal and no dead code in the way — without expanding scope into a full boilerplate migration.

**Architecture:** Five independent mechanical changes, each producing one self-contained commit. No production code paths change. No new tests are added (Vitest comes with the future Vite upgrade).

**Tech Stack:** TypeScript, React 18, Vite 3, Chrome Extension Manifest V3, npm, GitHub Actions.

**Spec:** [docs/superpowers/specs/2026-05-02-baseline-cleanup-design.md](../specs/2026-05-02-baseline-cleanup-design.md)

---

## File Structure

Files this plan touches:

| File | Operation | Task |
|---|---|---|
| `src/pages/content/components/Demo/header.tsx` | modify (1 attribute) | Task 1 |
| `src/pages/content/components/Demo/app.test.tsx` | delete | Task 2 |
| `jest.config.js` | delete | Task 2 |
| `test-utils/jest.setup.js` | delete | Task 2 |
| `test-utils/` | delete (empty after above) | Task 2 |
| `.github/workflows/test.yml` | delete | Task 2 |
| `package.json` | modify (remove script + 5 devDeps) | Task 2 |
| `package-lock.json` | regenerated | Task 2 |
| `yarn.lock` | delete | Task 3 |
| `.github/workflows/build-zip.yml` | modify (yarn → npm) | Task 3 |
| `src/pages/options/` | delete (4 files) | Task 4 |
| `vite.config.ts` | modify (remove 1 commented line) | Task 4 |
| `CLAUDE.md` | modify (remove 1 bullet, fix npm test refs) | Task 5 |
| `docs/architecture.md` | modify (remove options refs, fix file map) | Task 5 |
| `docs/development.md` | modify (rewrite Tests section, drop npm test row) | Task 5 |

No file is touched by more than one task.

## Note on TDD

This plan removes broken tests and dead code. There is no new behavior to test-drive. Verification for each task is **build-based**: `npm run build` must continue to pass, and the built `dist/manifest.json` and entry-file shape must not change. The first new test will be written in the future Vitest cycle, not here.

---

### Task 1: Fix SVG `fillRule` JSX attribute

**Why:** `<path fill-rule="evenodd">` in [src/pages/content/components/Demo/header.tsx](../../../src/pages/content/components/Demo/header.tsx) uses the kebab-case form. JSX requires camelCase for SVG attributes — React 18 logs a dev-mode warning every time the close button mounts. The DOM still renders correctly; this only silences the warning.

**Files:**
- Modify: `src/pages/content/components/Demo/header.tsx:14`

- [ ] **Step 1: Read the file to confirm current state**

Run: `grep -n 'fill-rule' src/pages/content/components/Demo/header.tsx`
Expected: line 14 contains `fill-rule="evenodd"`

- [ ] **Step 2: Apply the edit**

In [src/pages/content/components/Demo/header.tsx](../../../src/pages/content/components/Demo/header.tsx), change:

```tsx
            fill="#000000"
            fill-rule="evenodd"
            d="M2.293 15.293a1 1 0 101.414 1.414l6-6a1 1 0 000-1.414l-6-6a1 1 0 00-1.414 1.414L7.586 10l-5.293 5.293zm8 0a1 1 0 101.414 1.414l6-6a1 1 0 000-1.414l-6-6a1 1 0 10-1.414 1.414L15.586 10l-5.293 5.293z"
```

to:

```tsx
            fill="#000000"
            fillRule="evenodd"
            d="M2.293 15.293a1 1 0 101.414 1.414l6-6a1 1 0 000-1.414l-6-6a1 1 0 00-1.414 1.414L7.586 10l-5.293 5.293zm8 0a1 1 0 101.414 1.414l6-6a1 1 0 000-1.414l-6-6a1 1 0 10-1.414 1.414L15.586 10l-5.293 5.293z"
```

(The only character change is `fill-rule` → `fillRule`.)

- [ ] **Step 3: Verify build passes**

Run: `npm run build`
Expected: exits 0. `tsc --noEmit` passes, `vite build` produces `dist/`.

- [ ] **Step 4: Verify the dev-mode warning is gone**

Run: `grep -n 'fill-rule\|fillRule' src/pages/content/components/Demo/header.tsx`
Expected: one line containing `fillRule="evenodd"`. No `fill-rule` matches.

- [ ] **Step 5: Commit**

```bash
git add src/pages/content/components/Demo/header.tsx
git commit -m "Fix SVG fillRule JSX attribute in close button"
```

---

### Task 2: Remove broken test infrastructure

**Why:** The single test ([app.test.tsx](../../../src/pages/content/components/Demo/app.test.tsx)) cannot pass — it renders `<App />` without a `chrome` mock (the component calls `chrome.runtime.onMessage.addListener` on mount, which throws under jsdom), and asserts a string (`"content view"`) that doesn't appear in the rendered DOM. Rewriting against jest only to migrate to vitest in the next cycle is double work. Vitest enters with the future vite ≥5 upgrade. Until then: no tests, no jest, no test CI workflow.

**Files:**
- Delete: `src/pages/content/components/Demo/app.test.tsx`
- Delete: `jest.config.js`
- Delete: `test-utils/jest.setup.js`
- Delete: `test-utils/` (directory becomes empty)
- Delete: `.github/workflows/test.yml`
- Modify: `package.json` (remove `"test": "jest"` script + 5 devDependencies)
- Regenerated: `package-lock.json`

- [ ] **Step 1: Delete the test file and jest config**

Run:
```bash
rm src/pages/content/components/Demo/app.test.tsx
rm jest.config.js
rm -r test-utils
rm .github/workflows/test.yml
```

- [ ] **Step 2: Verify deletions**

Run:
```bash
test ! -e src/pages/content/components/Demo/app.test.tsx && \
test ! -e jest.config.js && \
test ! -e test-utils && \
test ! -e .github/workflows/test.yml && \
echo "all deleted"
```
Expected: prints `all deleted`. (If any of the four paths still exists, the command exits non-zero with no output.)

- [ ] **Step 3: Remove jest-related devDependencies via npm**

Run:
```bash
npm uninstall jest ts-jest jest-environment-jsdom @types/jest @testing-library/react
```
Expected: succeeds. `package.json` and `package-lock.json` are both updated. `node_modules` shrinks.

- [ ] **Step 4: Remove the `test` script from `package.json`**

In [package.json](../../../package.json), the `scripts` block currently reads:

```json
  "scripts": {
    "build": "tsc --noEmit && vite build",
    "build:watch": "cross-env __DEV__=true vite build --watch",
    "build:hmr": "rollup --config utils/reload/rollup.config.ts",
    "wss": "node utils/reload/initReloadServer.js",
    "dev": "npm run build:hmr && (run-p wss build:watch)",
    "test": "jest"
  },
```

Change to:

```json
  "scripts": {
    "build": "tsc --noEmit && vite build",
    "build:watch": "cross-env __DEV__=true vite build --watch",
    "build:hmr": "rollup --config utils/reload/rollup.config.ts",
    "wss": "node utils/reload/initReloadServer.js",
    "dev": "npm run build:hmr && (run-p wss build:watch)"
  },
```

(Remove the `"test": "jest"` line and the trailing comma on the `dev` line.)

- [ ] **Step 5: Verify package.json is clean**

Run: `grep -E '"test"|jest|testing-library' package.json`
Expected: no output.

- [ ] **Step 6: Verify build still passes**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Remove broken jest test infrastructure

The single smoke test could never pass: it rendered <App/> without a
chrome.runtime mock and asserted a string the component never renders.
Vitest will be introduced together with the planned Vite upgrade
(Vitest 1.x+ requires Vite >=5).

Deleted:
- src/pages/content/components/Demo/app.test.tsx
- jest.config.js, test-utils/
- .github/workflows/test.yml (nothing to run; build-zip.yml retains CI build coverage)

Removed devDeps: jest, ts-jest, jest-environment-jsdom, @types/jest,
@testing-library/react. Removed npm script: "test".
EOF
)"
```

---

### Task 3: Switch CI from yarn to npm and delete `yarn.lock`

**Why:** Both lockfiles exist; `package.json` scripts are npm-style (`run-p`, `npm-run-all`); CI uses yarn but caches its `node_modules` keyed on `package-lock.json` — internally inconsistent. Standardize on npm. (Adopting pnpm comes only with a full boilerplate migration, which we've declined.)

**Files:**
- Delete: `yarn.lock`
- Modify: `.github/workflows/build-zip.yml` (3 lines: cache key, install command, build command)

- [ ] **Step 1: Delete `yarn.lock`**

Run: `git rm yarn.lock`
Expected: `rm 'yarn.lock'`.

- [ ] **Step 2: Update `.github/workflows/build-zip.yml`**

Current file content:

```yaml
name: Build And Upload Extension Zip Via Artifact

on:
  push:
    branches: [ main ]
  pull_request:
  workflow_dispatch:

jobs:
  build:

    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          cache: 'yarn'

      - uses: actions/cache@v3
        with:
          path: node_modules
          key: ${{ runner.OS }}-build-${{ hashFiles('**/package-lock.json') }}

      - run: yarn install

      - run: yarn build

      - uses: actions/upload-artifact@v4
        with:
          path: dist/*
```

Change three lines:

| Old | New |
|---|---|
| `          cache: 'yarn'` | `          cache: 'npm'` |
| `      - run: yarn install` | `      - run: npm ci` |
| `      - run: yarn build` | `      - run: npm run build` |

Leave the `actions/cache@v3` block alone — its key already references `package-lock.json`, which is what we want.

- [ ] **Step 3: Verify no other yarn references remain**

Run: `grep -rn -i "yarn" .github/ README.md package.json 2>/dev/null`
Expected: no output. (We're not touching `node_modules/`.)

- [ ] **Step 4: Verify the package-lock.json is sufficient locally**

Run:
```bash
rm -rf node_modules
npm ci
npm run build
```
Expected: all three commands exit 0. Build produces `dist/`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Switch CI from yarn to npm; drop yarn.lock

package.json scripts are already npm-style (run-p, npm-run-all) and the
CI cache key already references package-lock.json — using yarn was the
inconsistent piece. Standardize on a single package manager.

(Adopting pnpm is deferred and only happens if we ever migrate to the
new boilerplate, which we've declined.)
EOF
)"
```

---

### Task 4: Remove dead `options/` stub

**Why:** [src/pages/options/](../../../src/pages/options/) renders a "Options" stub but is **not** registered in [manifest.ts](../../../manifest.ts) (no `options_page` / `options_ui`) and is **not** included in the rollup input map of [vite.config.ts](../../../vite.config.ts) (the line is commented out). It's dead code carried over from the boilerplate. Doc updates that reference it are handled in Task 5.

**Files:**
- Delete: `src/pages/options/index.tsx`
- Delete: `src/pages/options/index.css`
- Delete: `src/pages/options/Options.tsx`
- Delete: `src/pages/options/Options.css`
- Delete: `src/pages/options/` (directory becomes empty)
- Modify: `vite.config.ts:50` (remove commented `//options:` line)

- [ ] **Step 1: Delete the options/ directory**

Run: `rm -r src/pages/options`

- [ ] **Step 2: Verify deletion**

Run: `ls src/pages/`
Expected: only `background/` and `content/`.

- [ ] **Step 3: Remove the commented options input from vite.config.ts**

In [vite.config.ts](../../../vite.config.ts) lines 47-51 currently read:

```ts
      input: {
        content: resolve(pagesDir, "content", "index.ts"),
        background: resolve(pagesDir, "background", "index.ts"),
        contentStyle: resolve(pagesDir, "content", "style.scss"),
        //options: resolve(pagesDir, "options", "index.html"),
      },
```

Change to:

```ts
      input: {
        content: resolve(pagesDir, "content", "index.ts"),
        background: resolve(pagesDir, "background", "index.ts"),
        contentStyle: resolve(pagesDir, "content", "style.scss"),
      },
```

(Remove only the commented `//options:` line.)

- [ ] **Step 4: Verify build still passes**

Run: `npm run build`
Expected: exits 0.

- [ ] **Step 5: Verify no options entry in dist/**

Run: `find dist -path '*options*' 2>/dev/null`
Expected: no output.

- [ ] **Step 6: Verify no remaining source references to `pages/options`**

Run: `grep -rn "pages/options\|pages\\\\\\\\options\|src/pages/options" src/ utils/ vite.config.ts manifest.ts 2>/dev/null`
Expected: no output. (Doc references are intentional and handled in Task 5.)

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Remove dead options/ stub

src/pages/options/ was carried over from the boilerplate but never
registered in manifest.ts and excluded from vite.config.ts's rollup
input map (the line was commented out). Re-adding boilerplate options
scaffolding is trivial when an options page is actually needed.
EOF
)"
```

---

### Task 5: Sync docs after cleanup

**Why:** [CLAUDE.md](../../../CLAUDE.md), [docs/architecture.md](../../architecture.md), and [docs/development.md](../../development.md) currently describe the broken test, the options stub, and the `npm test` script — all gone after Tasks 2 and 4. Bring docs into sync.

**Files:**
- Modify: `CLAUDE.md` (remove options pitfall bullet, drop `npm test` line, fix section heading)
- Modify: `docs/architecture.md` (remove options row, fix file map, drop test mention)
- Modify: `docs/development.md` (drop `npm test` row, rewrite Tests section)

- [ ] **Step 1: Update CLAUDE.md — remove options pitfall**

In [CLAUDE.md](../../../CLAUDE.md), delete the bullet on line 30:

```markdown
- The options page is wired up in source ([src/pages/options/](src/pages/options/)) but **not registered in the manifest** — it's a stub left over from the boilerplate. If you actually need an options page, add `options_page` (or `options_ui`) to [manifest.ts](manifest.ts) and add the input back to [vite.config.ts](vite.config.ts) (currently commented out).
```

(Delete the entire bullet line. The two adjacent bullets stay.)

- [ ] **Step 2: Update CLAUDE.md — drop `npm test` from build block**

In [CLAUDE.md](../../../CLAUDE.md) the "Build / test" block currently reads:

```markdown
## Build / test

\`\`\`bash
npm install
npm run dev          # builds to dist/ in watch mode + reload server (load dist/ as unpacked)
npm run build        # tsc --noEmit && vite build
npm test             # jest (currently one smoke test for Demo/app)
\`\`\`
```

Change to:

```markdown
## Build / dev

\`\`\`bash
npm install
npm run dev          # builds to dist/ in watch mode + reload server (load dist/ as unpacked)
npm run build        # tsc --noEmit && vite build
\`\`\`
```

(Heading: `Build / test` → `Build / dev`. Drop the `npm test` line.)

- [ ] **Step 3: Update docs/architecture.md — remove options entry-points row**

In [docs/architecture.md](../../architecture.md) the "Three entry points" section is currently:

```markdown
## Three entry points

| Entry | File | Role |
|---|---|---|
| Background service worker | [src/pages/background/index.ts](../src/pages/background/index.ts) | Listens for the action icon click and tab URL changes; relays both as messages to the active tab's content script |
| Content script | [src/pages/content/index.ts](../src/pages/content/index.ts) | Mounts a React root in `document.body` (id `commentarium-content-view-root`) on every page |
| Options page | [src/pages/options/](../src/pages/options/) | Stub. Wired in source, **not** in the manifest — see CLAUDE.md "Common pitfalls" |
```

Change to:

```markdown
## Two entry points

| Entry | File | Role |
|---|---|---|
| Background service worker | [src/pages/background/index.ts](../src/pages/background/index.ts) | Listens for the action icon click and tab URL changes; relays both as messages to the active tab's content script |
| Content script | [src/pages/content/index.ts](../src/pages/content/index.ts) | Mounts a React root in `document.body` (id `commentarium-content-view-root`) on every page |
```

(Heading: `Three entry points` → `Two entry points`. Drop the Options row.)

- [ ] **Step 4: Update docs/architecture.md — fix file map**

Replace the entire file map block (lines 104-128) in [docs/architecture.md](../../architecture.md). The block boundaries are the two ` ``` ` fences. Use the Edit tool with the exact strings below.

**Old block (find this exact text):**

```
src/
├── pages/
│   ├── background/index.ts           # service worker — message dispatcher
│   ├── content/
│   │   ├── index.ts                  # entry: mounts React root, dynamic-imports Demo
│   │   ├── style.scss                # panel styles (slide animation, layout)
│   │   └── components/
│   │       ├── Demo/
│   │       │   ├── app.tsx           # panel state + message listener
│   │       │   ├── header.tsx        # close button
│   │       │   ├── index.tsx         # createRoot bootstrap (called via dynamic import)
│   │       │   └── app.test.tsx      # smoke test
│   │       └── iframe/
│   │           ├── index.tsx         # iframe + loading wrapper
│   │           └── loading.tsx       # spinner
│   └── options/                      # stub — not registered in manifest
├── assets/style/theme.scss           # shared SCSS (currently a single placeholder rule)
└── global.d.ts                       # virtual:reload-on-update-* + asset module decls

manifest.ts                            # generated → dist/manifest.json by vite plugin
vite.config.ts                         # input map + custom plugins (manifest, HMR, dynamic-import)
utils/plugins/                         # boilerplate vite plugins — leave alone
utils/reload/                          # boilerplate HMR reload server — leave alone
```

**New block (replace with this exact text):**

```
src/
├── pages/
│   ├── background/index.ts           # service worker — message dispatcher
│   └── content/
│       ├── index.ts                  # entry: mounts React root, dynamic-imports Demo
│       ├── style.scss                # panel styles (slide animation, layout)
│       └── components/
│           ├── Demo/
│           │   ├── app.tsx           # panel state + message listener
│           │   ├── header.tsx        # close button
│           │   └── index.tsx         # createRoot bootstrap (called via dynamic import)
│           └── iframe/
│               ├── index.tsx         # iframe + loading wrapper
│               └── loading.tsx       # spinner
├── assets/style/theme.scss           # shared SCSS (currently a single placeholder rule)
└── global.d.ts                       # virtual:reload-on-update-* + asset module decls

manifest.ts                            # generated → dist/manifest.json by vite plugin
vite.config.ts                         # input map + custom plugins (manifest, HMR, dynamic-import)
utils/plugins/                         # boilerplate vite plugins — leave alone
utils/reload/                          # boilerplate HMR reload server — leave alone
```

**Three structural changes** (for understanding, all already encoded in the new block above):
1. `app.test.tsx` line removed from Demo/. The previous `index.tsx` connector changes from `├──` to `└──`.
2. `options/` line removed from pages/. The previous `content/` connector changes from `├──` to `└──`.
3. Because `content/` is now pages' last child, the leading `│  ` column under content's descendants becomes spaces — every descendant line shifts one tree-column.

- [ ] **Step 5: Update docs/development.md — drop `npm test` row**

In [docs/development.md](../../development.md) the Commands table includes:

```markdown
| `npm test` | `jest` — currently one smoke test for [Demo/app.tsx](../src/pages/content/components/Demo/app.test.tsx). |
```

Delete this row.

- [ ] **Step 6: Update docs/development.md — rewrite Tests section**

In [docs/development.md](../../development.md) the current Tests section reads:

```markdown
## Tests

\`\`\`bash
npm test
\`\`\`

`jest` + `@testing-library/react` + `jest-environment-jsdom`. There's currently one test ([Demo/app.test.tsx](../src/pages/content/components/Demo/app.test.tsx)) and it's a smoke test that's already failing semantically — it asserts the literal string `"content view"` appears in the rendered output, but the component doesn't render that text. **Treat the test suite as a placeholder**, not as coverage. If you start adding behavior worth covering, fix this test first.

There is no test for `chrome.runtime.onMessage` wiring — `chrome.*` is undefined under jsdom, and the boilerplate doesn't ship a mock. Use the dev-load-unpacked flow for any messaging-related verification.
```

Change to:

```markdown
## Tests

No tests currently. Vitest will be introduced together with the planned Vite upgrade — Vitest 1.x+ requires Vite ≥ 5, so the test runner migration is naturally bundled with that dependency cycle. The first real test will be written against Vitest at that point.

For now, verify behavior with the dev-load-unpacked flow: rebuild, reload the unpacked extension at `chrome://extensions`, exercise the panel on a real page.
```

- [ ] **Step 7: Final consistency check**

Run:
```bash
grep -rn -i "jest\|@testing-library\|app\.test\|pages/options\|src/pages/options\|npm test" CLAUDE.md docs/ 2>/dev/null
```
Expected: no output (or only matches inside `docs/superpowers/specs/2026-05-02-baseline-cleanup-design.md` and `docs/superpowers/plans/2026-05-02-baseline-cleanup.md` — those are the spec/plan themselves and should retain the historical context).

If there are matches outside the superpowers/ folder, fix them.

- [ ] **Step 8: Verify build still passes**

Run: `npm run build`
Expected: exits 0. (Docs don't affect the build, but a final sanity check costs nothing.)

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "Sync CLAUDE.md and docs after baseline cleanup"
```

---

## Final verification (after all five tasks)

Run these once at the end:

- [ ] `npm run build` — passes
- [ ] `git log --oneline -6` — shows 5 cleanup commits + the prior spec commit (`698ba66`)
- [ ] `find dist -name 'manifest.json' -exec cat {} \;` — manifest content shape unchanged from before the cleanup (no options entry, content+background entries identical)
- [ ] `git ls-files | grep -E 'jest|yarn|options'` — empty
- [ ] Load `dist/` as unpacked at `chrome://extensions`, click the action icon on any HTTPS page → sliding panel opens with `commentarium.app/comments?url=…` iframe (no behavior change vs. pre-cleanup)
