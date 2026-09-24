# BFF API contract: account deletion

**Feature**: 076-account-deletion · **Date**: 2026-09-24

Two endpoints under `/bff-api/account/`. Both require an authenticated session; both refuse before
touching any store when they do not have one. Errors are RFC 9457 Problem Details via
`backup-route-support`'s `problem()`, consistent with the rest of the BFF.

---

## `POST /bff-api/account/delete-challenge`

Begin the round trip. Returns the URL to send the user to; destroys nothing.

**Auth**: session cookie, `mc-user` or `mc-admin`.
**Rate limit**: per IP, via the existing limiter (research R11).
**Request body**: none.

### Responses

| Status | Body | When |
|---|---|---|
| `200` | `{ "authorizationUrl": string }` | A pending request was parked and the URL built |
| `401` | problem | No valid session |
| `409` | problem `"You are the only administrator"` | FR-013 — the last `mc-admin` cannot delete themselves |
| `429` | problem | Rate limited |
| `503` | problem | The identity provider's discovery or authorize endpoint is unreachable |

**`200` body carries only the URL.** The PKCE verifier stays server-side — a verifier the browser
holds is one an attacker holding the authorization code can also use. This mirrors
`backups/consent+api.ts` exactly.

**Side effects**: parks a `PendingAccountDeletion` (TTL 300s, see data-model.md §1) and writes
`account_deletion_requested`. Replacing an existing pending request is allowed and simply overwrites
it — a user who abandons and restarts must not be stuck for five minutes.

### The authorization URL

Built server-side from the discovery document, carrying:

```
client_id       = <the app client>
response_type   = code
scope           = openid                 # NOT offline_access — see below
redirect_uri    = {request origin}/bff-api/account/delete
state           = <16 random bytes, base64url>
code_challenge  = S256(codeVerifier)
code_challenge_method = S256
prompt          = login
max_age         = 0
```

**`scope=openid` only, deliberately.** The consent route asks for `offline_access` because it is
establishing a standing permission. This flow is establishing proof of presence, and minting a
non-expiring token inside the flow whose purpose is to destroy one would be perverse.

**`redirect_uri` is derived from `new URL(req.url).origin`**, never a build-time base URL. The
consent route records the measured failure this avoids: the same image serves :8082 and :8443 while
`EXPO_PUBLIC_BFF_BASE_URL` often falls back to :8081, so a fixed base sends the browser to a port
with no BFF on it and the callback never arrives. Safe against a spoofed `Host` because Keycloak
only honours redirect URIs registered on the client — an attacker-forged host yields an unregistered
URI and Keycloak refuses the request outright rather than redirecting anywhere.

**A new redirect URI must be registered on the client.** `ensureClientRedirectUris` already exists
in `keycloak.ts` for exactly this.

---

## `GET /bff-api/account/delete?code={code}&state={state}`

The callback Keycloak redirects the user's browser to. Verifies the proof, then runs the whole
ordered deletion. **This is the destructive endpoint.**

**Auth**: session cookie. Keycloak redirects the user's own browser here, so the cookie is present
and the normal wrapper applies unchanged — the same reasoning the consent callback documents.

### Responses

All responses are **redirects**, not JSON. Keycloak sent the user's *browser* here, so whatever this
returns is what they look at next, and a page of JSON is not an answer to "is my account gone?"

| Status | `Location` | When |
|---|---|---|
| `302` | `/account-deleted` | Deletion completed. Auth cookies cleared on this response. |
| `302` | `/settings/account?error=reauth` | Any step-up check failed (see below) |
| `302` | `/settings/account?error=failed` | A pipeline step threw; the account still exists |
| `302` | `/settings/account?error=expired` | No pending request, or it had expired |

`/account-deleted` is a **public** route — by the time the user reaches it they have no session, so
a guarded route would bounce them to a login screen, which reads as "your deletion failed".

### Verification, before anything is destroyed

All three must pass. Any failure consumes the pending record, writes
`account_deletion_reauth_rejected` with an enumerated `reason`, and destroys nothing.

1. A pending record exists for this authenticated user — else `reason=no_pending`.
2. `state` matches the parked value — else `reason=state_mismatch`.
3. The exchanged ID token satisfies:
   - `sub` equals the session userId — else `reason=subject_mismatch`
   - `auth_time` is **present** — else `reason=missing_auth_time`
   - `auth_time` is within 300s of now **and** greater than `authTimeFloor` — else
     `reason=stale_auth`

**A missing `auth_time` is a refusal, not a pass.** A missing claim must never read as a satisfied
requirement; this is the single check most likely to be written the wrong way round.

### The ordered deletion

Normative order, as in plan.md and data-model.md §3. Steps 1–5 are idempotent; step 6 is not, which
is why it is last.

On any throw: abort, write `account_deletion_failed` with the `step`, redirect with `error=failed`.
Never report partial success (FR-028).

A `finally` revokes the step-up refresh token on both paths, so the failure path does not leave a
second live token set for an account that still exists.

### Idempotency

A second callback with the same `code` finds no pending record (it was consumed) and is refused with
`error=expired`. Keycloak would reject the re-used code anyway; this refuses before reaching it.

---

## Modified existing surface

| Module | Change | Why |
|---|---|---|
| `keycloak.ts` | add `deleteUser(userId)` | `DELETE {adminApiBase}/users/{id}`. **`404` is success.** The service account already holds `manage-users`. |
| `cache-service.ts` | add `setPendingAccountDeletion` / `takePendingAccountDeletion` | Mirrors the backup-consent pair, including single-use take |
| `agent-config-store.ts` | add `remove(userId)` | A full `deleteOne`. The existing `clear()` is not a substitute — it deliberately keeps non-secret settings (FR-018 requires the document go) |

**Not modified**: `backup-offline-token.ts`. `tearDownUserBackups` is called as it stands. Its
ordering guarantee is the precondition this feature depends on; editing it would put that guarantee
at risk for the caller it was written for.

---

## What this contract forbids

- **No destination driver may be constructed** anywhere on this path. `backup-destination-driver.ts`
  exposes `delete(key)` and `backup-retention.ts` already calls it against the user's own storage.
  FR-023 forbids even authenticating there. Neither module may be imported by `account-deletion.ts`.
- **No `DELETE` on `/bff-api/account/delete`.** The destructive operation is reached only by
  completing a step-up round trip; a bare method on the same path would be a way around it.
- **No admin variant.** FR-002: a user may delete only their own account. The userId comes from the
  validated session and never from request input.
