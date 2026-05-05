# Auth broker

The service worker hosts a *thin token vendor* that signs the user into Firebase Auth and hands out ID tokens. The iframe (1st-party `commentarium.app` content, even when embedded as a third party) calls the broker via `chrome.runtime.sendMessage(EXT_ID, …)`, then takes the ID token to its own `/api/login` endpoint where the server sets a `Partitioned` (CHIPS) session cookie. The SW writes no cookies, makes no cross-origin HTTP requests, and the manifest declares no `host_permissions`.

For the design rationale that landed at this shape, see the two posts at the bottom of this doc.

The broker entry point is [src/pages/background/auth.ts](../src/pages/background/auth.ts). It registers exactly one `chrome.runtime.onMessageExternal` listener and dispatches by message `type`.

## Channel & sender gating

The auth channel is **distinct** from the toggle/urlChange relay described in [architecture.md](architecture.md#messaging): different listener (`onMessageExternal` vs `onMessage`), different sender semantics, different security boundary.

Every incoming message is gated on three checks before any handler runs:

1. **Origin** — `sender.origin === "https://commentarium.app"`. Anything else is dropped silently (the listener returns `false`, no response is sent).
2. **Type namespace** — `msg.type` must start with `commentarium.auth.`. Other namespaces are dropped.
3. **Path / surface** — `pathAllowedForType()` enforces:
   - `commentarium.auth.getIdToken` — `sender.url` path must be `/auth/handoff` (the 1st-party handoff page).
   - All other ops — `sender.url` path must be `/comments` AND query param `surface=extension` (the iframe inside the extension panel).

Manifest's `externally_connectable.matches: ["https://commentarium.app/*"]` is the outer fence. The SW does the inner check itself so a future manifest widening can't accidentally expose the broker.

## Op surface

Five ops, dispatched on message `type`:

| Op | Allowed surface | Returns on success | What it does |
|---|---|---|---|
| `commentarium.auth.signIn.anonymous` | iframe | `{ ok: true, idToken }` | `signInAnonymously(auth)` → `currentUser.getIdToken()` |
| `commentarium.auth.signIn.google` | iframe | `{ ok: true, idToken }` | OAuth via `launchWebAuthFlow` (see [Google sign-in flow](#google-sign-in-flow)) → `signInWithCredential` → `currentUser.getIdToken()` |
| `commentarium.auth.refreshSession` | iframe | `{ ok: true, idToken }` | `currentUser.getIdToken(true)` (force refresh) |
| `commentarium.auth.signOut` | iframe | `{ ok: true }` | `firebaseSignOut(auth)` + `chrome.identity.clearAllCachedAuthTokens()` |
| `commentarium.auth.getIdToken` | handoff page | `{ idToken }` | `currentUser.getIdToken(true)` |

Failure shape is always `{ error: { code, message }, signedOut?: true }`. Two response shapes deviate from the leading `ok: true`:

- **`getIdToken`** returns `{ idToken }` directly (no `ok`), reflecting its handoff-vendor semantics.
- **Errors** are `{ error: …, signedOut?: true }`.

The `signedOut: true` arm only appears on the `refreshSession` error path — when `auth.currentUser` is gone or `getIdToken(true)` rejects. The iframe flips its UI to signed-out only when it sees this flag; other error responses are non-terminal.

## Google sign-in flow

The flow uses `chrome.identity.launchWebAuthFlow` with the OAuth 2.0 implicit grant (`response_type=token`). See [From getAuthToken to launchWebAuthFlow](https://zeikar.github.io/blog/from-getauthtoken-to-launchwebauthflow/) for why this primitive replaced `chrome.identity.getAuthToken`.

```
1. state = crypto.randomUUID()
2. Build OAuth URL
   - client_id      = VITE_GOOGLE_OAUTH_WEB_CLIENT_ID
   - redirect_uri   = chrome.identity.getRedirectURL()
   - response_type  = token
   - scope          = openid email profile
   - state          = state
   - prompt         = select_account
3. await chrome.identity.launchWebAuthFlow({ url, interactive: true })
     · Promise rejects if user closes the window  →  auth/popup-closed-by-user
4. parsed = new URL(responseUrl)
     · throws on malformed URL                    →  identity/invalid-redirect-url
5. fragment = URLSearchParams(parsed.hash.slice(1))
6. fragment.state === state ?                     →  no:  identity/state-mismatch
7. fragment.error ?
     · access_denied                              →  auth/popup-closed-by-user
     · anything else                              →  identity/oauth-error
8. fragment.access_token ?                        →  no:  identity/no-access-token
9. GoogleAuthProvider.credential(null, accessToken)
10. signInWithCredential(auth, credential)
11. currentUser.getIdToken()                      →  { ok: true, idToken }
```

State validation runs **before** any other fragment field is read. Both success and error responses echo `state`; gating downstream on it stops a maliciously crafted redirect from smuggling an `error=access_denied` past us as a "user cancelled" signal.

## Error codes

The table below is the contract the iframe consumes. Codes prefixed `auth/` mirror Firebase Auth conventions (the iframe already has UX paths for them via `signInWithPopup`). Codes prefixed `identity/` are extension-specific.

| Code | Surfaced from | Meaning |
|---|---|---|
| `auth/popup-closed-by-user` | `signIn.google` — `launchWebAuthFlow` rejection OR `error=access_denied` in fragment | User cancelled the OAuth flow. Iframe shows cancel-aware copy. |
| `auth/no-current-user` | `signIn.*` post-call check, `refreshSession` (paired with `signedOut: true`), `getIdToken` | Firebase user vanished mid-op or never existed. |
| `auth/internal-error` | Any op when `asAuthError` falls back (thrown error has no `code`) | Generic; the underlying message is preserved. |
| `auth/not-implemented` | Unknown `commentarium.auth.*` type | Iframe / SW version skew; not expected against a current build. |
| `identity/oauth-error` | `signIn.google` — fragment has `error` other than `access_denied` | OAuth provider failure (network, invalid_request, etc.). |
| `identity/state-mismatch` | `signIn.google` — fragment `state` does not match what we generated | Possible CSRF or browser session drift. |
| `identity/no-access-token` | `signIn.google` — fragment has neither `error` nor `access_token` | Malformed Google response; effectively impossible in normal use. |
| `identity/invalid-redirect-url` | `signIn.google` — `new URL(responseUrl)` throws | Defensive guard at the OAuth boundary; impossible in normal use. |
| Any Firebase code | `signIn.anonymous`, `refreshSession`, Firebase calls | Forwarded as-is from the Firebase SDK (e.g. `auth/network-request-failed`). |

## Sign-out and cleanup contract

`signOut` and `refreshSession` (when the user is gone) both run through `performSignOutCleanup`:

```
1. firebaseSignOut(auth)                         — best-effort, captures throw
2. chrome.identity.clearAllCachedAuthTokens()    — best-effort, captures throw
3. If either threw, surface the FIRST captured error.
```

`signOut` surfaces cleanup errors directly — the user explicitly asked to sign out and wants to know if it failed.

`refreshSession` runs cleanup through `performSignOutCleanupBestEffort`, which **swallows** cleanup throws so they cannot suppress the `signedOut: true` signal. The iframe flips its UI to signed-out only when it sees that flag; if a transient `chrome.identity.clearAllCachedAuthTokens` failure escaped, the listener's error path would return plain `{ error }` and the iframe would stay "signed-in" client-side until the next 401.

`chrome.identity.clearAllCachedAuthTokens()` no longer drives the chooser — `prompt=select_account` in the OAuth URL does that. The call is kept as defensive cleanup of any legacy `getAuthToken`-cache state from pre-migration sign-ins.

## Cloud Console setup

The OAuth client is **"Web application"** type in Google Cloud Console (not "Chrome App" — Chrome App clients can't use arbitrary redirect URIs and don't work with `launchWebAuthFlow`).

Authorized redirect URIs must include exactly:

```
https://<EXTENSION_ID>.chromiumapp.org/
```

The trailing slash matters — that's what `chrome.identity.getRedirectURL()` returns when called with no path argument. Mismatch produces `redirect_uri_mismatch` from Google.

The new client_id ships via:

- Local: `.env.local` → `VITE_GOOGLE_OAUTH_WEB_CLIENT_ID`
- CI: GitHub repo Variables → `VITE_GOOGLE_OAUTH_WEB_CLIENT_ID` (sourced by [.github/workflows/build-zip.yml](../.github/workflows/build-zip.yml))

`buildManifest` in [manifest.ts](../manifest.ts) treats this env key as required and fails the build if it's missing.

## Local dev quirk: VITE_EXTENSION_KEY

`VITE_EXTENSION_KEY` (the optional manifest `key` field) does double duty for local unpacked dev:

1. **`runtime.sendMessage` reachability** — the deployed webapp hardcodes the prod EXT_ID. Without pinning, a local unpacked has a random ID and the webapp can't reach it.
2. **OAuth redirect URI matching** — `chrome.identity.getRedirectURL()` derives from the EXT_ID. Cloud Console only authorizes `https://<PROD_EXT_ID>.chromiumapp.org/`. Without pinning, the local redirect won't match and Google rejects with `redirect_uri_mismatch`.

Pinning to the prod public key (via `VITE_EXTENSION_KEY` in `.env.local`) fixes both. The alternative for (2) only — registering a `<DEV_EXT_ID>.chromiumapp.org/` redirect URI alongside the prod one in Cloud Console — works for one-off external contributors but is more friction than pinning for the team's dev machines.

`build:release` scrubs `VITE_EXTENSION_KEY` via `cross-env` so a dev's `.env.local` cannot bake the unpacked-dev key into the released manifest. The Web Store assigns the prod ID itself.

## Background reading

- [Chrome Extension Iframe Auth: From chrome.cookies to CHIPS](https://zeikar.github.io/blog/from-chrome-cookies-to-chips/) — why the SW vends ID tokens instead of writing cookies itself.
- [Chrome Extension OAuth: From getAuthToken to launchWebAuthFlow](https://zeikar.github.io/blog/from-getauthtoken-to-launchwebauthflow/) — why the Google sign-in flow uses `launchWebAuthFlow` for reliable cancel detection.
