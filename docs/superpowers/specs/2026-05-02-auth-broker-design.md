# Auth broker design (cycle ③)

**Date:** 2026-05-02
**Status:** Approved (pending spec review)

## Context

Cycle ③ of the three-cycle plan stated in
[2026-05-02-baseline-cleanup-design.md](2026-05-02-baseline-cleanup-design.md):
① baseline cleanup (done) → ② Vite/Vitest upgrade (done) → ③ auth broker (this spec).

The driver is a P0 issue in the companion webapp's review queue. Chrome's storage
partitioning silos iframe cookies per top-level origin, so the existing session cookie
set by `/api/login` (`SameSite=None; Secure`) disappears whenever Chrome blocks
third-party cookies. Confirmed by toggling Chrome's "Block third-party cookies" off →
login restored. Affects every iframed `/comments` view; the 1st-party app at
commentarium.app is unaffected.

Cycle ② deliberately seeded Vitest (Vite 6 + Node 22) so this cycle's broker code —
where origin verification and message protocol are correctness-critical — would land
with real test coverage from day one.

## Decision summary

Settled in brainstorming:

| Question | Decision |
|---|---|
| Spec scope | Unified extension+webapp contract spec, lives in extension repo. The webapp side is a private repo and is described via interface contract — no source links into it. |
| Auth backend | Firebase Auth is the canonical session. `chrome.identity.getAuthToken` is the Google credential adapter only. No offscreen documents. |
| Extension UI | Transparent broker. No popup/options page. All sign-in UI stays in the iframed webapp. Action icon click still toggles the panel as today. |
| Auto sign-in | None. Iframe shows the existing webapp sign-in modal when `currentUser === null`; user explicitly picks Google or Anonymous. |
| Operations | Minimal set: `getCurrentUser`, `signIn.google`, `signIn.anonymous`, `signOut`, `getIdToken`, `stateChanged`. Upgrade/delete/reauth are out of scope — they operate via the webapp settings page, which opens in a 1st-party tab and is unaffected by partitioning. |
| Transport (CS↔SW) | `chrome.runtime.sendMessage` (one-shot). Push from SW to all tabs with a registered relay. |
| Surface detection | Iframe URL gains `?surface=extension`. Webapp reads the query and switches to broker mode. |
| Token refresh | Pull-based on demand (`getIdToken({ forceRefresh })`). `stateChanged` push carries user shape only — never the token. |

## Architecture

### Components

**Background service worker** (new module: `src/pages/background/auth.ts`).
Owns the Firebase Auth instance built from `firebase/auth/web-extension`. Receives
the six message types from content scripts. Calls
`chrome.identity.getAuthToken({ interactive: true })` only when handling
`signIn.google`; the OAuth access token is exchanged via
`signInWithCredential(auth, GoogleAuthProvider.credential(null, accessToken))`.
Subscribes to `onIdTokenChanged`; on every fire (sign-in, sign-out, token rotation)
broadcasts a `stateChanged` push.

Persistence: SW restarts pick up the existing user via Firebase's `web-extension`
build, which uses `chrome.storage.local` automatically when that entrypoint is used.

**Content script auth relay** (new module: `src/pages/content/components/iframe/auth-relay.ts`).
Pure forwarder, mounted alongside the iframe element. Two listeners:

- `window.addEventListener('message', …)` — receives messages from the iframe.
  Drops unless all four of: `event.origin === 'https://commentarium.app'`,
  `event.source === iframeRef.current?.contentWindow`,
  `event.data?.type` starts with `commentarium.auth.`, and
  `typeof event.data?.requestId === 'string'`. Forwards via `chrome.runtime.sendMessage`.
- `chrome.runtime.onMessage.addListener(…)` — receives SW responses and pushes.
  Forwards to `iframeRef.current.contentWindow.postMessage(payload, 'https://commentarium.app')`,
  guarded by `if (iframeRef.current)` so a closed-panel push is a silent no-op.

Both listeners register once on mount with stable refs (per [CLAUDE.md](../../../CLAUDE.md)
core rule #6 — same pattern the existing message listener in [Demo/app.tsx](../../../src/pages/content/components/Demo/app.tsx)
uses).

