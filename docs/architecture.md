# Architecture

What the extension actually does. The custom surface is small (~150 lines of TS/TSX); everything else is boilerplate scaffolding.

## High-level

```
┌──────────────────────┐  action.onClicked   ┌──────────────────────┐
│  Browser action icon │ ──────────────────► │  Background SW       │
└──────────────────────┘                     │  (service_worker)    │
                                             └──────────┬───────────┘
                                                        │ chrome.tabs.sendMessage
                                                        │ {type: "toggle" | "urlChange", url}
                                                        ▼
                                             ┌──────────────────────┐
                                             │  Content script      │
                                             │  (every page,        │
                                             │   <all_urls>)        │
                                             │                      │
                                             │  ├─ React root       │
                                             │  │   #commentarium-  │
                                             │  │   content-view-   │
                                             │  │   root            │
                                             │  └─ <iframe          │
                                             │       src=https://   │
                                             │       commentarium   │
                                             │       .app/comments  │
                                             │       ?url=…>        │
                                             └──────────────────────┘
```

The iframe is the actual UI — the extension just decides **when** and **where** to show it.

## Three entry points

| Entry | File | Role |
|---|---|---|
| Background service worker | [src/pages/background/index.ts](../src/pages/background/index.ts) | Listens for the action icon click and tab URL changes; relays both as messages to the active tab's content script |
| Content script | [src/pages/content/index.ts](../src/pages/content/index.ts) | Mounts a React root in `document.body` (id `commentarium-content-view-root`) on every page |
| Options page | [src/pages/options/](../src/pages/options/) | Stub. Wired in source, **not** in the manifest — see CLAUDE.md "Common pitfalls" |

The manifest is generated from [manifest.ts](../manifest.ts) by a vite plugin under `utils/plugins/`.

## The sliding panel

[src/pages/content/components/Demo/app.tsx](../src/pages/content/components/Demo/app.tsx) renders:

- A fixed-position container (`.commentarium-view`) anchored to the right edge of the viewport. Width 400px, full height minus 32px margin. Slides in/out via a CSS `right` transition (`-432px` ↔ `0`) — see [src/pages/content/style.scss](../src/pages/content/style.scss).
- A close button (`Header`) absolutely positioned over the iframe.
- The iframe (lazy-mounted on first toggle).

State held in [Demo/app.tsx](../src/pages/content/components/Demo/app.tsx):

| State | Purpose |
|---|---|
| `iframeRendered` | Once true, never goes back to false. Keeps the iframe in the DOM after the first open so re-opening is instant. |
| `shown` | Drives the `.open` class → CSS slide. |
| `url` | Forwarded to the iframe's `src`. |
| `shownRef` | Ref mirror of `shown`, read inside the message listener so the listener can stay registered with empty deps without going stale. |

### Why the ref?

The `chrome.runtime.onMessage` listener is registered once on mount (`useEffect` with `[]`). If it depended on `shown` directly, every state change would tear down and re-register the listener — and during the transition, in-flight messages could be dropped or double-handled. The ref pattern (mirror state in a ref, read the ref inside the stable callback) keeps registration stable while still seeing fresh values. See [Demo/app.tsx:11-50](../src/pages/content/components/Demo/app.tsx#L11-L50).

## The iframe wrapper

[src/pages/content/components/iframe/index.tsx](../src/pages/content/components/iframe/index.tsx).

- `src` = `https://commentarium.app/comments?url=<encodeURIComponent(currentUrl)>`.
- `key={url}` forces React to unmount/remount the `<iframe>` element when the URL changes. This is the cheapest way to guarantee a clean reload — `src=` reassignment can leave the old document loaded under some browser conditions, and history-state pollution becomes possible. (See commit `5932faf` "Optimize iframe URL reload performance" for the prior tradeoff.)
- Local `loading` state shows a spinner ([loading.tsx](../src/pages/content/components/iframe/loading.tsx)) until `onLoad` fires, then the iframe is unhidden. The spinner re-shows whenever `url` changes.

The iframe is **lazy-mounted**: `iframeRendered` is false on initial page load. The iframe doesn't exist until the user clicks the action icon for the first time on that tab. This avoids a request to `commentarium.app` on every page navigation.

## Messaging

Two message types, both fire-and-forget (no response expected).

### `{type: "toggle", url}`

- **Sender**: background, in `chrome.action.onClicked` → [background/index.ts:14-16](../src/pages/background/index.ts#L14-L16).
- **Trigger**: user clicks the extension icon in the toolbar.
- **Receiver**: content script's `messageListener` → toggles `shown`, sets `url`, ensures `iframeRendered` is true.

### `{type: "urlChange", url}`

- **Sender**: background, in `chrome.tabs.onUpdated` when `changeInfo.url` is set → [background/index.ts:19-25](../src/pages/background/index.ts#L19-L25).
- **Trigger**: any tab URL change — including SPA `pushState` navigations that fire `tabs.onUpdated` with a `url` field.
- **Receiver**: content script. Updates `url` **only if the panel is currently open** (read from `shownRef`). If the panel is closed, the message is ignored — we don't want to pre-load an iframe the user hasn't asked for.

### Why two messages, not one toggle?

`urlChange` fires unconditionally on navigation; `toggle` only fires on user intent. Conflating them would either auto-open the panel on every navigation (bad UX) or require the content script to track whether the user opened it — which is what we already do, just inverted. Splitting the messages keeps each handler trivially correct.

## Permissions

[manifest.ts](../manifest.ts):

- `activeTab` — minimal. The content script `matches: ["<all_urls>"]` is what actually grants page access; `activeTab` is only used by `chrome.tabs.sendMessage` from the action click path.
- No `tabs`, `storage`, `scripting`, or host permissions. If you need to read tab URLs from outside the active-tab context (e.g. background polling), you'll need `tabs`.

## File map

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
