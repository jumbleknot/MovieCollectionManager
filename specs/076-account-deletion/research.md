# Phase 0 research: self-service account deletion

**Feature**: 076-account-deletion · **Date**: 2026-09-24

Every finding below was checked against the tree at `61ba66c9`, not recalled. Where a claim could
not be checked without a running stack it is marked **to verify at implementation** and carries the
command that settles it.

---

## R1 — How re-authentication is forced, and how its strength is determined

**Decision**: Build a server-side authorization URL carrying `prompt=login` and `max_age=0`, exchange
the callback code, and verify `auth_time` on the returned ID token. Do **not** send `acr_values`, and
do **not** add an ACR-to-LoA mapping to the realm.

**Rationale**: FR-007 requires an authentication meeting the identity provider's configured
requirement for a high-privilege action; FR-008 forbids refusing a user who has no second factor.
The stock browser flow already delivers exactly that, and the realm config proves it:

```
browser
 └─ forms ALTERNATIVE
     ├─ auth-username-password-form REQUIRED
     └─ Browser - Conditional 2FA CONDITIONAL
         ├─ conditional-user-configured REQUIRED
         └─ auth-otp-form ALTERNATIVE
```

`conditional-user-configured` is the whole answer. A user with TOTP enrolled is challenged for it; a
user without one is not. `max_age=0` forces a fresh pass through this flow rather than silently
reusing the SSO cookie, so the conditional subflow runs again. The application therefore never
decides the authentication-strength policy — which is what FR-008 demands and what the
constitution's "No Application-Level MFA or CA Implementation" prohibits it from doing.

**Alternatives considered**:

- **`acr_values` with a realm LoA mapping** — rejected. A scan of `dev-realm.json` for `acr`/`loa`
  keys returns nothing at either realm or client level: there is no LoA scheme to request a level
  from. Introducing one is a realm-wide authentication design change affecting every client, not a
  rider on an account-deletion feature. It would also buy nothing here, because the conditional
  subflow already produces the required behaviour.
- **Resource-owner password credentials** — rejected, twice over. `movie-collection-manager` has
  `directAccessGrantsEnabled: false` (only `admin-cli` and the `mcm-bff-test` client have it), so it
  would require weakening the production client; and the constitution prohibits "any in-application
  re-authentication flow that does not redirect through the IdP" and "raw credential checking …
  within the application" outright.

