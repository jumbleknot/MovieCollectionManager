# Decision needed: native (Android) client auth model — cookie vs. bearer/SecureStore

**Type:** Constitution conflict requiring a human ruling (per SDD: constitution deviations need
human approval + documented rationale).
**Raised by:** mobile agent `/run` `no_token` investigation (see
`diagnosis-mobile-agent-no-token.md`).
**Decision owner:** Steve.
**Status:** ✅ **RESOLVED — Option A approved (2026-06-12).** Constitution §Frontend App amended
("Client Auth Model (BFF cookie)"); the prior "JWT as Bearer Token" / SecureStore-token rules are
recorded as a superseded deviation. The agent transport was found to already carry the cookie (RN
XHR `withCredentials=true` default) — no transport code change required; the open expiry-recovery
verification moves to the android-e2e harness.

## The conflict

The constitution prescribes two **mutually incompatible** auth models for the client, in two
different sections:

| # | Section | Rule (verbatim intent) |
|---|---|---|
| 1 | §Security — User Authentication (line ~49) | BFF "exposes **only** a secure `HttpOnly`, `SameSite=Strict` cookie containing an **opaque session ID**." |
| 2 | §Security — Server-Side Session Storage (line ~75) | "**Raw tokens must never be sent to the client.**" |
| 3 | §Architecture — Frontend App (line ~302) | "**Prevents Frontend App sensitive information from being stored client-side.**" |
| 4 | §Architecture — Frontend App — Secure Storage (line ~343) | "**Expo SecureStore must be used to encrypt and securely store sensitive key-value pairs** on client device" (gives "refresh token" as the example). |
| 5 | §Architecture — Frontend App — JWT as Bearer Token (line ~344) | "The Frontend App **must include the JWT Access Token in the `Authorization: Bearer` header** for all API requests to Backend Services." |

Rows 1–3 describe a **cookie model** (no raw tokens client-side). Rows 4–5 describe a **bearer /
SecureStore model** (the raw access + refresh tokens live on the device and are attached as headers).
A single client cannot satisfy both: row 5 *requires* the client to hold the access token; rows 2–3
*forbid* it.

## What the code actually does today (as-built)

The native app implements **the cookie model (rows 1–3)**, not the Frontend-App section (rows 4–5):

- `use-login.ts` / `native-auth-callback.tsx` call `storeTokens('', '', sessionId)` — they store the
  **session id only**; the access/refresh tokens are stored as empty strings.
- `session-storage.getAccessToken()` therefore returns `''` on native; the axios `api-client` bearer
  interceptor never fires; auth rides the BFF `HttpOnly` cookies via React Native's native cookie jar.
- So §Frontend-App rows 4–5 are **already a latent deviation** — the app does not store the JWT in
  SecureStore and does not send `Authorization: Bearer`. This predates feature 013; it was simply
  never exercised hard until the agent route (which uses a credentials-ignoring XHR polyfill — see
  the diagnosis) surfaced it.

## Why this blocks a fix

The mobile agent `no_token` fix depends on which model is authoritative:

- **If cookie model wins (rows 1–3):** keep cookies; the fix is to make the agent transport carry
  the cookie reliably (the CopilotKit XHR polyfill ignores `credentials:'include'` and never sets
  `withCredentials`) and to make `token-refresh.doRefresh()` actually re-seed the cookie observably.
  No raw token on the client. (Diagnosis option **B**.)
- **If bearer model wins (rows 4–5):** store the real access token in SecureStore at login + on
  refresh, and attach `Authorization: Bearer` on the agent fetch (and bring axios's already-present
  but dormant bearer path to life). Transport-agnostic and robust; but the device now holds raw
  tokens. (Diagnosis option **A**.)

## Options

### Option A — Ratify the cookie model; treat §Frontend-App 4–5 as the deviation (RECOMMENDED)

Amend §Frontend-App so the native client uses the **same** BFF-cookie model as web: opaque session
via `HttpOnly`/`SameSite=Strict` cookies, **no raw tokens on the device**. Rationale:

- Strongest posture: a compromised/rooted device or a malicious RN module cannot exfiltrate a
  long-lived token from SecureStore, because there isn't one — only an opaque, server-revocable
  session id. This is the whole point of the BFF pattern and §Security 75.
- Smallest blast radius: the app already works this way; only the **agent transport** is fragile.
  Fix is local (diagnosis option B) — no change to login/refresh token custody.
- Keeps the BFF the single token holder (consistent with §Agent Identity Propagation, which already
  keeps "token custody and refresh … with the BFF").
- Cost: depends on React Native's native cookie jar + a third-party (CopilotKit) XHR polyfill that
  currently ignores `credentials`. Mitigation: patch/wrap the agent transport to force credentialed
  requests; add a regression test; pin the polyfill version.

### Option B — Ratify the bearer/SecureStore model; relax §Security 75/§3 for native

Implement §Frontend-App 4–5 as written: store JWTs in SecureStore, send `Authorization: Bearer`.
Rationale: transport-agnostic (no dependency on cookie semantics or the XHR polyfill); aligns with a
common RN pattern; §Security 75 would gain a documented native carve-out (SecureStore is hardware-
backed encryption). Cost: the device holds the access token (and refresh token) → larger attack
surface; refresh-token rotation must be handled client-side and kept in sync with the BFF; weakens
the "BFF is the sole token holder" guarantee. Net: more robust transport, weaker security posture.

### Option C — Split by surface (NOT recommended)

Cookie model for normal API calls, bearer only for the agent route. Rejected: two parallel auth
paths in one client is exactly the "parallel authentication paths … for convenience" the
constitution's **Prohibited Patterns (line ~63)** forbid, and it doubles the maintenance + audit
surface.

## Recommendation

**Option A.** Ratify the cookie model end-to-end (web + native), record §Frontend-App rows 4–5 as a
superseded deviation, and fix the agent transport to carry the cookie reliably. It preserves the
constitution's strongest, most-repeated principle ("raw tokens must never be sent to the client" +
"prevents Frontend App sensitive information from being stored client-side"), matches the as-built
behavior, and scopes the fix to one transport seam instead of the whole auth lifecycle.

## If you choose A, the follow-up work is

1. Confirm on harness (a) whether the agent route actually drops the cookie (the diagnosis
   experiment) — it may already work for real users and only failed under the broken Metro harness.
2. If it genuinely drops it: force credentialed agent requests (wrap/patch the streaming-fetch so
   `withCredentials`/`credentials:'include'` is honored), and fix `doRefresh()` so a refresh is
   observable to that transport. Add a unit + an E2E regression (the agent-search mobile flow on
   harness (a)).
3. Update §Frontend-App in the constitution to the cookie model, with this doc as the rationale.

## If you choose B, the follow-up work is

1. `storeTokens` must persist the real access + refresh tokens (login + `doRefresh`).
2. The agent fetch attaches `Authorization: Bearer getAccessToken()` (the reverted `23f9e56` shape,
   now non-inert) + the axios interceptor's bearer path becomes live.
3. Amend §Security 75 / §Architecture line 302 with a native SecureStore carve-out + rationale.
4. Threat-model the on-device token storage (rotation, logout invalidation, root/jailbreak).
