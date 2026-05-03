# Auth broker design (cycle ③)

> **Status: Superseded.** This spec was superseded on 2026-05-03 by
> [auth-broker — CHIPS redesign](../../../../commentarium/docs/superpowers/specs/2026-05-03-auth-broker-chips-redesign.md)
> (single source of truth across the webapp + extension repos). The
> `chrome.cookies`-based broker design described here was never publicly
> shipped — Manual E2E surfaced a Chrome `host_permissions` constraint that
> the CHIPS redesign sidesteps by having the server write the partitioned
> cookie via `Set-Cookie: ...; Partitioned`.

**Date:** 2026-05-02
**Status:** Approved (pending spec review)

## Context

Cycle ③ of the three-cycle plan stated in
[2026-05-02-baseline-cleanup-design.md](2026-05-02-baseline-cleanup-design.md):
① baseline cleanup (done) → ② Vite/Vitest upgrade (done) → ③ auth broker (this spec).

The driver is a P0 issue in the companion webapp's review queue. Chrome's storage
partitioning silos iframe cookies per top-level origin, so the existing session
cookie set by `/api/login` (`SameSite=None; Secure`) disappears whenever Chrome
blocks third-party cookies. Confirmed by toggling Chrome's "Block third-party
cookies" off → login restored. Affects every iframed `/comments` view; the
1st-party app at commentarium.app is unaffected.

Cycle ② deliberately seeded Vitest (Vite 6 + Node 22) so this cycle's auth code —
where origin verification and Chrome API contracts are correctness-critical —
would land with real test coverage from day one.

## Decision summary

The architecture went through two iterations under code review. The first draft
brokered Firebase Auth tokens through a content-script ↔ iframe `postMessage`
relay; review found that hostile top-level pages can spoof responses into the
iframe (login CSRF). Pivoted to **Plan D**: the extension writes partitioned
session cookies directly via `chrome.cookies` and the iframe just renders the
webapp as today. The iframe never holds a Firebase Auth instance and never sees
ID tokens. See "Out-of-band notes" for the full path.

| Question | Decision |
|---|---|
| Spec scope | Unified extension+webapp contract spec, lives in extension repo. The webapp side is a private repo and is described via interface contract — no source links into it. |
| Auth backend | Firebase Auth in the extension SW is the canonical session. `chrome.identity.getAuthToken` is the Google credential adapter only. No offscreen documents. |
| Extension UI | Transparent broker. No popup/options page. All sign-in UI stays in the iframed webapp. Action icon click still toggles the panel as today. |
| Auto sign-in | None. Iframe shows the existing webapp sign-in modal when the partitioned session cookie is missing/invalid; user explicitly picks Google or Anonymous. |
| Cookie propagation | Extension SW mints session cookies via `POST /api/login` and writes them via `chrome.cookies.set`. Partition key is resolved per-request via `chrome.cookies.getPartitionKey({ tabId: sender.tab.id, frameId: sender.frameId })` — Chrome computes the correct `topLevelSite` and `hasCrossSiteAncestor` bits, so the SW does not have to second-guess eTLD+1 rules. Cookies are written lazily on the iframe's first `refreshSession` call (no pre-write on action click). |
| Iframe ↔ extension transport | `chrome.runtime.sendMessage(EXT_ID, …)` direct from the webapp (commentarium.app) to the extension service worker, gated by `externally_connectable.matches: ["https://commentarium.app/*"]`. No content-script relay. SW verifies `sender.origin === 'https://commentarium.app'` plus a per-op `sender.url` path check (defense in depth — see "Message protocol"). |
| Broker operations | Four: `signIn.google`, `signIn.anonymous`, `signOut`, `refreshSession`. Plus one (`getIdToken`) used only by the handoff page. No `getCurrentUser` (the partitioned session cookie is the source of truth — webapp pulls `GET /api/login` after a successful `refreshSession`). No `stateChanged` push (webapp pulls on visibility change / focus / 401). |
| Partition registry | SW persists each partition key it has written a cookie to as a separate `chrome.storage.local` entry (`partitionRegistry:<canonical>` → original `partitionKey` object). One key per partition — never a single shared list — to avoid lost-update races on concurrent `refreshSession` calls. The `chrome.cookies` API does not enumerate partitioned cookies on `getAll` without an explicit `partitionKey`, so on sign-out the SW iterates `partitionRegistry:*` keys and calls `remove({ url, name, partitionKey })` for each. |
| Minimum Chrome | 132+ — `chrome.cookies.getPartitionKey` was added in Chrome 132. The earlier draft targeted 119 (the floor for `partitionKey` parameters on `set`/`getAll`/`remove`), but `getPartitionKey` is the only correct way to derive the key in our context. |
| Settings handoff | Iframe synchronously opens `commentarium.app/auth/handoff?next=/settings` in a new tab. The handoff page itself calls `chrome.runtime.sendMessage(EXT_ID, getIdToken)` to fetch a fresh ID token from the SW, then `POST /api/auth/exchange` to mint a 1st-party session cookie + custom token, then `signInWithCustomToken` to establish 1st-party Firebase Auth under the same UID. ID tokens never appear in URLs. |
| Cross-tab consistency | Webapp pulls `GET /api/login` on `visibilitychange`/`focus` plus on every 401. SW signOut clears all partitioned cookies for commentarium.app. Real-time push not provided in cycle ③. |
| Server-side revocation | Cookies don't carry jar provenance over HTTP — the server cannot tell from the request alone whether `session` came from a partitioned or 1st-party cookie jar. The webapp's API client therefore sends `X-Commentarium-Surface: extension` on **all** `/api/*` calls when in extension surface (not just `/api/login`). Server uses the header to choose `auth.verifySessionCookie(cookie, /*checkRevoked*/ true)`. 1st-party requests have no header → existing `checkRevoked: false` performance path. Account deletion propagates on the next iframe API call. |

## Architecture

### Components

**Background service worker** (new module: `src/pages/background/auth.ts`).
Owns the Firebase Auth instance built from `firebase/auth/web-extension`.
Responsibilities:

1. **Sign-in / sign-out**: handle `signIn.google` (`chrome.identity.getAuthToken` →
   `signInWithCredential`), `signIn.anonymous` (`signInAnonymously`), and `signOut`
   from `chrome.runtime.onMessageExternal`.
2. **Mint and write the partitioned session cookie**: after every sign-in or
   `refreshSession`, fetch `POST /api/login` with `Authorization: Bearer
   <idToken>` and `X-Commentarium-Surface: extension`. The webapp returns the
   session cookie value in the response body. SW then calls
   `chrome.cookies.set({ url, name: 'session', value, partitionKey, … })`
   with the partition key resolved from step 3.
