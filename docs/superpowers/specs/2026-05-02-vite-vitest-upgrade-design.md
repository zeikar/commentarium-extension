# Vite/Vitest upgrade design

**Date:** 2026-05-02
**Status:** Approved (pending spec review)

## Context

This is cycle ② of the three-cycle plan stated in
[2026-05-02-baseline-cleanup-design.md](2026-05-02-baseline-cleanup-design.md):
① baseline cleanup (done) → ② Vite/Vitest upgrade (this spec) → ③ auth broker work
(driven by `commentarium/docs/review.md` #1, third-party cookie partitioning).

Cycle ① left the repo on Vite 3.1.3 / TypeScript 4.8 / React 18.2 / npm-only with no
test runner — Jest was removed because Vitest 1.x+ requires Vite ≥ 5, so the runner
migration is naturally bundled with this dependency cycle.

This cycle does the dependency lift in a single coordinated push: Vite 6 + plugin-react
4 + TypeScript 5 + Node 22 + Rollup 4 (for the HMR build), then introduces Vitest 4
with the first real test as a seed for cycle ③ (where postMessage origin verification
will need real coverage).

**Why Vite 6 specifically (vs. chasing the latest):** as of 2026-05 the Vite line has
already moved past 6, but cycle ③ (auth broker) is the work that actually matters.
Vite 6 is the lowest-risk baseline that (a) unblocks Vitest ≥ 4, (b) puts the project
on a Rollup 4 + TypeScript 5 toolchain that won't need to move again before ③, and
(c) leaves the next forced upgrade far enough away to not re-enter dependency-bump mode
mid-③. "Latest" is not the goal; "stable enough to forget about for one substantive
feature cycle" is.

## Sequencing within the cycle

Three commits in order. Each must build green before the next.

1. **Vite 6 + TS 5 + Node 22 toolchain bump** — dependency versions, any minimal
   build-time fixes the upgrade forces, no test runner yet.
2. **CI Node 22** — single workflow change. (Test job is added in commit 3 after the
   runner exists.)
3. **Vitest 4 + first test + CI test job** — runner config, setup file, one test for
   the message listener stability invariant in
   [`Demo/app.tsx`](../../../src/pages/content/components/Demo/app.tsx), plus an
   `npm test` step appended to [`build-zip.yml`](../../../.github/workflows/build-zip.yml)
   so the new test actually gates CI.

git-bisect friendliness is the reason for the split: if a regression appears later,
`git bisect` lands on whichever of the three commits broke it.

## Scope

### 1. Vite 6 + TypeScript 5 + Node 22 + Rollup 4

**Dependency changes** (`package.json`):

| Package | Current | Target |
|---|---|---|
| `vite` | `3.1.3` | `^6.0.0` |
| `@vitejs/plugin-react` | `2.2.0` | `^4.3.0` |
| `typescript` | `4.8.3` | `^5.6.0` |
| `@types/node` | `18.15.11` | `^22.0.0` |
| `@types/chrome` | `0.0.224` | latest |
| `rollup` | `2.79.1` | `^4.20.0` |
| `@rollup/plugin-typescript` | `^8.5.0` | `^12.0.0` |

Add to `package.json`:

```json
"engines": { "node": ">=22" }
```

Node 20 reached EOL on 2026-04-30; Node 22 is the active LTS. The package floor and the
CI runner version match — no point allowing 20 in `engines` while CI runs 22.

**Why Vite 6 (not 5):** the custom Vite plugins under [`utils/plugins/`](../../../utils/plugins/)
use only stable Rollup hooks (`buildStart`, `buildEnd`, `renderDynamicImport`,
`resolveId`, `load`) and the `PluginOption` type. None of these change between Vite 5
and Vite 6 in ways that affect us, so the cost difference between targeting 5 vs 6 is
near zero. Targeting 6 means the next forced upgrade is further away.

**Why React stays on the 18.x line:** scope discipline. React 19 brings its own
behavioral changes (StrictMode double-render semantics, ref-as-prop, Actions) that
would compound the verification surface for what is otherwise a pure tooling cycle.
The current pin (18.2.0) stays as-is; bumping inside the 18 line is also out of scope
unless something forces it. React 19 is a candidate for cycle ③ or a separate cycle.

**Why Rollup 4 / `@rollup/plugin-typescript` 12 alongside the Vite bump:** the HMR
build under [`utils/reload/rollup.config.ts`](../../../utils/reload/rollup.config.ts) is
independent of Vite, but it imports `@rollup/plugin-typescript`, which needs the
matching Rollup major to play with TypeScript 5.x. Bundling these into the same commit
keeps the toolchain coherent — splitting them would land an inconsistent intermediate
state.

**Code changes expected:** minimal. The plugin code is small and uses generic Rollup
APIs. Anticipated touch points:

- `tsc --noEmit` may surface new strict errors under TS 5.x; fix in place.
- `vite.config.ts` may need import-form adjustments (e.g., `defineConfig` typing) — none
  expected, but bundled with this commit if any appear.
- The HMR injection compile under Rollup 4 may need a config tweak (e.g., explicit
  `output.format`) — not expected based on current config, but bundled here if so.

**Plugin-compat fallback (recorded, not a separate task):**

If the Vite 6 + Rollup 4 build trips one of the three custom plugins, the spec-level
response is:

1. Adjust the plugin in place (signature drift on `renderDynamicImport`, etc.) and keep
   it. This is the expected path.
2. If a plugin's behavior is no longer reachable from the new build pipeline (e.g.,
   `customDynamicImport` becomes a no-op because content-script chunking changed),
   document the observation in this commit's message but **do not delete the plugin in
   this cycle** — that is a separate decision and out of scope here.

