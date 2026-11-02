# Contract: BFF authentication surface after 085

The BFF's public HTTP routes are unchanged in URL and method. What changes is **what
authenticates a request**, **which cookies are set**, and **which failures are distinguishable**.

## Every authenticated route (`requireAuth`)

| Request carries | Result |
|---|---|
| a valid `mcm_session_id` cookie for a live session | authenticated as the session owner. `Authorization` is ignored entirely, even if present (US3 AS-2). |
| no `mcm_session_id` cookie at all — including a request with only `Authorization: Bearer <valid JWT>` | `401 {code: "UNAUTHORIZED"}` (the pre-085 code for "no credential"), in **every** environment (FR-008, FR-009) |
| a session cookie past its absolute lifetime | `401 {code: "SESSION_ABSOLUTE_TIMEOUT"}`, audit `session_expired {reason:"absolute"}` |
| a session cookie idle past the window | `401 {code: "SESSION_IDLE_TIMEOUT"}`, audit `session_expired {reason:"idle"}` |
| only the retired `mcm_access_token` / `mcm_refresh_token` cookies | `401 {code: "UNAUTHORIZED"}`, with `Set-Cookie` clearing all three names (FR-022); beside a stale `mcm_session_id`, `SESSION_NOT_FOUND` |
| a live session whose server-side renewal Keycloak **rejects** | `401 {code: "REFRESH_FAILED"}`. The session is deleted and the cookies are cleared. |
| a live session whose renewal hits a **transient** Keycloak failure | `503 {code: "KEYCLOAK_UNAVAILABLE"}`, `Retry-After: 5`. The session is kept. |
| a concurrent request whose renewal is still in progress past 5 s | `503 {code: "SESSION_RENEWAL_PENDING"}`, `Retry-After: 1`. The session is kept. |
| no reachable session store | `503 {code: "UNKNOWN"}`. There is no fallback. |

Every `401` above clears the auth cookies. No `2xx` sets a token cookie.

## `POST /bff-api/auth/login`

- **Body:** unchanged (`{code, codeVerifier, redirectUri}`).
- **Success `200`:**
  - Body unchanged (`{success, user}`); the `X-Session-Id` header is unchanged.
  - `Set-Cookie: mcm_session_id=<uuid>; HttpOnly; SameSite=Strict[; Secure]; Path=/; Max-Age=<absolute lifetime s>`.
  - `Set-Cookie` lines clearing the two retired token cookies at their original Paths.
  - **Never** a token cookie.

## `POST /bff-api/auth/refresh`

**Request:** the session cookie only. Body and headers carry no session reference.

| Result | Response |
|---|---|
| Success | `200 {success: true, expiresIn}`. Re-sets `mcm_session_id` only. The server-held tokens are renewed. |
| No or unknown session | `401 SESSION_NOT_FOUND` / `SESSION_EXPIRED` (as today) |
| Renewal rejected | `401 REFRESH_FAILED`. Session deleted. |
| Renewed token's `sub` ≠ session owner | `401 SESSION_OWNER_MISMATCH`. Session deleted, no token persisted, audit `session_refresh_owner_mismatch {userId}` (FR-006, FR-007). |
| Transient | `503 KEYCLOAK_UNAVAILABLE`. Session kept. |
| Rate limit | `429` (unchanged, 1 per 30 s per session) |

## `POST /bff-api/auth/logout`

The caller's own session is resolved from the cookie, which is the credential now. For it, the
server:
1. revokes the server-held refresh token at Keycloak;
2. ends the Keycloak SSO sessions (`logoutUserSessions`);
3. deletes both keys;
4. clears the cookies.

Without a live session, it clears the cookies only (unchanged).

## `POST /bff-api/agent/run`, `GET /bff-api/agent/run`, `POST /bff-api/agent/resume`

Run-scoped identity, when token exchange is configured:

| Keycloak token-exchange answer | Response | Gateway called? |
|---|---|---|
| `200` | the run proceeds (unchanged) | yes |
| `400`/`401` with `invalid_token` / `invalid_grant`, or `invalid_request` + `"Invalid token"` (Keycloak 26.5, measured) | `401 {code:"AGENT_IDENTITY_REJECTED"}` | **no** |
| network error, 5 s timeout, `5xx`, or any other `4xx` | `503 {code:"AGENT_IDENTITY_UNAVAILABLE"}`, `Retry-After: 5` | **no** |
| exchange not configured | the run proceeds without a subject token (unchanged, FR-004) | yes |

Log event `agent_identity_refused {action, outcome: "auth"|"transient", status, providerError}` (the OAuth `error` code only), at `warn` for
`auth` and `error` for `transient`. It carries no token and no body.

## `GET /bff-api/auth/init` (redirect registration)

The response is unchanged (`{ok: true}`). Its side effect changes: the per-process "done" mark is
set only when nothing was missing, or when the Keycloak `PUT` answered `2xx`. Any other outcome
logs `warn redirect_uri_registration_failed {action, step, status}` and is retried on the next
call.

## New `AuthErrorCode` values

`AGENT_IDENTITY_REJECTED`, `AGENT_IDENTITY_UNAVAILABLE`, `SESSION_RENEWAL_PENDING`,
`SESSION_OWNER_MISMATCH`.
