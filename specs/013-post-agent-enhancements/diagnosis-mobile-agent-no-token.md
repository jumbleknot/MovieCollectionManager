# Diagnosis: mobile agent `/run` → 401 `no_token`

**Status:** root cause located in source; final runtime confirmation requires the stable
harness (`.github/workflows/android-e2e.yml`, deliverable (a)). The *fix* is gated on the
auth-model decision (`decision-frontend-auth-model.md`, deliverable (c)).

**Symptom:** on Android, an assistant turn intermittently fails — the BFF logs
`auth_failed reason=no_token` (HTTP 401) for `action=agent_run`, CopilotKit surfaces
`agent_run_failed`, and the dock shows no response. This *looked* like "the movie card won't
render"; the card code is correct (the in-collection card renders 5× when the turn succeeds).

> A prior fix attempt (commit `23f9e56`) was **inert and has been reverted** (`3dfece6`). It
> injected a bearer token from `getAccessToken()`, but `use-login.ts` / `native-auth-callback.tsx`
> store an **empty** access token (`storeTokens('', '', sessionId)`), so `getAccessToken()` returns
> `''` and the injection no-ops. The "success" observed was a fresh session **cookie**, not the fix.

## How mobile auth actually works (as-built)

1. **Login.** `use-login.ts` posts to `/bff-api/auth/login`; the BFF sets three `HttpOnly`
   cookies (`auth.ts` `buildAuthCookies`) and returns the session id in `x-session-id`. The client
   stores **only** `sessionId` in SecureStore (`storeTokens('', '', sessionId)`) — **no raw token
   client-side**. So `getAccessToken()` is always falsy on native.
2. **Regular API calls (axios).** `api-client.ts` runs with `withCredentials: true`; its request
   interceptor adds an `Authorization: Bearer` header **only if `getAccessToken()` is truthy** —
   which it never is on native. So on mobile **axios authenticates purely via the cookies** carried
   by React Native's native networking cookie jar. On a 401 it calls `silentRefresh()` then retries.
3. **Cookie lifetimes (`auth.ts`).**
   - `mcm_access_token`: `HttpOnly; SameSite=Strict; Path=/; Max-Age≈access-token-lifespan (~5 min)`, `Secure` in prod only.
   - `mcm_refresh_token`: same, but `Path=/bff-api/auth/refresh`.
   - `mcm_session_id`: same, `Path=/`, refresh-length Max-Age.
4. **BFF token extraction (`auth.ts` `extractRawToken`).** Tries `Authorization: Bearer` first,
   then the `mcm_access_token` cookie. On mobile only the cookie path is populated.

So the agent route must carry `mcm_access_token` **as a cookie** to authenticate. The access cookie
expires after ~5 min; after that the cookie is no longer sent → `no_token` until a refresh re-sets it.

## Root cause (source-confirmed)

The CopilotKit client does **not** use the regular fetch for `/bff-api/agent/run`. At startup
`assistant-polyfills.ts` calls `@copilotkit/react-native/polyfills`, which **replaces
`global.fetch`** with an XHR-based streaming fetch (`dist/polyfills.mjs` → `installStreamingFetch`).
That polyfill:

```js
const xhr = new XMLHttpRequest();
xhr.open(method, url);
xhr.timeout = 60000;
// … sets request headers from init.headers …
xhr.responseType = "text";
xhr.send(body ?? null);
```

It reads only `init.method`, `init.headers`, `init.body`, `init.signal`. It **never sets
`xhr.withCredentials`** and **ignores `init.credentials`** entirely — even though
`use-assistant.tsx` configures `<CopilotKitProvider credentials="include">`. So the one signal that
is supposed to force credentialed (cookie-bearing) requests is dropped on the floor for every agent
turn.

Two consequences:

- **Cookie delivery on the agent route is implicit and fragile.** Whether the `mcm_access_token`
  cookie rides along now depends solely on React Native's *default* XHR/native-cookie-jar behavior
  for that origin — not on any explicit `credentials`/`withCredentials` contract. (This is also why
  the exact error string we saw mid-investigation — *"completed with status 0 … This may indicate a
  CORS failure, DNS error, or React Native networking issue"* — is literally this polyfill's failure
  branch; that particular instance was Metro having OOM-crashed, i.e. environmental noise.)
- **The refresh-retry can't reliably save it.** `agent-fetch-refresh.ts` retries once on a 401 after
  `silentRefresh()`. But `silentRefresh()` → `token-refresh.doRefresh()` **only POSTs
  `/bff-api/auth/refresh` and returns `true`** — despite its docstring claiming "client stores via
  SecureStore fallback", it stores nothing. So a successful refresh depends on the BFF's `Set-Cookie`
  landing in the *same* native cookie jar the XHR polyfill reads from, with the new access cookie
  then being attached by that same credentials-ignoring XHR. Every link in that chain is implicit.

### Why it sometimes works

A *fresh* login seeds `mcm_access_token` in the cookie jar; within the ~5-minute window the XHR
(by RN default) sends it and the turn authenticates (the in-collection card rendered). The failures
cluster around: (a) the 5-minute access-cookie expiry during a slow/long session, and (b) my
test-harness instability (Metro OOM, repeated `pm clear`/relogin). I could **not** cleanly separate
"real product bug" from "harness artifact" precisely because the Windows-Metro harness kept
collapsing — which is the motivation for deliverable (a).

## The one experiment that settles it (run on harness (a))

On a stable built-APK + Linux-emulator run, with the gateway containerized:

1. Fresh login → immediately run an agent turn → **expect success** (baseline: cookie fresh).
2. Wait out the access-token Max-Age (or set `access-token-lifespan` to ~60 s in the Keycloak test
   realm) → run an agent turn → observe: does the BFF see the cookie?
   - **If `no_token` on the FIRST post-expiry turn but the next axios call (e.g. a list refresh)
     succeeds** → the XHR polyfill is not carrying the cookie / not honoring the refresh — i.e. a
     real product bug in the agent transport.
   - **If the agent turn auto-recovers (401 → silentRefresh → retry 200)** → the chain works and the
     earlier failures were purely harness/expiry artifacts; no code change needed.
3. Instrument `extractRawToken` / the XHR send to log *presence* (never value) of the cookie vs
   Authorization header per request id, to attribute each 401 precisely.

## Candidate fixes (choose after the decision doc (c))

- **A — Bearer model (constitution §Frontend-App 343–344).** Make login store the real access token
  in SecureStore and attach it as `Authorization: Bearer` on the agent fetch (and refresh-persist the
  rotated token). Deterministic, transport-agnostic — does not depend on the XHR polyfill's cookie
  behavior. **Conflicts with §Security line 75** ("Raw tokens must never be sent to the client") →
  needs the (c) ruling.
- **B — Force credentialed agent requests (cookie model).** Keep cookies, but stop relying on the
  polyfill's implicit behavior: wrap/patch the agent transport so the request is unambiguously
  credentialed (e.g. set `withCredentials` on the underlying XHR via a thin patched streaming-fetch,
  or `patch-package` the polyfill to honor `init.credentials`). Also fix `doRefresh()` so a refresh
  is observable to the agent transport. Stays within §Security 75, but depends on RN/native cookie
  semantics and a third-party patch.
- **C — No code change.** If experiment (2) shows auto-recovery, the failures were harness-only;
  document and move on.

Recommendation: do not pick a fix until (a) is green and the experiment attributes the 401. The
fix choice is really the **auth-model decision** in (c), so resolve that first.