**Iframe wrapper** (modify: [src/pages/content/components/iframe/index.tsx](../../../src/pages/content/components/iframe/index.tsx)).
The existing iframe URL becomes
`https://commentarium.app/comments?url=<encoded>&surface=extension`.
The relay component mounts alongside the iframe and shares the iframe ref.

**Webapp** (private repo, contract only). When `?surface=extension` is detected, the
webapp routes its existing sign-in/sign-out UI through a `RemoteAuthAdapter` instead
of the Firebase web SDK. The adapter posts `commentarium.auth.*` messages to
`window.parent` (target origin `'*'` is acceptable on the iframe→parent direction
because the parent is third-party and unknown to the webapp — the **content script**
is the authoritative gate via origin+source verification on receive). On `/api/login`,
the adapter sets header `X-Commentarium-Surface: extension`. Server reads the header
and adds `Partitioned` to the `Set-Cookie` attributes (CHIPS), keeping
`SameSite=None; Secure; HttpOnly`. 1st-party `/api/login` calls (without the header)
keep the existing unpartitioned cookie path.

### File layout (extension repo)

New files:
- `src/pages/background/auth.ts` — message handler + Firebase Auth ops
- `src/pages/background/firebase.ts` — Firebase config from env, `initializeApp` + `initializeAuth`
- `src/pages/content/components/iframe/auth-relay.ts` — postMessage ↔ runtime relay
- `.env.example` — documents required keys
- `vite-env.d.ts` augmentation for `import.meta.env.VITE_FIREBASE_*` (or add to
  existing `src/global.d.ts`)

Modified:
- [src/pages/background/index.ts](../../../src/pages/background/index.ts) — import auth module
- [src/pages/content/components/iframe/index.tsx](../../../src/pages/content/components/iframe/index.tsx) — append `&surface=extension`, mount relay
- [manifest.ts](../../../manifest.ts) — `identity` + `storage` permissions, `oauth2` block
- `package.json` — add `firebase` dep
- `.gitignore` — ensure `.env.local` is ignored (likely already covered by `.env*.local`)

## Message protocol

All messages have `type` starting with `commentarium.auth.`. Request/response pairs
carry a matching `requestId` (a `crypto.randomUUID()` string created by the iframe).
The relay does not generate or rewrite request IDs.

### Operations

| Type | Direction | Request | Response |
|---|---|---|---|
| `commentarium.auth.getCurrentUser` | iframe → SW | `{ requestId }` | `{ requestId, currentUser, idToken }` |
| `commentarium.auth.signIn.google` | iframe → SW | `{ requestId }` | `{ requestId, currentUser, idToken }` or `{ requestId, error }` |
| `commentarium.auth.signIn.anonymous` | iframe → SW | `{ requestId }` | `{ requestId, currentUser, idToken }` or `{ requestId, error }` |
| `commentarium.auth.signOut` | iframe → SW | `{ requestId }` | `{ requestId, ok: true }` or `{ requestId, error }` |
| `commentarium.auth.getIdToken` | iframe → SW | `{ requestId, forceRefresh?: boolean }` | `{ requestId, idToken }` or `{ requestId, error }` |
| `commentarium.auth.stateChanged` | SW → iframe (push) | — | `{ currentUser }` |

### Shapes

```ts
type CurrentUser = {
  uid: string;
  isAnonymous: boolean;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
} | null;

type AuthError = {
  code: string;     // e.g. "auth/popup-closed-by-user", "identity/user-cancelled"
  message: string;  // human-readable
};
```

**Why `idToken` is in `signIn.*`/`getCurrentUser` responses but not in `stateChanged`
pushes**: pushes can race with concurrent token rotations, so a stale token in a push
that arrives out-of-order would be hard to detect. The webapp pulling on demand
(`getIdToken`) always gets a fresh token from the SW's authoritative state.

**Error vs success fields are mutually exclusive**. The webapp's existing sign-in
modal surfaces `error.message` directly when present.

### Transport

