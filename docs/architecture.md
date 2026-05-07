# Architecture

What the extension actually does. The custom surface is small (background SW + content-script panel + auth broker, all under ~400 lines of TS/TSX); everything else is boilerplate scaffolding.

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
                                             │  (every web page,    │
                                             │   http(s)://*/*)     │
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

## Two entry points

| Entry | File | Role |
|---|---|---|
| Background service worker | [src/pages/background/index.ts](../src/pages/background/index.ts) | Listens for the action icon click and tab URL changes; relays both as messages to the active tab's content script. Imports [auth.ts](../src/pages/background/auth.ts), which registers the `chrome.runtime.onMessageExternal` listener for the auth broker (see below). |
| Content script | [src/pages/content/index.ts](../src/pages/content/index.ts) | Mounts a React root in `document.body` (id `commentarium-content-view-root`) on every page |

The manifest is generated from [manifest.ts](../manifest.ts) by a vite plugin under `utils/plugins/`.

## The sliding panel

[src/pages/content/components/panel/app.tsx](../src/pages/content/components/panel/app.tsx) renders:

- A fixed-position container (`.commentarium-view`) anchored to the right edge of the viewport. Width 400px, full height minus 32px margin. Slides in/out via a CSS `right` transition (`-432px` ↔ `0`) — see [src/pages/content/style.scss](../src/pages/content/style.scss).
- A close button (`Header`) absolutely positioned over the iframe.
- The iframe (lazy-mounted on first toggle).

State held in [panel/app.tsx](../src/pages/content/components/panel/app.tsx):

| State | Purpose |
|---|---|
| `iframeRendered` | Once true, never goes back to false. Keeps the iframe in the DOM after the first open so re-opening is instant. |
| `shown` | Drives the `.open` class → CSS slide. |
| `url` | Forwarded to the iframe's `src`. |
| `shownRef` | Ref mirror of `shown`, read inside the message listener so the listener can stay registered with empty deps without going stale. |

### Why the ref?

The `chrome.runtime.onMessage` listener is registered once on mount (`useEffect` with `[]`). If it depended on `shown` directly, every state change would tear down and re-register the listener — and during the transition, in-flight messages could be dropped or double-handled. The ref pattern (mirror state in a ref, read the ref inside the stable callback) keeps registration stable while still seeing fresh values. See [panel/app.tsx:11-50](../src/pages/content/components/panel/app.tsx#L11-L50).

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

## Auth broker (service worker)

A second message channel runs alongside the toggle/urlChange relay above. The iframe (running on `commentarium.app`) talks to the SW via `chrome.runtime.sendMessage(EXT_ID, …)` to authenticate. This is the **`onMessageExternal` channel** — different API, different listener, different sender semantics from the `onMessage` relay above.

The SW is a *thin token vendor*: it holds Firebase Auth state via the [`firebase/auth/web-extension`](https://firebase.google.com/docs/auth/web/manage-users#web-extension) build and hands out ID tokens. It does **not** write cookies and does **not** call `/api/login` — the iframe (1st-party `commentarium.app` context, even when embedded) does that itself, and the server writes the partitioned (CHIPS) session cookie.

The full broker contract — sender gating, op surface, Google sign-in flow (`launchWebAuthFlow` + state check + error code taxonomy), sign-out cleanup contract, Cloud Console setup, and the `VITE_EXTENSION_KEY` dual-role caveat — lives in [docs/auth.md](auth.md).

For the design rationale, see the two posts:

- [From chrome.cookies to CHIPS](https://zeikar.dev/blog/from-chrome-cookies-to-chips/) — why the SW vends ID tokens instead of writing cookies itself.
- [From getAuthToken to launchWebAuthFlow](https://zeikar.dev/blog/from-getauthtoken-to-launchwebauthflow/) — why the Google sign-in flow uses `launchWebAuthFlow` for reliable cancel detection.

## Permissions

Manifest declares exactly three ([manifest.ts](../manifest.ts)):

| Permission | Used for |
|---|---|
| `activeTab` | `chrome.tabs.sendMessage` from the action-click path — dispatching `toggle`/`urlChange` to the active tab's content script |
| `identity` | `chrome.identity.launchWebAuthFlow` (+ `getRedirectURL`, `clearAllCachedAuthTokens`) for the Google sign-in flow — see [docs/auth.md](auth.md) |
| `storage` | `firebase/auth/web-extension`'s persistence backend — Firebase Auth user state survives SW restart |

No `host_permissions`. The content script's `matches: ["http://*/*", "https://*/*"]` is what grants page access for mounting the panel — `file://`, `ftp://`, and other non-web schemes are intentionally out of scope. The SW itself never makes cross-origin HTTP requests now that auth is broker-mediated. The browser writes the partitioned session cookie via `Set-Cookie: ...; Partitioned` from `commentarium.app`'s server.

`externally_connectable.matches: ["https://commentarium.app/*"]` is what locks the auth broker channel down to the webapp.

Min Chrome version: `114` (when CHIPS — the `Partitioned` cookie attribute — reached stable).

## File map

```
src/
├── pages/
│   ├── background/
│   │   ├── index.ts                  # service worker entry — toggle/urlChange dispatcher; imports auth.ts
│   │   ├── auth.ts                   # auth broker — onMessageExternal listener + 5 op handlers
│   │   ├── auth.test.ts              # broker handler tests (signIn / refresh / signOut / getIdToken)
│   │   └── firebase.ts               # Firebase web-extension Auth init
│   └── content/
│       ├── index.ts                  # entry: mounts React root, dynamic-imports panel
│       ├── style.scss                # panel styles (slide animation, layout)
│       └── components/
│           ├── panel/
│           │   ├── app.tsx           # panel state + message listener
│           │   ├── header.tsx        # close button
│           │   └── index.tsx         # createRoot bootstrap (called via dynamic import)
│           └── iframe/
│               ├── index.tsx         # iframe + loading wrapper (URL has &surface=extension)
│               └── loading.tsx       # spinner
├── assets/style/theme.scss           # shared SCSS (currently a single placeholder rule)
└── global.d.ts                       # virtual:reload-on-update-* + asset module decls

manifest.ts                            # generated → dist/manifest.json by vite plugin
manifest.test.ts                       # pins manifest shape (CHIPS contract regression guard)
vite.config.ts                         # input map + custom plugins (manifest, HMR, dynamic-import)
test-utils/vitest.setup.ts             # chrome.runtime + chrome.identity + chrome.storage + chrome.cookies mocks
utils/plugins/                         # boilerplate vite plugins — leave alone
utils/reload/                          # boilerplate HMR reload server — leave alone
```
