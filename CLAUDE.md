# CLAUDE.md

Brief orientation for agents/people new to this repo. See `docs/` for details.

## One-liner

Chrome extension (Manifest V3) that injects a sliding side panel into every web page and embeds `https://commentarium.app/comments?url=<current-page>` in an iframe — i.e. the browser UI for the [commentarium](https://commentarium.app) web app.

Built on [chrome-extension-boilerplate-react-vite](https://github.com/Jonghakseo/chrome-extension-boilerplate-react-vite). The custom surface is small: a background script, a content-script-mounted React app, and an iframe wrapper.

## Read these first

- [docs/architecture.md](docs/architecture.md) — what the extension actually does (background ↔ content messaging, sliding panel, iframe lifecycle)
- [docs/development.md](docs/development.md) — build / load-unpacked / HMR flow

## Core rules (must)

1. **The custom code lives under `src/pages/content/components/`** ([Demo/app.tsx](src/pages/content/components/Demo/app.tsx), [iframe/index.tsx](src/pages/content/components/iframe/index.tsx)) and `src/pages/background/index.ts`. Everything else (vite plugins, HMR, manifest builder under `utils/`) is boilerplate — don't refactor it without a reason.
2. **Iframe target is `https://commentarium.app/comments?url=<encoded-url>`** — see [iframe/index.tsx:30](src/pages/content/components/iframe/index.tsx#L30). The companion app lives at <https://commentarium.app>; the extension is purely a UI shell.
3. **All cross-script communication is via `chrome.tabs.sendMessage` / `chrome.runtime.onMessage`** with two message types: `{type: "toggle", url}` (action click) and `{type: "urlChange", url}` (SPA navigation). Background sends, content listens. See [docs/architecture.md#messaging](docs/architecture.md#messaging).
4. **Permissions are intentionally minimal**: `activeTab` only. Content script matches `<all_urls>` so it auto-loads everywhere — no host permission needed.
5. **Iframe is lazy-mounted**: it does not exist in the DOM until the first toggle. After that, `key={url}` is used to force-reload on URL change. Don't replace this with `src=` reassignment — see [iframe/index.tsx:27-32](src/pages/content/components/iframe/index.tsx#L27-L32) and the commit history for `5932faf`.
6. **Message-listener stability**: [Demo/app.tsx](src/pages/content/components/Demo/app.tsx) registers `chrome.runtime.onMessage` once on mount with empty deps, and reads the latest `shown` via a ref. Don't make the listener depend on state — it would re-register on every render and double-fire.

## Common pitfalls

- Content scripts can't use ES modules, so [content/index.ts](src/pages/content/index.ts) uses dynamic `import("./components/Demo")` to load the React entry.
- The CSS is fingerprinted (`contentStyle<KEY>.chunk.css`) for cache invalidation — if you rename the entry, update the manifest match in [manifest.ts](manifest.ts) and the rollup output rule in [vite.config.ts](vite.config.ts).
- After editing [manifest.ts](manifest.ts) you must reload the extension at `chrome://extensions` (HMR doesn't cover the manifest).
- The options page is wired up in source ([src/pages/options/](src/pages/options/)) but **not registered in the manifest** — it's a stub left over from the boilerplate. If you actually need an options page, add `options_page` (or `options_ui`) to [manifest.ts](manifest.ts) and add the input back to [vite.config.ts](vite.config.ts) (currently commented out).

## Code style

- **Language**: write all new comments and git commit messages in **English**.
- **File size**: aim for under ~500 lines per file. The whole custom surface fits well under this; if a single file is approaching it, the split is probably wrong.
- Match the existing terse style — this is a thin wrapper, not a framework.

## Build / test

```bash
npm install
npm run dev          # builds to dist/ in watch mode + reload server (load dist/ as unpacked)
npm run build        # tsc --noEmit && vite build
npm test             # jest (currently one smoke test for Demo/app)
```

Details — including the Chrome "Load unpacked" flow and HMR caveats — in [docs/development.md](docs/development.md).
