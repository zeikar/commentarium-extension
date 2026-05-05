# CLAUDE.md

Brief orientation for agents/people new to this repo. See `docs/` for details.

## One-liner

Chrome extension (Manifest V3) that injects a sliding side panel into every web page and embeds `https://commentarium.app/comments?url=<current-page>` in an iframe — i.e. the browser UI for the [commentarium](https://commentarium.app) web app.

Built on [chrome-extension-boilerplate-react-vite](https://github.com/Jonghakseo/chrome-extension-boilerplate-react-vite). The custom surface is small: a background script, a content-script-mounted React app, and an iframe wrapper.

## Read these first

- [docs/architecture.md](docs/architecture.md) — what the extension actually does (background ↔ content messaging, sliding panel, iframe lifecycle)
- [docs/development.md](docs/development.md) — build / load-unpacked / HMR flow

## Core rules (must)

1. **The custom code lives under `src/pages/content/components/`** ([panel/app.tsx](src/pages/content/components/panel/app.tsx), [iframe/index.tsx](src/pages/content/components/iframe/index.tsx)) and `src/pages/background/` ([index.ts](src/pages/background/index.ts), [auth.ts](src/pages/background/auth.ts), [firebase.ts](src/pages/background/firebase.ts)). Everything else (vite plugins, HMR, manifest builder under `utils/`) is boilerplate — don't refactor it without a reason.
2. **Iframe target is `https://commentarium.app/comments?url=<encoded-url>&surface=extension`** — see [iframe/index.tsx:30](src/pages/content/components/iframe/index.tsx#L30). The companion app lives at <https://commentarium.app>; the extension is purely a UI shell.
3. **Two distinct message channels**:
   - **Toggle/urlChange**: `chrome.tabs.sendMessage` / `chrome.runtime.onMessage`. Background sends, content listens. Two message types: `{type: "toggle", url}` (action click) and `{type: "urlChange", url}` (SPA navigation). See [docs/architecture.md#messaging](docs/architecture.md#messaging).
   - **Auth broker**: `chrome.runtime.sendMessage(EXT_ID, …)` / `chrome.runtime.onMessageExternal`. Webapp iframe sends, SW listens. Five ops under the `commentarium.auth.*` namespace. Different API, different listener — don't conflate them. See [docs/auth.md](docs/auth.md) and [src/pages/background/auth.ts](src/pages/background/auth.ts).
4. **Permissions** are exactly three: `activeTab`, `identity`, `storage`. Identity for `chrome.identity.launchWebAuthFlow` (Google sign-in via OAuth implicit flow); storage for Firebase Auth's persistence (`firebase/auth/web-extension`). No `host_permissions` — the SW does not make cross-origin HTTP requests under the CHIPS contract. The iframe handles `/api/login` itself and the server writes the partitioned cookie. Content script `matches: ["http://*/*", "https://*/*"]` is what grants page access for mounting the panel — `file://`, `ftp://`, and other non-web schemes are intentionally out of scope.
5. **Iframe is lazy-mounted**: it does not exist in the DOM until the first toggle. After that, `key={url}` is used to force-reload on URL change. Don't replace this with `src=` reassignment — see [iframe/index.tsx:27-32](src/pages/content/components/iframe/index.tsx#L27-L32) and the commit history for `5932faf`.
6. **Message-listener stability**: [panel/app.tsx](src/pages/content/components/panel/app.tsx) registers `chrome.runtime.onMessage` once on mount with empty deps, and reads the latest `shown` via a ref. Don't make the listener depend on state — it would re-register on every render and double-fire.
7. **Auth broker is a thin token vendor**: it returns `{ ok: true, idToken }` (signIn / refresh) or `{ idToken }` (handoff getIdToken) — and never writes cookies, never calls `/api/login`. Cleanup on the signed-out path is best-effort (`performSignOutCleanupBestEffort`) — don't unwrap it without understanding why; a transient cleanup throw must not suppress the `signedOut: true` signal to the iframe.

## Common pitfalls

- Content scripts can't use ES modules, so [content/index.ts](src/pages/content/index.ts) uses dynamic `import("./components/panel")` to load the React entry.
- The CSS is fingerprinted (`contentStyle<KEY>.chunk.css`) for cache invalidation — if you rename the entry, update the manifest match in [manifest.ts](manifest.ts) and the rollup output rule in [vite.config.ts](vite.config.ts).
- After editing [manifest.ts](manifest.ts) you must reload the extension at `chrome://extensions` (HMR doesn't cover the manifest).

## Code style

- **Language**: write all new comments and git commit messages in **English**.
- **File size**: aim for under ~500 lines per file. The whole custom surface fits well under this; if a single file is approaching it, the split is probably wrong.
- Match the existing terse style — this is a thin wrapper, not a framework.

## Build / dev

```bash
npm install
npm run dev             # builds to dist/ in watch mode + reload server (load dist/ as unpacked)
npm run build           # tsc --noEmit && vite build
npm run build:release   # what the Web Store artifact must go through — scrubs VITE_EXTENSION_KEY
npm test                # vitest run — panel/app + auth broker + manifest contract suites
```

Details — including the Chrome "Load unpacked" flow, HMR caveats, and release-build flow — in [docs/development.md](docs/development.md).