- **iframe ↔ content script**: `window.postMessage`. Iframe → parent target = `'*'`
  (parent origin is the third-party top-level page, unknown to the webapp). Content
  script verifies on receive. Content script → iframe target = the literal string
  `'https://commentarium.app'` (exact, never `'*'`, never read from `event.origin`).
- **content script ↔ SW**: `chrome.runtime.sendMessage` with a callback for the
  response. SW maintains a `Set<tabId>` of tabs that have sent any message — on push,
  iterates the set and `chrome.tabs.sendMessage`s each, catching `Could not establish
  connection` errors and removing dead tabIds. (SW does not actively register tabs;
  it learns about them lazily via `sender.tab.id` on the first request from each.)

## Sequence flows

### Cold start, no existing user

1. User clicks action icon → existing `toggle` message → panel slides in → iframe
   mounts with `?surface=extension`.
2. Webapp loads, detects `surface=extension`, sends `getCurrentUser` to parent.
3. Content script forwards to SW. SW reads Firebase `auth.currentUser` → `null`.
4. SW responds `{ currentUser: null, idToken: null }`.
5. Webapp shows its existing sign-in modal.

### Sign in anonymously

1. User clicks "Continue Anonymously" → webapp sends `signIn.anonymous`.
2. SW calls `signInAnonymously(auth)` → Firebase user created → `onIdTokenChanged`
   fires → SW broadcasts `stateChanged` push.
3. SW responds to the original request with `{ currentUser, idToken }`.
4. Webapp posts `idToken` to `/api/login` with `Authorization: Bearer …` and
   `X-Commentarium-Surface: extension`.
5. Server validates the ID token, creates session cookie with
   `Partitioned; SameSite=None; Secure; HttpOnly`, returns 200.
6. Webapp `router.refresh()` → comment UI now reflects signed-in state.

### Sign in with Google

1. User clicks "Continue with Google" → webapp sends `signIn.google`.
2. SW calls `chrome.identity.getAuthToken({ interactive: true })`. Chrome shows the
   native account chooser sheet (no popup window).
3. SW builds `GoogleAuthProvider.credential(null, accessToken)` →
   `signInWithCredential(auth, credential)`.
4. SW responds with `{ currentUser, idToken }`. Webapp does the `/api/login` step
   exactly as in the anonymous flow.

### Token refresh

1. Webapp's API client receives 401 (or detects ID token within ~60s of expiry, at
   the webapp's discretion).
2. Webapp sends `getIdToken({ forceRefresh: true })`.
3. SW calls `auth.currentUser.getIdToken(true)` → fresh token.
4. SW responds `{ idToken }`.
5. Webapp retries the original request, and re-posts `/api/login` if the session
   cookie expired.

### Sign out

1. User clicks sign out → webapp sends `signOut`.
2. SW calls `signOut(auth)` → `onIdTokenChanged` fires `null` → SW broadcasts
   `stateChanged` push.
3. SW also calls `chrome.identity.removeCachedAuthToken({ token: lastAccessToken })`
   to drop the cached Google OAuth token (otherwise the next `signIn.google` would
   silently re-use the cached account without the chooser appearing).
4. SW responds `{ ok: true }`.
5. Webapp DELETEs its session-cookie endpoint to expire the session cookie.

### Cross-tab consistency

Two tabs both have the panel open:

- Tab A signs out via `signOut`.
- SW's `onIdTokenChanged` fires → SW broadcasts `stateChanged` to both tabs.
- Both webapps receive `{ currentUser: null }` push and re-render to signed-out UI.
- Each tab's session cookie is partitioned per top-level origin, so cookie-level
  cleanup happens per tab — the webapp's `stateChanged` handler triggers the
  session-cookie DELETE on its own tab.

## Security model

### Origin & source verification (content script gate)

Iframe-listener gate (all four conditions, AND):

1. `event.origin === 'https://commentarium.app'`
2. `event.source === currentIframeContentWindow` — the iframe element this relay is
   bound to. This rejects messages from arbitrary other iframes, including malicious
   same-origin frames in nested cases.
3. `typeof event.data?.type === 'string'` and starts with `commentarium.auth.`.
4. `typeof event.data?.requestId === 'string'`.