**Consequence for FR-009** ("refuse if the identity provider returns a weaker authentication than
requested"): with `max_age=0` the thing requested is *freshness*, so the check is concretely that
`auth_time` is present, is within the 5-minute window, and is newer than the authentication the
current session was established with. An absent `auth_time` is a refusal, not a pass — a missing
claim must never read as a satisfied one.

**To verify at implementation**: that Keycloak emits `auth_time` and `amr` on the ID token for this
client. Neither is guaranteed by configuration alone.

```bash
# After completing one step-up round trip against the dev stack, decode the ID token:
#   expect: auth_time present and within seconds of now; amr listing the methods performed
```

If `amr` proves absent it changes nothing structural — `auth_time` carries the requirement, and
`amr` is recorded in the audit event as supporting detail only.

---

## R2 — The round-trip shape, and why it is already in the codebase

**Decision**: Model the challenge/callback pair directly on
`frontend/mcm-app/src/app/bff-api/backups/consent+api.ts`, which is the same problem solved once
already for feature 073's standing permission.

**Rationale**: That route establishes five things this feature needs and would otherwise get wrong:

1. **The PKCE verifier never leaves the server.** Only the authorization URL is returned. A verifier
   the browser holds is one an attacker holding the code can also use.
2. **The redirect URI is derived from `new URL(req.url).origin`, not a build-time base URL.** Its
   comment records the measured failure: the same image serves :8082 and :8443 while
   `EXPO_PUBLIC_BFF_BASE_URL` often falls back to :8081, so a fixed base URI sends the browser to a
   port with no BFF on it. Safe against a spoofed `Host` because Keycloak only honours registered
   redirect URIs.
3. **The same URI must be sent on both legs** or the exchange fails `invalid_grant` — so it is
   stashed with the verifier rather than recomputed.
4. **The pending request is keyed by the authenticated user** and taken single-use, so a callback
   can only ever complete the request that same user started.
5. **`state` is compared on the callback** as the CSRF check.

**Alternatives considered**: a bespoke flow — rejected; it would re-derive all five of the above,
and item 2 is a bug that has already been paid for once.

**Divergence from the precedent**: the consent request asks for `scope=openid offline_access` to get
a non-expiring token. This feature must **not**: it asks for `openid` only. It is establishing proof
of presence, not a standing permission, and minting an offline token inside the flow that exists to
destroy one would be perverse.

---

## R3 — Completing the deletion when the client goes away

**Decision**: Perform the whole ordered deletion inside the callback handler. FR-032 is then
satisfied by construction rather than by added machinery.

**Rationale**: The callback is a normal route handler. Once it is entered, the returned promise runs
to completion in the Node process regardless of whether the client is still reading the response;
nothing in the BFF wires `request.signal` into an abort path. A closed tab loses the *response*, not
the work. The user learns the outcome the next time they try to sign in, which FR-033 allows.

This also places the point of no return at the confirmation, which is what the spec's edge case
says it should be.

**Alternatives considered**:

- **A background job queue** — rejected. There is no job runner in the BFF to put it on; the backup
  scheduler is a tick endpoint, not a worker pool. It would also make FR-028 ("MUST NOT report
  partial success") hard to honour, because the response would be sent before the outcome exists.
- **Binding the work to the request lifetime and relying on retry** — rejected by the clarification
  session; it makes partial deletion routine instead of rare.

**Verified, 2026-09-24.** A scan of `frontend/mcm-app/src/bff-server` and
`frontend/mcm-app/src/app/bff-api` for `req.signal`, `request.signal`, `AbortSignal` and
`AbortController` returns exactly one hit: an outbound 5-second timeout in
`agent-config-probes.ts:40`, which bounds a call the BFF *makes* and has nothing to do with the
lifetime of a request the BFF *receives*. No inbound abort plumbing exists, so a handler is not
cancelled when its client disconnects.

---

## R4 — Which identity performs the mc-service deletes

**Decision**: Use the access token minted by the step-up exchange, not the one on the session
cookie. Revoke the step-up refresh token at the end of the operation, on both the success and the
failure path.

**Rationale**: The step-up token is the freshest proof of the user's identity and cannot be expired,
whereas the cookie's token may be close to expiry after a user has spent time at the login form and
a TOTP prompt. `createMcServiceClient(jwt)` takes the raw JWT per instance, so nothing needs to
change to pass a different one.

The constitution requires that after a step-up "the BFF must replace the session's stored tokens
with the new set and explicitly revoke the previous refresh token — step-up is a full
re-authentication, not a token refresh." On the success path the account is destroyed and the point
is moot, but the **failure** path must not leave a second live token set for an account that still
exists. `revokeToken(token, 'refresh_token')` already exists in `keycloak.ts` for this.

**Alternatives considered**: reusing the session cookie's token and discarding the step-up tokens
immediately — rejected; it risks an expiry mid-deletion, in the middle of the one sequence in the
system where a failure part way is most expensive.

---

## R5 — Destroying the user's domain data

**Decision**: The BFF lists the user's collections and issues one `DELETE /api/v1/collections/{id}`
per collection. No mc-service change.

**Rationale**: `GET /api/v1/collections` returns the caller's collections unpaginated — the BFF route
forwards it with no cursor handling, and mc-service's router exposes `get(list_collections)` on `/`
with no pagination parameters. `DELETE /{id}` already removes a collection and its movies inside one
MongoDB transaction, so per-collection atomicity is inherited. DAC is enforced by mc-service's own
layer, so a stray identity cannot reach another user's collection even if the caller got it wrong.

**Alternatives considered**: a new `DELETE /api/v1/users/me/everything` purge endpoint on
mc-service — rejected for this feature. It would be atomic across collections, which is genuinely
better, but it adds a privileged destructive surface to the domain service for one caller, and the
per-collection loop is already retry-safe (a collection that is gone yields 404, which the loop
treats as success). Worth revisiting only if the collection count ever grows enough that partial
progress becomes common.

**Consequence**: deletion is not atomic across collections. A failure part way leaves some
collections destroyed; FR-028 and the spec's edge case already say so plainly, and the retry
completes.

---

## R6 — Deleting the account, and terminating sessions

**Decision**: Add `deleteUser(userId)` to `keycloak.ts`, calling
`DELETE {adminApiBase}/users/{id}` with the service-account admin token. Call the existing
`logoutUserSessions(userId)` before it.

**Rationale**: The `mcm-bff-service` service account already holds
`realm-management: ["view-users", "manage-clients", "manage-users"]`, so no realm change is needed —
`manage-users` covers deletion. `keycloak.ts` currently exports no `deleteUser`; the only one in the
tree is a test helper at `tests/e2e/web/setup/keycloak-admin.ts:222`, which must not be imported by
`src/`.

`logoutUserSessions` is called first because the constitution's Session Invalidation principle
requires terminating the IAM-level SSO session administratively, not merely revoking tokens.
Deleting the user subsumes it, but the deletion can fail, and the ordering means a failure leaves
the user signed out rather than still signed in with half their data gone.

**Alternatives considered**: disabling the account rather than deleting it — rejected; the spec
requires deletion, and a disabled account retains the email address, contradicting FR-025.

---

## R7 — Per-user state that must be destroyed, enumerated from the code

**Decision**: The following are the complete set of user-keyed stores. Each was found by reading the
accessors rather than by recalling them.

| Store | Accessor | Action |
|---|---|---|
| Backup destinations, jobs, runs | `tearDownUserBackups` | Handled wholesale by feature 073's teardown |
| Standing permission | `revokeOfflineToken`, inside the teardown | Revoked at the IdP, then unset |
| Agent config document | `agent-config-store` | **Full `deleteOne`**, not the existing `clear()` |
| Cached user profile | `invalidateUserProfile` | Delete |
| Agent UI snapshot | `setAgentUiSnapshot` / `getAgentUiSnapshot` | Delete |
| Agent import file reference | `clearAgentImportFile` | Existing accessor suffices |
| Pending backup consent request | `takeBackupConsentRequest` | Single-use take |
| Sessions | `terminateAllSessions` | Existing accessor suffices |
| Collections and movies | mc-service | Per-collection delete (R5) |

**The agent config document is an ordering trap.** The standing permission is stored *in that
document* as `offlineRefreshEnc` — `revokeOfflineToken` `$unset`s it there. Deleting the document
before the teardown would destroy the only record of a permission still live at the identity
provider: backlog item #544's failure, reintroduced in a worse form because no user remains to
notice. FR-022 exists for this and the implementation order must honour it.

**Not in the list, with evidence**: agent-gateway LangGraph checkpoints. `agents/movie-assistant/
src/graph.py:579` resolves the checkpointer to `MemorySaver()` — in-process memory, never persisted.
There is no data at rest to purge. Agent thread-owner claims in Redis are keyed by `thread_id`, not
by user, and carry the session's absolute TTL, so they expire on their own and are not enumerable by
user; they hold a userId as a *value*, which FR-024's "no record identifying the user" reading would
otherwise catch. Their TTL bounds the exposure to the session window and they contain no personal
data beyond an opaque identifier.

---

## R8 — Retry-safety of each step

**Decision**: Every step before the account deletion is already idempotent, or is trivially made so.
FR-027 needs no new machinery.

**Rationale**, step by step, from the code:

- `revokeOfflineToken` reads the stored token and `return`s early when there is none — "Nothing
  granted, nothing to revoke — a no-op, not an error." So a retry after a partial failure does not
  throw on the first step.
- `deleteMany({ userId })` on destinations, jobs and runs matches zero documents the second time.
- `deleteOne` on the agent config document likewise.
- The Redis deletes are unconditional.
- `terminateAllSessions` on a user with none is a no-op.
- The mc-service loop must treat a `404` on `DELETE /collections/{id}` as success, not failure —
  this is the one place where retry-safety has to be written rather than inherited.
- `deleteUser` must treat a `404` as success for the same reason.

---

## R9 — Where the UI goes

**Decision**: A new `Account` settings area: one row in the `SETTINGS_AREAS` registry, one route
file, one screen.

**Rationale**: `settings-nav.tsx` states the extension contract explicitly — "Adding an area is one
row plus a route and a screen; no other area changes (SC-006)." The registry is the single source of
truth for the sub-navigation, and the pattern is already proven by four existing areas.

The route carries its own guard. `settings-nav.tsx` is emphatic that filtering a row out is
presentation and never enforcement, citing `openwiki/gotchas/role-enforcement-is-a-layer.md`; the
deletion route's authorization lives in the BFF handler, not in whether the nav row renders.

**Alternatives considered**: putting the danger zone at the bottom of the Profile area — rejected.
It would place an irreversible action on the settings landing screen, and FR-004 requires deletion
not be reachable by a single click from a normal navigation path.

---

## R10 — The mobile path

**Decision**: On web the BFF's challenge response is opened directly. On native the client runs the
authorization request through `expo-auth-session` with the same `prompt=login`/`max_age=0`
parameters and posts the resulting code back, mirroring how `native-auth-callback.tsx` already
splits from the web login path.

**Rationale**: The constitution is explicit that "the BFF cannot redirect a native app — instead it
returns a step-up indicator response, and the mobile client initiates a new OIDC flow." The app
already has this split: `use-keycloak-auth.ts` returns early on native because "the `mcm-app://`
deep link is intercepted by Expo Router, which renders the callback screen … handling it here too
would double-redeem the single-use OAuth code."

**Consequence for PKCE**: on native the verifier is generated client-side by `expo-auth-session`,
so it cannot be held server-side as R2 item 1 requires for web. The server-side pending record
therefore stores only the `state` and the requesting userId on the native path, and the client
supplies the verifier with the code — the same trade the existing native login already makes. The
protections that remain are the `state` match, the single-use take, the userId binding, and the
`auth_time`/`sub` checks on the exchanged ID token, and those are what actually gate the deletion.

**To verify at implementation**: whether the native flow is in scope for the first release at all,
given the Android E2E surface. The web path is the one the acceptance criteria are written against.

---

## R11 — Rate limiting

**Decision**: Apply the existing per-IP limiter to the challenge endpoint.

**Rationale**: The constitution requires rate limits on all endpoints, per IP and per authenticated
user. `rate-limiter.ts` provides `checkLoginRateLimit` and `extractClientIp`, and `cache-service.ts`
provides the generic `incrementRateLimit(endpoint, identifier)` / `getRateLimitCount` pair, so this
is configuration rather than construction. The deletion endpoint is naturally self-limiting — it
succeeds at most once per account — but the *challenge* endpoint is not, and an unlimited challenge
endpoint is a way to spray authorization requests at the identity provider.

---

## Open items carried into the plan

| Item | Why it is not resolved here | Where it lands |
|---|---|---|
| `auth_time` / `amr` emission | Needs a running Keycloak to observe | R1's verification command, run in the first implementation task |
| Native step-up in scope for v1 | A scoping call, not a research question | Raised in the plan's Structure Decision |