### 2. CI Node 22

[`.github/workflows/build-zip.yml`](../../../.github/workflows/build-zip.yml): set
`node-version: 22` on the `setup-node` step. No other workflow changes in this commit —
the test step is added in commit 3 once Vitest exists. Lint workflow is untouched
because ESLint 9 is out of scope for this cycle.

### 3. Vitest 4 + first test + CI test job

**Dependency additions:**

- `vitest` `^4.0.0` — Vitest 4 requires Vite ≥ 6 and Node ≥ 20, which matches the
  baseline this cycle establishes. Vitest 2 would be a deliberate downshift with no
  upside given our floor; Vitest 4 is the version that aligns with the rest of the
  toolchain.
- `jsdom` (compatible with Vitest 4 — version pinned during implementation)
- `@testing-library/react` `^16.0.0` (React 18 compatible)
- `@testing-library/jest-dom` `^6.5.0`

No `@vitest/coverage-v8` — coverage tooling is not introduced with one test.

**Vitest config:** added inline to [`vite.config.ts`](../../../vite.config.ts) via the
Vitest-aware reference directive at the top of the file:

```ts
/// <reference types="vitest" />
```

and a `test` block:

```ts
test: {
  environment: "jsdom",
  globals: false,
  setupFiles: ["./test-utils/vitest.setup.ts"],
}
```

`globals: false` — tests use explicit imports (`import { describe, it, expect, vi }
from "vitest"`). Keeps test files self-documenting and avoids polluting the global
namespace with test-only identifiers.

No separate `vitest.config.ts`. Vitest picks up `vite.config.ts` automatically when the
`test` block is present.