3. **Partition key resolution**: every external-message handler reads
   `sender.tab.id` and `sender.frameId` and calls
   `chrome.cookies.getPartitionKey({ tabId, frameId })` to obtain the precise
   key (Chrome computes `topLevelSite` per its eTLD+1 rules and includes the
   `hasCrossSiteAncestor` bit). No tab/site map is maintained — partition is
   resolved per request.
4. **Partition registry**: every successful `chrome.cookies.set` writes one
   `chrome.storage.local` key of the form `partitionRegistry:<canonical>`,
   where `<canonical>` serializes the partition key (e.g.
   `https://example.com|crossSiteAncestor=true`). The stored value is the
   `partitionKey` object itself, so it can be passed back to
   `chrome.cookies.remove` verbatim. **One key per partition** — never a
   single shared list — because read-modify-write on a list is racy under
   concurrent `refreshSession` calls (two tabs refreshing at once can lose
   one another's append). Single-key writes are atomic per
   `chrome.storage.local` API.
5. **Sign-out cleanup**: `signOut(auth)` + `chrome.identity.clearAllCachedAuthTokens()`
   + `chrome.storage.local.get(null)` filtered to keys starting with
   `partitionRegistry:` → for each, `chrome.cookies.remove({ url, name:
   'session', partitionKey: <stored value> })` → bulk
   `chrome.storage.local.remove(keys)` to clear the registry. Direct
   enumeration via `chrome.cookies.getAll` is **not** sufficient — without
   an explicit `partitionKey` it returns only unpartitioned cookies.
6. **Handoff token**: respond to `getIdToken` requests from the
   `/auth/handoff` page with a fresh ID token (via `currentUser.getIdToken(true)`).

**Async-init contract**: every handler `await`s `auth.authStateReady()` before
reading `auth.currentUser`. Firebase's `web-extension` build restores persisted
user from `chrome.storage.local` asynchronously after SW init/restart; reading
`currentUser` before settlement returns `null` for an actually-signed-in user.

Persistence: SW restarts pick up the existing user via Firebase's `web-extension`
build (`chrome.storage.local`).

**Content script** (unchanged). Handles `toggle` / `urlChange` from background as
today. **Not in the auth path.** No new relay module; no postMessage between
iframe and content script for auth.

**Background entry point** (modify: [src/pages/background/index.ts](../../../src/pages/background/index.ts)).
Imports the auth module so its `chrome.runtime.onMessageExternal` listener
registers at SW init. Existing `chrome.action.onClicked` and
`chrome.tabs.onUpdated` listeners are unchanged from cycle ②/① — they only
handle the existing `toggle` / `urlChange` messages. No cookie pre-writing on
panel toggle (the earlier draft tried this, but `getPartitionKey` requires a
`frameId` that does not exist until the iframe loads).

**Iframe wrapper** (modify: [src/pages/content/components/iframe/index.tsx](../../../src/pages/content/components/iframe/index.tsx)).
The existing iframe URL becomes
`https://commentarium.app/comments?url=<encoded>&surface=extension`.
No additional component is mounted — the iframe is wired exactly as today.

**Webapp** (private repo, contract only). Three changes when running at
commentarium.app:

- *Iframe surface* (`?surface=extension`): the webapp does **not** initialize the
  Firebase Auth web SDK. Sign-in / sign-out buttons in the existing modal are
  re-wired to call `chrome.runtime.sendMessage(EXT_ID, …)` directly. After a
  successful sign-in response from the extension, the webapp `router.refresh()`s
  to pick up the partitioned session cookie. The webapp pulls `GET /api/login`
  on `visibilitychange`/`focus` to keep cross-tab UI consistent. The settings
  link is rewired to open the handoff URL in a new tab (synchronous
  `window.open` on click — see "Sequence flows: Settings handoff"). The
  webapp's API client adds `X-Commentarium-Surface: extension` to **every**
  `/api/*` request from this surface so the server can opt the partitioned
  request into `verifySessionCookie(checkRevoked: true)`.
- *Handoff surface* (`/auth/handoff`): a new 1st-party page. Validates the
  `next` query parameter is a same-origin relative path (`^\/[^/]`). Calls
  `chrome.runtime.sendMessage(EXT_ID, getIdToken)` → `POST /api/auth/exchange`
  with `Authorization: Bearer <idToken>` → receives `{ customToken }` and a
  1st-party (unpartitioned) session cookie set in the response → calls
  `signInWithCustomToken(auth, customToken)` to establish 1st-party Firebase
  Auth state under the same UID → `router.replace(next)`.
- *Server*:
  - `POST /api/login` with `X-Commentarium-Surface: extension` header: builds the
    session cookie value as today but, instead of (or in addition to) the
    `Set-Cookie` response header, returns
    `{ session: <cookieValue>, expiresAtSeconds: <number> }` in the response
    body so the extension can write the cookie itself with the right
    partition key. `expiresAtSeconds` is the absolute UNIX timestamp in
    seconds — matches what `chrome.cookies.set({ expirationDate })` expects,
    so the SW passes it through verbatim. Cookie attributes: `SameSite=None;
    Secure; HttpOnly` plus the resolved `partitionKey` (CHIPS — the actual
    write happens client-side via `chrome.cookies.set`).
  - Any other `/api/*` endpoint that authenticates: when `X-Commentarium-Surface:
    extension` is present on the request, use
    `auth.verifySessionCookie(cookie, /*checkRevoked*/ true)`. When absent
    (1st-party), keep `checkRevoked: false` (existing behavior). HTTP requests
    cannot otherwise distinguish partitioned-jar cookies from 1st-party
    cookies; the header is the explicit signal.
  - `POST /api/auth/exchange` (new): verifies the ID token via
    `auth.verifyIdToken`, sets a 1st-party session cookie (`SameSite=None;
    Secure; HttpOnly`, no `Partitioned`), returns
    `{ customToken: await auth.createCustomToken(uid) }`. Replay protection
    (single-use `jti` registry) deferred to cycle ④.
  - (Covered by the `X-Commentarium-Surface` rule above: any endpoint that
    sees the header runs `verifySessionCookie(cookie, true)`. Deleted users
    are rejected on their next API call from the extension surface.)

### File layout (extension repo)

New files:
- `src/pages/background/auth.ts` — message handler + Firebase Auth + chrome.cookies (partition key resolved per request via `chrome.cookies.getPartitionKey({ tabId, frameId })` from `sender.*`)
- `src/pages/background/firebase.ts` — Firebase config from env, `initializeApp` + `getAuth` (the `firebase/auth/web-extension` build's `getAuth` wires the platform's default persistence; `initializeAuth(app)` without an explicit `persistence` arg would degrade to in-memory and break SW-restart user retention)
- `.env.example` — documents required keys
- `src/global.d.ts` augmentation (or new file) for `import.meta.env.VITE_FIREBASE_*` and `VITE_GOOGLE_OAUTH_CLIENT_ID`

Modified:
- [src/pages/background/index.ts](../../../src/pages/background/index.ts) — import the auth module so its `onMessageExternal` listener registers at SW init. Existing `chrome.action.onClicked` and `chrome.tabs.onUpdated` listeners are unchanged.
- [src/pages/content/components/iframe/index.tsx](../../../src/pages/content/components/iframe/index.tsx) — append `&surface=extension` to the iframe URL
- [manifest.ts](../../../manifest.ts) — convert to a `buildManifest(env)` function (see "Manifest & build configuration"); add `identity` + `storage` + `cookies` permissions, `host_permissions: ["https://commentarium.app/*"]`, `oauth2` block, `externally_connectable.matches: ["https://commentarium.app/*"]`
- [vite.config.ts](../../../vite.config.ts) — wrap export in `defineConfig(({ mode }) => …)`, call `loadEnv(mode, process.cwd(), 'VITE_')`, pass env into the manifest plugin
- `package.json` — add `firebase` dep
- `.gitignore` — ensure `.env.local` is ignored (likely already covered)

No content-script files added or modified for auth.

## Message protocol

### Transport

`chrome.runtime.sendMessage(EXT_ID, message, callback)` from the webapp
(`https://commentarium.app/*`) to the extension SW. Allowed by
`externally_connectable.matches`. SW handler:

```ts
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  if (sender.origin !== "https://commentarium.app") return; // gate
  // … dispatch by msg.type, await authStateReady, do the work, sendResponse(…)
  return true; // keep sendResponse alive across await
});
```

The `sender.origin` field is set by Chrome from the actual frame's origin —
hostile top-level pages cannot forge it, and `chrome.runtime` is not exposed
to non-matching origins. This is the threat-model reason the spec moved off
`postMessage`.

The webapp must know the extension ID. Strategy:

- Production: hardcoded constant
  (`hogjejflnephnomijedgfocipidnkemf` — same one the webapp's existing CSRF
  allowlist already references).
- Development: `NEXT_PUBLIC_COMMENTARIUM_EXTENSION_ID` env override on the
  webapp side. Contributors with a fresh dev extension key set this in their
  webapp `.env.local`.

### Operations

All requests have a `type` field. Responses use Chrome's native one-shot pattern
(`sendResponse` callback) — no manual `requestId` correlation.

Per-op `sender.url` allowlist (defense in depth — `externally_connectable.matches`
already gates by origin, but the matches pattern allows the entire commentarium.app
host, and we want the *iframe* and *handoff* surfaces to be the only callers):

| Type | Direction | Request payload | Allowed `sender.url` | Response payload |
|---|---|---|---|---|
| `commentarium.auth.signIn.google` | iframe → SW | `{ type }` | path `/comments` with `surface=extension` query | `{ ok: true }` or `{ error: AuthError }` |
| `commentarium.auth.signIn.anonymous` | iframe → SW | `{ type }` | path `/comments` with `surface=extension` query | `{ ok: true }` or `{ error: AuthError }` |
| `commentarium.auth.signOut` | iframe → SW | `{ type }` | path `/comments` with `surface=extension` query | `{ ok: true }` or `{ error: AuthError }` |
| `commentarium.auth.refreshSession` | iframe → SW | `{ type }` | path `/comments` with `surface=extension` query | `{ ok: true }` or `{ error: AuthError, signedOut?: boolean }` |
| `commentarium.auth.getIdToken` | handoff → SW | `{ type }` | path `/auth/handoff` exactly | `{ idToken: string }` or `{ error: AuthError }` |

A request that fails the path check is dropped silently (no response) — same as
the origin check.

Sign-in / refresh responses do **not** carry the ID token or user object — the
webapp learns success by the partitioned session cookie now being valid (next
`GET /api/login` returns `isLogged: true`). After receiving `{ ok: true }`, the
webapp `router.refresh()` and re-fetches state from the server.

`getIdToken` is the only op that returns a token, and only the handoff page
calls it. No regular iframe flow ever sees an ID token.

### Shapes

```ts
type AuthError = {
  code: string;     // e.g. "auth/popup-closed-by-user", "identity/user-cancelled"
  message: string;  // human-readable
};

type RefreshResponse =
  | { ok: true }
  | { error: AuthError; signedOut: boolean };
```

`signedOut: true` on `refreshSession` errors signals the webapp that the
session was cleared (e.g., the underlying Firebase user was deleted server-side
and `getIdToken(true)` reported it). The webapp then shows the sign-in modal.

## Sequence flows

### Cold start, signed-out

1. User clicks the action icon on any site. Background's
   `chrome.action.onClicked` sends the existing `toggle` message; panel slides
   in. (No cookie work in this listener — all cookie writes happen lazily via
   `refreshSession` from the iframe.)
2. Iframe mounts at
   `commentarium.app/comments?url=<encoded>&surface=extension`.
3. Iframe (the webapp) detects `surface=extension`. Skips Firebase Auth web SDK
   init. Sends `refreshSession` to the SW.
4. SW: `await authStateReady`. No Firebase user → respond
   `{ error: { code: "auth/no-current-user", … }, signedOut: true }`.
5. Webapp shows its existing sign-in modal.

### Sign in (anonymous shown; Google identical except for `signIn.google`)

1. User clicks "Continue Anonymously".
2. Webapp calls
   `chrome.runtime.sendMessage(EXT_ID, { type: "commentarium.auth.signIn.anonymous" })`.
3. SW: validate `sender.origin` and `sender.url` path/query → `await
   authStateReady` → `signInAnonymously(auth)` → Firebase user created.
4. SW: `chrome.cookies.getPartitionKey({ tabId: sender.tab.id, frameId:
   sender.frameId })` → exact partition key for the iframe's storage context.
5. SW: `currentUser.getIdToken()` → fresh ID token.
6. SW: `POST commentarium.app/api/login` with `Authorization: Bearer <token>`
   and `X-Commentarium-Surface: extension`. Server validates, builds session
   cookie value, returns `{ session: <value>, expiresAtSeconds: <unix-seconds> }`
   in body.
7. SW: `chrome.cookies.set({ url: "https://commentarium.app/", name: "session",
   value: session, expirationDate: expiresAtSeconds, secure: true, httpOnly:
   true, sameSite: "no_restriction", partitionKey })`. Write the partition
   key to the registry in `chrome.storage.local` under
   `partitionRegistry:<canonical>` (one key per partition; idempotent if
   already present).
8. SW responds `{ ok: true }`.
9. Webapp `router.refresh()` → re-fetches `GET /api/login` → `isLogged: true` →
   comments view renders.

### Cold start, already signed in, new top-level site (second-site path)

1. User installed the extension and signed in earlier on site X (cookie set in
   site X's partition; partition key recorded in registry).
2. User now visits site Y. Clicks the action icon → existing `toggle` →
   panel slides in → iframe mounts.
3. Iframe sends `refreshSession`.
4. SW: `await authStateReady`. Firebase user exists → resolve partition key
   for this frame via `getPartitionKey` → `currentUser.getIdToken()` →
   `POST /api/login` → `chrome.cookies.set` with the new partition key →
   append to registry. Respond `{ ok: true }`.
5. Webapp `router.refresh()` → comments render. No modal.

The user pays one extra round-trip on the second site (vs. the impossible-but-
desirable "pre-write" approach), but the cookie is set against the actual
browser-computed partition key rather than a guessed top-level site.

### SPA navigation within a tab

`chrome.tabs.onUpdated` forwards `urlChange` to the content script as today —
no auth-side work. If the new URL is a different top-level site, the iframe
will receive the `urlChange` message, reload itself (per the existing
`key={url}` reload pattern in [iframe/index.tsx](../../../src/pages/content/components/iframe/index.tsx#L29)),
and re-send `refreshSession` on its next mount. SW resolves the new partition
key from the now-updated `sender.frameId` context and writes the cookie there.

### 401 → refresh

1. Webapp's API client receives 401 (session cookie expired or rejected by
   `verifySessionCookie(cookie, true)`).
2. Webapp: `chrome.runtime.sendMessage(EXT_ID, { type:
   "commentarium.auth.refreshSession" })`.
3. SW: same path as the second-site flow above —
   `getPartitionKey` → `currentUser.getIdToken(true)` (force refresh, since
   401 hints the underlying user state may have changed).
   - If `getIdToken(true)` succeeds: `POST /api/login` → `chrome.cookies.set`.
     Respond `{ ok: true }`.
   - If `getIdToken(true)` fails because Firebase says the user is gone
     (e.g., deleted server-side): `signOut(auth)` + cookie cleanup (see "Sign
     out" below). Respond `{ error, signedOut: true }`.
4. Webapp retries the original request on `{ ok: true }`, or shows the sign-in
   modal on `signedOut: true`.

### Sign out

1. User clicks sign-out in the iframe.
2. Webapp: `chrome.runtime.sendMessage(EXT_ID, { type:
   "commentarium.auth.signOut" })`.
3. SW: `signOut(auth)` → `chrome.identity.clearAllCachedAuthTokens()` (drops
   Chrome's OAuth-token cache so the next Google sign-in shows the chooser).
4. SW: `chrome.storage.local.get(null)` → filter to keys starting with
   `partitionRegistry:`. For each, `chrome.cookies.remove({ url:
   "https://commentarium.app/", name: "session", partitionKey: <stored
   value> })`. Then `chrome.storage.local.remove(<allRegistryKeys>)` to
   clear the registry. (Direct enumeration via
   `chrome.cookies.getAll({ domain: "commentarium.app" })` is **not**
   sufficient — it returns only unpartitioned cookies by default. The
   registry is the only reliable source of truth for what we wrote.)
5. SW responds `{ ok: true }`.
6. Webapp `router.refresh()` → comments view shows signed-out state.

### Settings handoff

1. User clicks "Settings" inside the iframe. The settings link is wired to a
   handler that calls `window.open('https://commentarium.app/auth/handoff?next=/settings', '_blank')` **synchronously** in the click handler — within the
   user activation, so popup blockers don't fire.
2. New tab loads `/auth/handoff?next=/settings` (1st-party,
   commentarium.app top-level).
3. Handoff page: validate `next` matches `^\/[^/]` (same-origin relative path);
   reject and show error otherwise. (Server-side validation also performed.)
4. Handoff page: `chrome.runtime.sendMessage(EXT_ID, { type:
   "commentarium.auth.getIdToken" })` → `{ idToken }`.
5. Handoff page: `POST /api/auth/exchange` with `Authorization: Bearer
   <idToken>`.
6. Server: `auth.verifyIdToken(idToken)` → set 1st-party session cookie
   (unpartitioned) → return `{ customToken: await auth.createCustomToken(uid) }`.
7. Handoff page: `signInWithCustomToken(auth, customToken)` → 1st-party
   Firebase Auth state established under the same UID (anonymous or Google —
   preserved).
8. Handoff page: `router.replace(next)` (default `/settings` if missing).
9. User lands on `/settings` fully signed in 1st-party. From here the webapp's
   existing `linkWithPopup`, `firebaseUser.delete()`, and reauth flows work
   natively — the extension is not involved.

### Cross-tab consistency

Two tabs both have the panel open on different top-level sites:

- Tab A signs out via `signOut`. SW removes all partitioned cookies for
  commentarium.app.
- Tab B is showing comments cached in webapp memory. Its UI does not change
  until the next API call.
- On the next call (or on `visibilitychange`/`focus`, whichever comes first),
  webapp pulls `GET /api/login` → 401 (cookie removed) → webapp re-renders to
  the signed-in modal.

Server-side deletion (e.g., user deletes account from settings) triggers the
same path: `verifySessionCookie(cookie, true)` rejects on the next call → 401
→ webapp triggers `refreshSession` → SW finds the user is gone → signs out +
clears cookies → webapp shows sign-in modal.

There is no real-time push from SW to iframe in cycle ③. This is a deliberate
simplification — the partitioned-cookie model with revocation checking gives
correct end-state behavior on every API call, and the visibility-change pull
covers the "user switches to a stale tab" case.

## Security model

### `chrome.runtime` channel

`chrome.runtime.sendMessage(EXT_ID, …)` from a page is gated by
`externally_connectable.matches`. Only documents at
`https://commentarium.app/*` can reach our SW. The host top-level page (any
third-party site embedding the extension's panel) cannot:

- Call `chrome.runtime` — its origin doesn't match.
- Intercept the IPC — chrome.runtime is invisible to other contexts.
- Spoof responses — Chrome routes the response back to the calling
  document's specific frame.

The SW additionally verifies (per request, before doing any work):

1. `sender.origin === 'https://commentarium.app'` — guards against a
   misconfigured `externally_connectable` ever accepting a non-commentarium
   origin.
2. `sender.url` matches the per-op allowlist defined in "Message protocol":
   the four iframe ops require the path `/comments` with `surface=extension`
   in the query, and `getIdToken` requires the path `/auth/handoff`. This
   prevents arbitrary commentarium.app pages (e.g., `/about`,
   `/users/:id`) from invoking the broker — only the two surfaces this
   spec defines.
3. `sender.tab.id` and `sender.frameId` exist (i.e., the request came from a
   tab, not from another extension's background context that managed to
   match externally_connectable somehow).

A request that fails any of these is dropped silently — no `sendResponse`
call. The webapp's caller times out and surfaces an error to the user.

### `chrome.cookies` writes

`chrome.cookies.set` requires `cookies` permission and a matching
`host_permissions` entry. We grant only `https://commentarium.app/*` —
narrowest possible. The Web Store install dialog will read this back to the
user as "Read and change your data on commentarium.app".

The partition key is **never computed by us**. We always call
`chrome.cookies.getPartitionKey({ tabId: sender.tab.id, frameId: sender.frameId })`
and use the returned object verbatim. This delegates eTLD+1 resolution and
the `hasCrossSiteAncestor` flag to Chrome, which avoids subtle bugs
(`developer.mozilla.org` registrable suffix, IP-address top-levels, sandboxed
ancestors, etc.) that hand-rolled `new URL(tab.url).origin` would get wrong.
`getPartitionKey` is available since Chrome 132.

The cookie is written with `httpOnly: true; secure: true; sameSite:
"no_restriction"` plus the resolved `partitionKey`. JavaScript on the host
page cannot read it (httpOnly), JavaScript on commentarium.app can't read it
(httpOnly again), and only the matching top-level partition sees it.

Every successful set is recorded in a partition registry kept in
`chrome.storage.local` (deduplicated). On sign-out the registry is the source
of truth for which partitions to clear — `chrome.cookies.getAll` without an
explicit `partitionKey` returns only unpartitioned cookies, so direct
enumeration would miss every partitioned cookie this extension wrote.

### ID-token-only outside the SW

The SW returns Firebase ID tokens only — to the handoff page, never to the
iframe. The Firebase refresh token is never exposed via any message. An
attacker who somehow intercepts the handoff page's network request can
replay the ID token (it's already designed for replay against a Firebase-
verifying server) but cannot mint new tokens after expiry.

The iframe webapp never holds an ID token. Sign-in operations return only
`{ ok: true }`; the webapp infers state from the partitioned session cookie.

### Handoff `next` validation

Both the handoff page (client-side) and `/api/auth/exchange` (server-side)
validate `next` matches `^\/[^/]` — must start with a single `/` followed by
a non-slash character. This rejects:

- Absolute URLs (`https://evil.com/`)
- Protocol-relative URLs (`//evil.com/`)
- Same-origin paths starting with `//` that browsers may interpret as
  protocol-relative

If validation fails, the handoff redirects to `/` with no exchange. No
open-redirect surface.

### chrome.identity OAuth

The Google OAuth client_id is configured in [manifest.ts](../../../manifest.ts)'s
`oauth2` block as a "Chrome App" type client (registered in the Google Cloud
Console for this extension's public key).
`chrome.identity.getAuthToken({ interactive: true })` triggers the native
Chrome sign-in sheet — no popup window, no iframe redirect. The returned
access token is used exactly once per sign-in: built into a
`GoogleAuthProvider.credential` and passed to `signInWithCredential`. The
access token is not persisted by us; only the resulting Firebase ID token
flows through the SW (and out to `/api/login` for the cookie mint). On
sign-out, `chrome.identity.clearAllCachedAuthTokens()` clears Chrome's
OAuth-token cache.

### CSRF / origin allowlist on the webapp

The webapp's existing CSRF middleware allowlists `chrome-extension://<id>` as
a request origin (per the production extension key). The SW's `fetch` to
`/api/login` from the SW context sends origin
`chrome-extension://<id>`, which matches the allowlist. No allowlist changes
needed for this cycle.

`/api/auth/exchange` inherits the same CSRF middleware. Bearer-token
verification is the actual auth check.

### Server-side revocation check

Any endpoint that authenticates via the session cookie inspects the request's
`X-Commentarium-Surface` header. When the value is `extension`, the endpoint
calls `auth.verifySessionCookie(cookie, /*checkRevoked*/ true)`. When the
header is absent (1st-party requests), `checkRevoked: false` is used —
existing behavior, performance preserved. The header — not the cookie itself
— is the explicit signal because HTTP requests cannot otherwise distinguish
partitioned-jar cookies from 1st-party cookies. The `checkRevoked: true`
branch adds one Firebase Admin SDK round-trip per request on the extension
surface; acceptable cost for the surface where deletion propagation matters.

## Manifest & build configuration

### Manifest changes

```ts
minimum_chrome_version: "132",
permissions: ["activeTab", "identity", "storage", "cookies"],
host_permissions: ["https://commentarium.app/*"],
externally_connectable: {
  matches: ["https://commentarium.app/*"],
},
oauth2: {
  client_id: env.VITE_GOOGLE_OAUTH_CLIENT_ID,
  scopes: ["openid", "email", "profile"],
},
```

- `minimum_chrome_version: "132"`: `chrome.cookies.getPartitionKey` was added
  in Chrome 132. Below that the API is undefined and Plan D would fail
  silently (cookies set in the unpartitioned store, invisible to the
  iframe). Manifest declares the floor; older Chrome refuses to install.
- `activeTab`: existing, kept.
- `identity`: required for `chrome.identity.getAuthToken` and
  `chrome.identity.clearAllCachedAuthTokens`.
- `storage`: Firebase Auth's `web-extension` build uses `chrome.storage.local`
  for user persistence; we also use it for the partition registry.
- `cookies` + `host_permissions` for `commentarium.app/*`: required for
  `chrome.cookies.set` / `.getAll` / `.remove` / `.getPartitionKey` against
  cookies on commentarium.app. Narrower than `<all_urls>`.
- `externally_connectable.matches`: allows webapp pages (iframe + handoff
  page) to call `chrome.runtime.sendMessage` directly to the SW.
- `oauth2.client_id`: filled at build time from `VITE_GOOGLE_OAUTH_CLIENT_ID`.

### Vite env loading

Vite does **not** auto-populate `process.env.VITE_*` from `.env*` files at the
config-evaluation stage (only `import.meta.env.*` inside browser code is
auto-wired). [`manifest.ts`](../../../manifest.ts) is imported by
[`vite.config.ts`](../../../vite.config.ts) during config evaluation, so it
cannot rely on `process.env`. Pattern:

```ts
// vite.config.ts
import { defineConfig, loadEnv } from "vite";
import { buildManifest } from "./manifest";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  return {
    plugins: [
      // …existing plugins…
      makeManifestPlugin(buildManifest(env)),
    ],
    // …
  };
});
```

`manifest.ts` exports
`buildManifest(env: Record<string, string>): chrome.runtime.ManifestV3`
instead of a static default export. The function reads required keys from
`env`, throws with a clear message if any are missing (including the OAuth
client_id), and returns the manifest object. The throw is fail-fast —
`npm run build` exits non-zero on missing env.

### Firebase configuration via env

Firebase requires `apiKey`, `authDomain`, `projectId`, `appId` (and optionally
`messagingSenderId`, `storageBucket` — not used here). These values are
public-ish (visible in browser bundles) but project policy prefers env
injection for an OSS repo.

- `.env.example` (new, committed): documents required keys with placeholder
  values.
- `.env.local` (gitignored, dev-only): real values for local testing.
- CI / release builds inject via repo secrets → `VITE_FIREBASE_*` and
  `VITE_GOOGLE_OAUTH_CLIENT_ID`.
- `src/pages/background/firebase.ts` reads `import.meta.env.VITE_FIREBASE_*`
  (this file IS browser/SW code, so the auto-replace works) and initializes
  the Firebase app. Throws with a clear error if any required key is missing.

### `firebase/auth/web-extension` import

Firebase ships an SW-compatible Auth build at `firebase/auth/web-extension`.
The SW imports from there instead of the default `firebase/auth`:

```ts
import {
  getAuth,
  signInAnonymously,
  signInWithCredential,
  signOut,
  GoogleAuthProvider,
} from "firebase/auth/web-extension";
```

`firebase.ts` initializes via `getAuth(app)` — not `initializeAuth(app)`
without deps. `getAuth` is the documented entry point for the
web-extension build and wires the platform's default persistence
(`indexedDBLocalPersistence`, which survives SW restarts on MV3).
`initializeAuth(app)` called without an explicit `persistence` argument
bypasses that default and degrades to in-memory, breaking SW-restart and
browser-restart user retention.

(`onIdTokenChanged` is not imported because we do not push state changes in
cycle ③.)

The default `firebase/auth` entrypoint pulls in browser-only assumptions
(popup, redirect) and breaks under SW.

## Testing strategy

Vitest tests, building on the chrome-runtime mock from cycle ②
([test-utils/vitest.setup.ts](../../../test-utils/vitest.setup.ts)). Existing
mock is extended with `chrome.identity`, `chrome.storage` (incl.
`chrome.storage.local` for the partition registry), `chrome.cookies` (incl.
`getPartitionKey`), `chrome.tabs`, and `chrome.runtime.onMessageExternal`
spies.

1. **Sender-origin gate** — invoke the SW's `onMessageExternal` listener with
   `sender.origin` set to (a) `'https://commentarium.app'`, (b)
   `'https://evil.example'`, (c) `undefined`. Assert only (a) reaches the
   handler body.
2. **Sender-URL path gate** — for each op, invoke with `sender.url` set to
   the matching path (passes) and to a non-matching commentarium.app path
   (e.g., `https://commentarium.app/about`) — assert the non-matching case
   never reaches the per-op body.
3. **`signIn.anonymous` end-to-end** — mock Firebase
   `signInAnonymously` → mock `currentUser.getIdToken` → mock
   `chrome.cookies.getPartitionKey` to return a fixture key → stub
   `fetch('/api/login', …)` returning
   `{ session: 'fixture-cookie', expiresAtSeconds: 1750000000 }` → assert
   `chrome.cookies.set` called with `value: 'fixture-cookie'`,
   `expirationDate: 1750000000`, and `partitionKey` matching the fixture.
   Assert one `chrome.storage.local.set` call with key
   `partitionRegistry:<canonical>` and the partitionKey object as value.
   Response matches `{ ok: true }`.
4. **`signIn.google`** — same as (3) but stubbing `chrome.identity.getAuthToken`
   and `signInWithCredential` instead.
5. **`refreshSession` happy path** — same plumbing as (3) with
   `currentUser.getIdToken(true)` resolving → `/api/login` succeeds → cookie
   set. Response `{ ok: true }`.
6. **`refreshSession` user-gone** — `getIdToken(true)` rejects with
   user-gone error → handler calls `signOut` and cookie cleanup → response
   `{ error, signedOut: true }`.
7. **`signOut` registry-driven cleanup** — pre-populate
   `chrome.storage.local` with three `partitionRegistry:<canonical>` keys
   pointing at distinct partitionKey objects → invoke `signOut` → assert
   `chrome.cookies.remove` called once per entry with the recorded
   `partitionKey`, then a single `chrome.storage.local.remove` call removing
   exactly those three keys, and `chrome.identity.clearAllCachedAuthTokens`
   called.
8. **`getIdToken`** — returns `{ idToken: <fresh> }` on success; rejects with
   `{ error }` if no current user.
9. **`authStateReady` wait** — handler invocation before the mocked
   `authStateReady` resolves blocks, then proceeds correctly when it resolves.

What this does NOT cover (deliberately):
- Real Firebase Auth integration (no live Firebase project in tests).
- Real `chrome.identity.getAuthToken` / `chrome.cookies.set` behavior — Chrome
  enforces partition keys and OAuth flows; our spies model the contract only.
- Webapp-side adapter / handoff page / `/api/auth/exchange` (webapp repo).
- CHIPS cookie behavior (server attribute building; webapp repo).

E2E manual verification:
- Load unpacked, set Chrome 3rd-party cookie blocking ON.
- Visit two different top-level sites (e.g., `example.com` and
  `developer.mozilla.org`).
- Open panel on first; sign in with Google; post a comment.
- DevTools → Application → Cookies: confirm `session` cookie under
  `commentarium.app` partitioned per top-level origin, with `Partitioned`
  attribute.
- Switch to second site → open panel → iframe loads, sends `refreshSession`,
  SW mints partitioned cookie for the new top-level → comments load
  signed-in. Brief "loading" state visible during the round-trip; no
  sign-in modal.
- Reload each tab → still signed in.
- Sign in anonymously inside the iframe, click "Settings" → handoff opens new
  tab → user lands on `/settings` signed in with the **same** anonymous UID
  as inside the iframe (visible in account info), and `linkWithPopup` works
  there.
- Delete account from settings → return to iframe tab → next interaction
  shows sign-in modal (server-side `verifySessionCookie(checkRevoked=true)`
  rejected the cookie → 401 → `refreshSession` → user gone → sign-out).

## Sequencing within cycle ③

The implementation plan (next step, written via the `superpowers:writing-plans`
skill) decides commit splitting. Conceptual work units, in dependency order:

1. **Build/config scaffolding** — env loader pattern in `vite.config.ts`,
   `manifest.ts` → `buildManifest(env)`, new permissions / `oauth2` /
   `externally_connectable` / `host_permissions`, `.env.example`,
   `firebase` dep, `firebase.ts` config module. No behavioral change yet.
2. **SW auth module (sign-in / sign-out / refresh)** — Firebase init,
   `onMessageExternal` handler with sender-origin and per-op `sender.url`
   path gates, four iframe ops (`signIn.google`, `signIn.anonymous`,
   `signOut`, `refreshSession`), partition key resolution via
   `chrome.cookies.getPartitionKey`, partition registry persisted in
   `chrome.storage.local`, registry-driven cookie cleanup on sign-out,
   `clearAllCachedAuthTokens` on sign-out. Unit-tested.
3. **Handoff token op + iframe URL change** — fifth op (`getIdToken`) for the
   handoff page (with `/auth/handoff` path gate), append
   `&surface=extension` to the iframe URL. Unit-tested.
4. **CI** — confirm `npm test` covers the new test files on Node 22 (already
   wired in cycle ②).
5. **Manual E2E checklist** — load unpacked + 3rd-party-cookie-block test +
   second-site bootstrap + handoff happy-path + delete-propagation test.

The webapp repo gets a parallel set of work units, sequenced separately:

- `?surface=extension` detection + suppress Firebase Auth web SDK init in
  iframe surface.
- Sign-in modal: re-route Google / Anonymous buttons to
  `chrome.runtime.sendMessage(EXT_ID, …)`. Sign-out button likewise.
- Webapp client: pull `GET /api/login` on `visibilitychange`/`focus`. On 401
  from any API, send `refreshSession` and retry on `{ ok: true }`, or show
  sign-in modal on `signedOut: true`.
- Settings link in extension surface → synchronous `window.open` on click to
  the handoff URL.
- New `/auth/handoff` page (validate `next`, ask SW for ID token via
  `chrome.runtime`, exchange, signInWithCustomToken, redirect).
- New `/api/auth/exchange` endpoint (verify ID token, set 1st-party session
  cookie, return custom token; validate `next` server-side as well).
- `/api/login` server-side: when `X-Commentarium-Surface: extension` is
  present, return `{ session, expiresAtSeconds }` in the response body so
  the extension can write the cookie via `chrome.cookies.set` with
  `expirationDate: expiresAtSeconds`.
- Webapp API client: when in extension surface, send
  `X-Commentarium-Surface: extension` on **every** `/api/*` request (not
  just `/api/login`).
- Server-side: any endpoint that authenticates via the session cookie reads
  the request's `X-Commentarium-Surface` header; when present, use
  `verifySessionCookie(cookie, /*checkRevoked*/ true)`. Without the header,
  keep the existing `checkRevoked: false` (1st-party performance path).
- Webapp tests for the surface-aware sign-in modal, the handoff page, the
  exchange endpoint, and the surface-aware `/api/login` branch.

End-to-end activation: cycle ③ doesn't ship to users until BOTH repos have
landed their changes and the webapp deploy is live. Until then the
extension's `&surface=extension` URL is ignored by the production webapp
(which doesn't yet read the query) and the existing direct-Firebase path
runs (broken under 3rd-party cookie blocking, as today). The extension can
be merged at any time after its own work is done; user-visible behavior
stays the same until the webapp ships.

## Non-scope (explicit deferrals)

- **Real-time push from SW to iframe.** Webapp pulls on
  `visibilitychange`/`focus`/401 instead. A `runtime.connect` port for live
  push could be added in cycle ④ if telemetry shows the pull-based UX is
  noticeably stale.
- **Sign-out propagation from 1st-party settings to extension surface.**
  Settings sign-out only clears the 1st-party session and Firebase Auth
  state; the extension's Firebase user persists, and so do partitioned
  cookies on other top-level sites. To sign out everywhere from the
  extension, use the iframe's sign-out button. Cycle ④ candidate (would
  require a settings → opener → SW message channel).
- **Single-use replay protection on the handoff endpoint** (server-side
  `jti` registry). Window of exposure for a leaked ID token is small; add
  only if telemetry justifies. Cycle ④ candidate.
- **Storage Access API fallback** (per webapp review #1). The
  `chrome.cookies` partitioned write covers the P0 case; SAA was always
  the secondary recommendation for "if extension bootstrap fails."
  Reconsider only if telemetry shows broker-failure rates above a small
  threshold.
- **Brokered upgrade / delete / reauth in the iframe.** Settled by the
  handoff approach — these happen 1st-party in the settings tab where
  Firebase Auth's full popup flows already work natively. Brokering
  through the extension would duplicate functionality.
- **React 18 → 19**, **ESLint 8 → 9**, **Prettier 2 → 3** — orthogonal,
  separate cycles.
- **Permission/manifest minimalism.** `activeTab` + `identity` + `storage`
  + `cookies` + host_permissions for commentarium.app +
  `externally_connectable` for commentarium.app is the floor. No
  `<all_urls>` host permission, no `tabs`, no `webRequest`.

## Risks / open questions

- **`firebase/auth/web-extension` API surface drift.** The web-extension
  entrypoint is documented and stable as of 2026-05, but it's a smaller-
  audience build. If Firebase changes its persistence-storage default or
  chrome.storage shape, our test mocks may need updating. Bundled into
  implementation.
- **OAuth client_id key binding.** Chrome ties OAuth client_ids to
  extension public keys. Dev (unpacked) and prod (Web Store) extensions
  have different keys → can use the same OAuth client_id only if both keys
  are registered in the Google Cloud Console for that client. Plan:
  register both. Fresh worktrees that generate new keys frequently are
  accepted as a one-time per-machine setup cost; doc note in
  development.md.
- **Cookie partition-key API stability.** `chrome.cookies.getPartitionKey`
  was added in Chrome 132; `partitionKey` parameters on
  `set` / `getAll` / `remove` have been stable since 119. We require 132+
  via `manifest.json` `minimum_chrome_version` so the install simply
  refuses on older Chrome rather than silently degrading to the
  unpartitioned cookie store. The Chrome cookies API has been moving
  fairly fast in this area; if Google adds further partition fields we
  should re-verify our `getPartitionKey` consumers still match the actual
  shape Chrome returns.
- **`externally_connectable` extension-ID coordination.** Webapp must
  hardcode the production extension ID. If the ID ever changes (re-publish
  with new key, or accidental key regeneration), the webapp deploy lags
  the extension deploy and breaks. Mitigate by adding the ID to webapp's
  CI as a check that mirrors the extension's release manifest.
- **Build-time secrets in OSS repo.** `.env.local` is gitignored. CI uses
  repo secrets. Contributors who fork the repo need to register their own
  Firebase project + OAuth client_id to test the auth path; both
  `manifest.ts` (`buildManifest`) and `firebase.ts` throw at build / init
  with a clear error message rather than silently producing a broken
  extension.
- **Partition registry drift.** The registry in `chrome.storage.local` is
  the single source of truth for what we wrote. If a user manually clears
  cookies for commentarium.app via DevTools or browser settings, the
  registry will still list partitions whose cookies are gone. Subsequent
  `chrome.cookies.remove` calls against those entries are silent no-ops
  (Chrome reports no-such-cookie without error), so this drift is
  benign — the registry is always a *superset* of live cookies, never a
  subset. We do not attempt to reconcile.

## Verification

After all extension-side commits land (and before webapp commits ship):
- `npm run build` exits 0.
- `npm test` passes with the new auth test cases.
- Loading unpacked still toggles the panel on action click. Iframe URL
  contains `?surface=extension`. Until the webapp deploys its half, the
  iframe's existing direct-Firebase path runs (broken under 3rd-party
  cookie blocking, as today).

After webapp commits land (parallel repo):
- 3rd-party-cookie-blocking ON → sign-in flow works on at least two
  top-level sites with no friction on the second site.
- DevTools shows the `session` cookie under each top-level origin's
  partitioned storage with the `Partitioned` attribute.
- `chrome.identity` Google sign-in sheet appears (not a popup window) when
  picking Google.
- Iframe-anonymous user → "Settings" → new tab → `/settings` opens
  signed-in with the same UID; `linkWithPopup` upgrade preserves the UID
  and surfaces in account info.
- Delete from settings → return to iframe tab → next interaction shows
  sign-in modal.

## Out-of-band notes captured during brainstorming

- **Codex was consulted on the auth-backend choice** and recommended
  the C-variant (Firebase canonical + chrome.identity as Google credential
  adapter). Verified against Firebase's `web-extension` documentation and
  Chrome's identity API documentation. Decision aligned and preserved
  through Plan D.
- **No auto-anonymous bootstrap.** Anonymous remains an explicit choice in
  the webapp's existing sign-in modal. Rationale: avoids inflating the
  anonymous-account population with drive-by extension users who never
  engage.
- **Pivot to Plan D ("extension as cookie writer").** The first two spec
  drafts brokered Firebase Auth tokens through a content-script ↔ iframe
  `postMessage` relay. Codex review found two structural problems with
  that design:
    1. The iframe's `postMessage` listener is reachable by the hostile
       top-level page, which can read the `requestId` of an outgoing
       request and race a forged response back into the iframe — login
       CSRF.
    2. Async `getIdToken` before `window.open` for handoff trips popup
       blockers because the call is no longer inside the user activation.
  Plan D removes the iframe's role as a token holder entirely: the SW
  writes the partitioned session cookie directly via `chrome.cookies` and
  the iframe just renders the webapp. The threat model collapses (no
  postMessage, no token in iframe, no spoofable channel), the handoff
  becomes synchronous (`window.open` first, handoff page asks SW for
  token), and the broker shrinks from six ops to four (plus a
  handoff-only `getIdToken`). Cost: `cookies` + `host_permissions:
  ["commentarium.app/*"]` permissions, which read as "Read and change
  data on commentarium.app" in the install dialog. Accepted.
- **Codex review feedback addressed inline.** Sender-origin verification
  via `chrome.runtime.onMessageExternal`, `authStateReady` wait,
  `clearAllCachedAuthTokens` on sign-out, Vite `loadEnv` pattern,
  second-site cold-start flow (existing broker user, no partitioned
  cookie yet), `next` validation for handoff,
  `verifySessionCookie(checkRevoked=true)` for delete propagation —
  all incorporated into the relevant sections above.
- **Plan D follow-up review (round 2)**: a second Codex pass on the
  Plan D draft caught four further issues, all addressed inline:
    1. `chrome.cookies.getAll` does not enumerate partitioned cookies by
       default — sign-out cleanup must use a registry of partitions we've
       written to.
    2. Computing `topLevelSite` from `tab.url` is unreliable
       (eTLD+1 rules, `hasCrossSiteAncestor` bit). Use
       `chrome.cookies.getPartitionKey({ tabId, frameId })` and bump
       minimum Chrome to 132.
    3. The previous `Map<tabId, topLevelSite>` was lost on SW restart;
       resolving the partition key per request via `getPartitionKey` (item
       2) eliminates the map entirely.
    4. `getIdToken` was reachable from any commentarium.app page; SW now
       enforces a per-op `sender.url` path allowlist (`/auth/handoff` for
       `getIdToken`, `/comments` with `surface=extension` for the four
       iframe ops).
  Side effect: the SW no longer pre-writes cookies on action click or
  URL change — `getPartitionKey` requires a `frameId` that doesn't exist
  until the iframe loads. Cookie writes happen lazily on the iframe's
  first `refreshSession` call. Costs one extra round-trip on second-site
  cold start; gains correctness against Chrome's actual partition rules.
- **Plan D follow-up review (round 3)**: a third Codex pass caught four
  spec-detail issues, all addressed:
    1. HTTP requests do not tell the server which cookie jar `session` came
       from. Webapp API client now sends `X-Commentarium-Surface: extension`
       on **all** `/api/*` calls (not just `/api/login`); server uses the
       header to opt into `verifySessionCookie(checkRevoked: true)`.
    2. Server response from `/api/login` returns `expiresAtSeconds` (UNIX
       seconds) — matches `chrome.cookies.set({ expirationDate })`
       directly, eliminates the ms/seconds unit ambiguity.
    3. Partition registry stored as one `chrome.storage.local` key per
       partition (`partitionRegistry:<canonical>` → object) instead of a
       single shared list, eliminating lost-update races on concurrent
       `refreshSession` calls.
    4. E2E checklist text updated to reflect the lazy cookie write (was
       describing the abandoned pre-write model).
- **No `stateChanged` push.** Plan D has the partitioned session cookie
  as the source of truth. The webapp pulls `GET /api/login` on
  `visibilitychange`/`focus`/401 to keep cross-tab UI consistent. Real-
  time push is a cycle ④ candidate if pull-based UX is noticeably stale.
