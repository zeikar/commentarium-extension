# Development

Build, load, iterate. The boilerplate handles most of this; the notes below are the parts you'll actually trip over.

## Setup

```bash
npm install
cp .env.example .env.local
# fill in real Firebase web SDK config + Chrome OAuth client_id, or
# use placeholder strings if you only need to verify build / test
```

`npm run build` calls `buildManifest(env)` from [manifest.ts](../manifest.ts), which throws if `VITE_GOOGLE_OAUTH_CLIENT_ID` is missing. The four `VITE_FIREBASE_*` keys are validated at SW startup by [firebase.ts](../src/pages/background/firebase.ts) — placeholder strings are fine for build/test, but real values are needed for the loaded extension to actually authenticate against `commentarium.app`. `.env.local` is gitignored; CI sets placeholders in [build-zip.yml](../.github/workflows/build-zip.yml).

Node 22 is required (`package.json` pins `engines.node = ">=22"`); CI runs on Node 22 to match.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Starts the HMR reload websocket server **and** runs `vite build --watch` with `__DEV__=true`. Output is `dist/`, rebuilt on every save. |
| `npm run build` | One-shot production build. Runs `tsc --noEmit` first, so type errors fail the build. |
| `npm run build:watch` | Watch-mode build only (no reload server). Rarely needed directly. |
| `npm run build:hmr` | Builds the HMR client bundle (`utils/reload/...`) once. `dev` runs this before starting the watcher. |
| `npm run wss` | Starts the HMR reload websocket server only. Useful if you want to point a separate watcher at it. |

## Loading the extension

1. `npm run dev` (or `npm run build`).
2. Chrome → `chrome://extensions` → enable **Developer mode**.
3. **Load unpacked** → select the `dist/` folder.
4. Pin the extension to the toolbar (puzzle-piece menu).
5. Click the icon on any page — the panel should slide in from the right with `commentarium.app/comments?url=…` loaded in the iframe.

## HMR — what reloads automatically vs. what doesn't

The boilerplate's reload system (under `utils/reload/`) covers most of the custom surface, but Chrome extensions have hard limits on what can hot-reload.

| Change | Reload behavior |
|---|---|
| Edit a content-script React component (e.g. `Demo/app.tsx`) | Auto-refresh: the page reloads and the new code mounts. |
| Edit `content/style.scss` | Auto-reload — but the CSS filename is fingerprinted (`contentStyle<KEY>.chunk.css`), so the manifest is also rebuilt and the extension reloads. |
| Edit `background/index.ts` | The service worker reloads. Existing tabs keep their old content script — to test, reload the tab. |
| Edit `manifest.ts` | **Manual**: go to `chrome://extensions` and click the reload icon on the extension. The manifest itself can't hot-reload. |
| Add a new permission to `manifest.ts` | Same as above — and Chrome may also require re-acceptance of permission warnings. |
| Edit `vite.config.ts` or `utils/plugins/*` | Restart `npm run dev`. |

If something looks wrong after a code change, the order to try is: (1) reload the page, (2) reload the extension at `chrome://extensions`, (3) restart `npm run dev`.

## Project conventions

### Path aliases

Defined in [vite.config.ts](../vite.config.ts):

| Alias | Resolves to |
|---|---|
| `@src` | `src/` |
| `@assets` | `src/assets/` |
| `@pages` | `src/pages/` |

Use these in imports rather than relative `../../../` chains.

### Content script can't import modules

Chrome extensions don't load content scripts as ES modules. The workaround is in [src/pages/content/index.ts](../src/pages/content/index.ts):

```ts
import("./components/Demo");  // dynamic import — bundled into a single chunk
```

If you split the React entry into multiple top-level chunks, the dynamic-import boundary is also where vite splits — keep the entry as a single dynamic import.

### CSS cache invalidation

The content-script CSS is emitted as `assets/css/contentStyle<KEY>.chunk.css` where `<KEY>` is regenerated on every build (timestamp-based — see [vite.config.ts:80-88](../vite.config.ts#L80-L88)). The `<KEY>` is also injected into the manifest's `content_scripts[].css` field by `utils/plugins/make-manifest.ts`. This is the boilerplate's workaround for Chrome's aggressive CSS caching across extension reloads. Don't try to "stabilize" the filename.

## Tests

```bash
npm test              # vitest run — one-shot, what CI runs
npm run test:watch    # vitest watch mode
```

Vitest 4 + jsdom + `@testing-library/react`. The chrome-runtime mock lives in [test-utils/vitest.setup.ts](../test-utils/vitest.setup.ts) — it stubs `chrome.runtime.onMessage.{addListener, removeListener}` with `vi.fn()` spies and exports `dispatchChromeMessage(msg, sender)` to synthesize a runtime message into the captured listeners. Extend that file (don't recreate the chrome global per test) when you need broader chrome surface.

Currently one test: [Demo/app.test.tsx](../src/pages/content/components/Demo/app.test.tsx) pins core rule #6 from CLAUDE.md (the message listener registers exactly once and is not re-registered on `shown` toggles).

For end-to-end behavior beyond what the tests cover, use the dev-load-unpacked flow: rebuild, reload the unpacked extension at `chrome://extensions`, exercise the panel on a real page.

## Releases

No automated release pipeline is checked in. To ship: bump `version` in [package.json](../package.json) (it's read by [manifest.ts](../manifest.ts)), `npm run build`, and zip the contents of `dist/` for upload to the Chrome Web Store.