**`test-utils/vitest.setup.ts`** (new file, replaces the empty directory `test-utils/`
left after cycle ①'s `jest.setup.js` deletion):

- Imports `vi` from `vitest` and `@testing-library/jest-dom/vitest` to install DOM
  matchers.
- Defines a minimal `chrome.runtime.onMessage` global mock exposing both `addListener`
  and `removeListener` as `vi.fn()` spies. The mock keeps a captured-listeners array so
  tests can dispatch synthetic messages by invoking the captured listener directly.
- Resets the spies and clears the captured-listeners array in a `beforeEach` (or
  exported `resetChromeMock()` helper called from each test's `beforeEach`) so that
  RTL `cleanup()` between tests doesn't leak `addListener` call counts across cases.

The `removeListener` spy matters because [`Demo/app.tsx`](../../../src/pages/content/components/Demo/app.tsx)'s
effect cleanup calls it on unmount — without the spy, RTL `cleanup()` after each test
would throw under the bare global. This is the seed of the chrome-mocking pattern that
cycle ③ will extend for postMessage / port-message tests.

**`package.json` scripts:**

```json
"test": "vitest run",
"test:watch": "vitest"
```

**First test** — [`src/pages/content/components/Demo/app.test.tsx`](../../../src/pages/content/components/Demo/app.test.tsx):

Target invariant: the `chrome.runtime.onMessage` listener registered by
[`Demo/app.tsx`](../../../src/pages/content/components/Demo/app.tsx) registers exactly
once and does not re-register when `shown` toggles. This invariant is recorded in
[CLAUDE.md](../../../CLAUDE.md) core rule #6 and is the pattern most likely to regress
under future React or component-shape changes.

Test outline (final shape decided in implementation):

1. Install the chrome mock via the setup file; reset spies/captured listeners.
2. Mount `<App />`. Assert `chrome.runtime.onMessage.addListener` was called once and
   capture the listener.
3. Dispatch `{ type: "toggle", url: "https://example.com/" }` through the captured
   listener. Assert the panel becomes visible.
4. Dispatch the same message a second time. Assert the panel hides.
5. Re-assert `addListener.callCount === 1` after both dispatches — the listener was
   not re-registered when `shown` toggled.

The dispatched messages carry a real `url` because the production message contract is
`{ type, url }` and feeding `undefined` would coincidentally still pass the listener
test today, but couples the test to a current quirk rather than the real protocol.

What this test does *not* cover (deliberately): SPA `urlChange` propagation through to
the iframe, iframe lifecycle, network behavior. Those wait for cycle ③ when there is
real iframe-broker code worth testing.

**`build-zip.yml` test step:** append after the existing `npm run build` step:

```yaml
- run: npm test
```

This is the change that turns "first real test" into actual CI signal — without it the
test exists only locally. The step is added in commit 3 (not commit 2) because adding
it before Vitest is installed would break CI.

## Verification

After commit 1:
- `npm run build` exits 0
- `dist/manifest.json` content unchanged from cycle ① baseline (only the rotating
  `<KEY>` hash on the contentStyle CSS asset name differs — that is by design)
- `npm run dev` produces a working unpacked extension; load in `chrome://extensions`
  and verify the panel toggles on click and reloads on SPA URL change

After commit 2:
- PR CI green on Node 22 (build-only step)

After commit 3:
- `npm test` passes locally with 1 test
- `npm run build` still passes (Vitest is dev-only)
- `dist/manifest.json` still byte-identical (modulo the rotating CSS hash)
- PR CI green: build step **and** test step both run and pass on Node 22

## Risks / open questions

- **Rollup 4 + `@rollup/plugin-typescript` 12 on the HMR config.** Low risk — the HMR
  rollup config is 28 lines and emits trivial CommonJS-shape JS. If it trips, fix is
  expected to be a one-line `output.format` or a CJS-vs-ESM toggle, not a rewrite.
- **`customDynamicImport` plugin.** The hook signature `renderDynamicImport({ left,
  right })` is a Rollup core hook and is preserved through Rollup 4. The escape-from-ESM
  trick (wrapping `import()` in an IIFE so the content script — which is loaded as a
  classic script, not a module — can still resolve it) remains valid.
- **TS 5 strict regressions.** TS 5.x has tightened a few inference paths since 4.8.
  Expected to be 0–2 small fixes. Bundled into commit 1.
- **`@types/chrome` drift.** Going to "latest" may surface API-shape changes (e.g.,
  `chrome.runtime` typings). If that produces type errors, scope of fix is "satisfy the
  new types," not "rewrite usage."
- **No coverage tooling.** Acceptable for now — one test does not justify a coverage
  reporter. Reconsidered when cycle ③ adds the auth broker test suite.

## Non-scope (explicit deferrals)

- **React 18 → 19** — separate cycle. 18.x is the current stable line for React;
  staying there for one more cycle is fine.
- **ESLint 8 → 9 flat config + typescript-eslint 8** — separate cycle. Orthogonal to
  the build/runtime path.
- **Prettier 2 → 3** — separate cycle.
- **Auth broker / postMessage origin verification** — cycle ③.
- **Coverage reporting (`@vitest/coverage-v8`)** — defer until there is more than one
  test.
- **Permission / manifest changes** — none.
- **pnpm / monorepo migration** — declined permanently per cycle ①.
- **Replacing the custom Vite plugins with off-the-shelf alternatives or built-in
  options** — not in this cycle. The plugins are small and work; rewriting them is a
  separable concern.

## Out-of-band notes captured during brainstorming

- **`engines: ">=22"` matches the CI runner.** Earlier draft of this spec set `>=20`
  to be permissive, but as of 2026-05 Node 20 is EOL and CI is on 22 — letting `engines`
  advertise 20 is just stale signal. Floor and runner match.
- **Vitest config lives inside `vite.config.ts`, not a separate `vitest.config.ts`.**
  The Vite team supports both; one file is simpler for a project this small. Move only
  if the configs ever diverge meaningfully (they won't, here).
- **First test deliberately avoids iframe / SPA-URL behavior.** That code is about to
  change in cycle ③ (auth broker), so a test written against today's iframe lifecycle
  would be churn. The listener-stability test targets a stable invariant that is
  unlikely to change shape regardless of where cycle ③ lands.