Failure mode for any of (1)–(4): silent drop. Log once per origin/source mismatch on
first occurrence per page load to aid debugging, then suppress.

Content script → iframe target origin is always the literal string
`'https://commentarium.app'`. Never `'*'`, never read from `event.origin`.

### ID-token-only

The SW returns Firebase ID tokens only. The Firebase refresh token, used internally
by the SDK to mint new ID tokens, is never exposed via any message. An attacker who
intercepts a `commentarium.auth.*` message can replay a still-valid ID token (it is
already designed to be presented to a server that verifies it against Firebase) but
cannot mint new tokens after expiry.

### chrome.identity OAuth

The Google OAuth client_id is configured in [manifest.ts](../../../manifest.ts)'s
`oauth2` block as a "Chrome App" type client (registered in the Google Cloud Console
for this extension's public key). `chrome.identity.getAuthToken({ interactive: true })`
triggers the native Chrome sign-in sheet — no popup window, no iframe redirect. The
returned access token is used exactly once per sign-in: to build a
`GoogleAuthProvider.credential` and pass it to `signInWithCredential`. The access
token is not stored or forwarded outside the SW; only the resulting Firebase ID
token leaves.

### CSRF / origin allowlist on the webapp

The webapp's existing CSRF middleware allowlists
`chrome-extension://hogjejflnephnomijedgfocipidnkemf` as a request origin (per the
production extension key). When the iframe makes a fetch to `/api/*` from inside the
extension surface, the request origin is `https://commentarium.app` (because the
iframe IS at commentarium.app), so the existing allowlist already covers it — no
allowlist changes needed for this cycle.

## Manifest & build configuration

### Manifest changes

```ts
permissions: ["activeTab", "identity", "storage"],
oauth2: {
  client_id: "<from VITE_GOOGLE_OAUTH_CLIENT_ID>",
  scopes: ["openid", "email", "profile"],
},
```

- `identity`: required for `chrome.identity.getAuthToken`.
- `storage`: Firebase Auth's `web-extension` build uses `chrome.storage.local` for
  user persistence. Without this permission the SDK falls back to in-memory and the
  user disappears across SW restarts.
- `oauth2.client_id` is filled at build time from `VITE_GOOGLE_OAUTH_CLIENT_ID`.
  `manifest.ts` is TS code executed by the manifest plugin (not browser code), so it
  can read `process.env.*` directly. Throws at build if missing — fail-fast.
- `host_permissions`: NOT added. The content script's `<all_urls>` match is
  unchanged. Cross-origin fetches from the iframe to commentarium.app go through
  the iframe's own origin, not the extension's.

### Firebase configuration via env

Firebase requires `apiKey`, `authDomain`, `projectId`, `appId` (and optionally
`messagingSenderId`, `storageBucket` — not used here). These values are public-ish
(visible in browser bundles) but project policy prefers env injection for an OSS
repo.

- `.env.example` (new, committed): documents required keys with placeholder values.
- `.env.local` (gitignored, dev-only): real values for local testing.
- CI / release builds inject via repo secrets → `VITE_FIREBASE_*` and
  `VITE_GOOGLE_OAUTH_CLIENT_ID`.
- `src/pages/background/firebase.ts` reads `import.meta.env.VITE_FIREBASE_*` and
  initializes the Firebase app. Throws with a clear error if any required key is
  missing.

### `firebase/auth/web-extension` import

Firebase ships a SW-compatible Auth build at `firebase/auth/web-extension`. The SW
imports from there instead of the default `firebase/auth`:

```ts
import {
  initializeAuth,
  signInAnonymously,
  signInWithCredential,
  signOut,
  onIdTokenChanged,
  GoogleAuthProvider,
} from 'firebase/auth/web-extension';
```

The default `firebase/auth` entrypoint pulls in browser-only assumptions (popup,
redirect) and breaks under SW.

## Testing strategy

Vitest tests, building on the chrome-runtime mock from cycle ②
([test-utils/vitest.setup.ts](../../../test-utils/vitest.setup.ts)). Existing mock is
extended (not replaced) with `chrome.identity`, `chrome.storage`, `chrome.tabs`
spies as needed.

1. **Origin/source gate** — feed the relay's `window` listener fake `MessageEvent`s
   with: wrong origin / right origin + wrong source / right both + wrong namespace /
   right both + right namespace + missing requestId / fully valid. Assert
   `chrome.runtime.sendMessage` was called only in the fully valid case.
2. **SW handler routing** — mock the `firebase/auth/web-extension` module. Dispatch
   each of the six operations to the SW message handler. Assert the correct Firebase
   method is called and the response shape matches the protocol table.
3. **Token refresh** — `getIdToken({ forceRefresh: true })` →
   `currentUser.getIdToken` called with `true`.
4. **State push** — fire the mocked `onIdTokenChanged` callback → assert
   `chrome.tabs.sendMessage` is broadcast with
   `{ type: 'commentarium.auth.stateChanged', currentUser }` to known tabIds.
5. **`requestId` roundtrip** — concurrent requests with different requestIds; verify
   no crosstalk in responses.
6. **Sign-out cache cleanup** — assert `chrome.identity.removeCachedAuthToken` is
   called with the previously-issued access token.

What this does NOT cover (deliberately):
- Real Firebase Auth integration (no live Firebase project in tests).
- Real `chrome.identity.getAuthToken` behavior.
- Webapp-side adapter behavior (lives in the webapp repo).
- CHIPS cookie behavior (server-side; webapp repo).

E2E manual verification:
- Load unpacked, set Chrome 3rd-party cookie blocking ON.
- Visit two different top-level sites (e.g., `example.com` and
  `developer.mozilla.org`).
- Open panel on each, sign in with Google on the first, post a comment.
- DevTools → Application → Cookies: confirm `session` cookie under
  `commentarium.app` partitioned per top-level origin, with `Partitioned` attribute.
- Switch to second site → comment posts succeed without re-prompting (single
  Firebase user behind both partitions).
- Reload each tab → still signed in.

## Sequencing within cycle ③

The implementation plan (next step, written via the `superpowers:writing-plans`
skill) decides commit splitting. Conceptual work units, in dependency order:

1. **Build/config scaffolding** — env loader, `.env.example`, `manifest.ts`
   `oauth2` + permissions, `firebase` dep, `firebase.ts` config module. No
   behavioral change yet; build still produces a working extension that ignores
   the new config.
2. **SW auth module** — Firebase init, message handler, six operations, push on
   `onIdTokenChanged`. Unit-tested with mocked Firebase.
3. **Content script relay** — window-message listener with origin/source gate,
   runtime relay, iframe URL `&surface=extension`, mount in iframe wrapper.
   Unit-tested with the chrome mock.
4. **CI** — confirm `npm test` covers the new test files on Node 22 (already wired
   in cycle ②).
5. **Manual E2E checklist** — load unpacked + 3rd-party-cookie-block test.

The webapp repo gets a parallel set of work units, sequenced separately:

- `RemoteAuthAdapter` module + `?surface=extension` detection.
- Re-route sign-in modal / sign-out / API client through the adapter when in
  extension mode.
- `/api/login` server-side: read `X-Commentarium-Surface` header, add `Partitioned`
  to the response cookie when present.
- Webapp tests for the adapter and the new server branch.

End-to-end activation: cycle ③ doesn't ship to users until BOTH repos have landed
their changes and the webapp deploy is live. Until then the extension's
`&surface=extension` URL is ignored by the production webapp (which doesn't yet
read the query) and the existing direct-Firebase path runs. Practically this means
the extension can be merged at any time after its own work is done; user-visible
behavior stays the same until the webapp ships.

## Non-scope (explicit deferrals)

- **Anonymous → Google upgrade in the iframe.** The webapp settings page opens in a
  new tab (1st-party context, unaffected by partitioning), so the existing
  `linkWithPopup` flow already works there. Brokering upgrade through the extension
  would require additional protocol surface for marginal benefit. (Note: an
  anonymous user signing in with Google through the extension surface signs in as a
  fresh Google user, not link — their anonymous comments stay attached to the
  abandoned anonymous UID. This is identical to current behavior; cycle ③ neither
  fixes nor regresses it.)
- **Account delete + reauthenticate.** Same reasoning — operates via settings new
  tab.
- **Storage Access API fallback** (per webapp review #1). Acceptable to defer
  because the primary broker path covers the P0 case; SAA was always the secondary
  recommendation for "if extension bootstrap fails." Reconsider if telemetry shows
  broker-failure rates above a small threshold.
- **Token caching in content script or iframe.** SW is the single source of truth;
  caches in lower layers introduce sync bugs.
- **React 18 → 19**, **ESLint 8 → 9**, **Prettier 2 → 3** — orthogonal, separate
  cycles.
- **Permission/manifest minimalism beyond the two new ones.** `activeTab` +
  `identity` + `storage` is the floor; no `<all_urls>` host permission, no `tabs`,
  no `cookies`.

## Risks / open questions

- **`firebase/auth/web-extension` API surface drift.** The web-extension entrypoint
  is documented and stable as of 2026-05, but it's a smaller-audience build. If
  Firebase changes its persistence storage default or chrome.storage shape, our
  test mocks may need updating. Bundled into implementation.
- **OAuth client_id key binding.** Chrome ties OAuth client_ids to extension public
  keys. Dev (unpacked) and prod (Web Store) extensions have different keys → can use
  the same OAuth client_id only if both keys are registered in the Google Cloud
  Console for that client. Plan: register both. Fresh worktrees that generate new
  keys frequently are accepted as a one-time per-machine setup cost; doc note in
  development.md.
- **Stale `stateChanged` pushes after panel close.** When the panel closes, the
  iframe is removed but the content script + relay listener remain. SW push still
  arrives; relay forwards to a non-existent iframe via the `if (iframeRef.current)`
  guard — silent no-op.
- **`chrome.tabs.sendMessage` to tabs without a registered listener** errors with
  "Could not establish connection". SW push wraps each send in try/catch and
  removes dead tabIds from its known-tabs set on error. Common case: tabs that
  haven't received the content script (chrome:// pages) or have it but never opened
  the panel (so the relay was never mounted, but the tab might still be in the SW's
  known-tabs set if it sent a `getCurrentUser` once).
- **Build-time secrets in OSS repo.** `.env.local` is gitignored. CI uses repo
  secrets. Contributors who fork the repo need to register their own Firebase
  project + OAuth client_id to test the auth path; both `manifest.ts` and
  `firebase.ts` throw at build with a clear error message rather than silently
  producing a broken extension.

## Verification

After all extension-side commits land (and before webapp commits ship):
- `npm run build` exits 0.
- `npm test` passes with the new broker test cases.
- Loading unpacked still toggles the panel on action click. Iframe URL now contains
  `?surface=extension`. Until the webapp deploys its half, the iframe ignores it
  and the previous direct-Firebase behavior continues.

After webapp commits land (parallel repo):
- 3rd-party-cookie-blocking ON → sign-in flow works on at least two top-level sites.
- DevTools shows the `session` cookie under each top-level origin's partitioned
  storage with the `Partitioned` attribute.
- `chrome.identity` Google sign-in sheet appears (not a popup window) when picking
  Google.

## Out-of-band notes captured during brainstorming

- **Codex was consulted on the auth-backend choice** and recommended the C-variant
  (Firebase canonical + chrome.identity as Google credential adapter). Verified
  against Firebase's `web-extension` documentation and Chrome's identity API
  documentation. Decision aligned.
- **No auto-anonymous bootstrap.** Anonymous remains an explicit choice in the
  webapp's existing sign-in modal. Rationale: avoids inflating the
  anonymous-account population with drive-by extension users who never engage.
- **Operations scope cut.** Upgrade/delete deliberately deferred because webapp
  settings is a new-tab (1st-party) flow. Cycle ③ stays focused on the
  comment-iframe surface.
- **Push payload shape.** `stateChanged` carries `{ currentUser }` not
  `{ currentUser, idToken }` — pushes can race with concurrent token rotations,
  and the webapp pulling on demand is more correct than reconciling out-of-order
  pushed tokens.
