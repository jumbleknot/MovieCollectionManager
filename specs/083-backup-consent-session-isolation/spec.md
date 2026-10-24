# Feature Specification: Revoking backup consent must not end the user's sign-in session

**Feature Branch**: `fix/702-backup-consent-session`

**Created**: 2026-10-24

**Status**: Draft

**Input**: Backlog item #702 — "E2E @gate flake: BFF mints the agent subject token from an invalid
session token, then proceeds without identity ('No caller identity')".

## Measured Baseline *(evidence for every claim in this spec)*

### The CI signature has one cause, and it is not a flake

Every app-e2e evidence bundle on the forge (161 of them, runs 3939–5922) was classified by script.
In **every** run where the BFF logged `Agent subject-token exchange failed`, the BFF had logged
`backup_schedule_consent_revoked` **2 min 10 s – 2 min 45 s earlier**: one failed attempt's 150 s
timeout, then the retry. Both clean runs that also revoked (5502, 5639) had no agent test on that
identity afterwards.

| Run | Consent revoked (user) | First exchange failure |
|---|---|---|
| 5618 | 13:16:24.7 (`281ca937`) | 13:18:37.5 |
| 5749 | 03:40:52.4 (`ecceeb2e`) | 03:43:04.3 |
| 5757 | 04:38:09.7 (`de18ec31`) | 04:40:52.3 |
| 5820 | 08:12:05.2 (`7436c20b`) | 08:14:48.6 |
| 5857 | 14:03:12.0 (`62c8739b`) | 14:05:49.8 |
| 5865 | 15:01:42.7 (`a5d2b8a2`) | 15:03:53.5 |
| 5875 | 00:56:49.0 (`2d68fd39`) | 00:59:02.4 |
| 5881 | 03:08:21.5 (`36ec1c9c`) | 03:10:34.1 |
| 5911 | 07:08:38.0 (`0db4367f`) | 07:11:19.6 |
| 5922 | 10:00:46.7 (`42bb9dcc`) | 10:02:59.5 |

In run 5922, the revoking user `42bb9dcc` is the canonical worker-0 identity. Right after the revoke,
the attempt-1 browser got a burst of `auth_failed reason=no_token` (its refresh failed, so its session
cookie was cleared). The retry, on the same worker slot and so the same identity, then logged the five
exchange failures.

**Onset.** The signature first appears in run **3939 (2026-09-24)**, three days after the backups
E2E with real offline consent landed (feature 073, 2026-09-20/21). It also appears in a GREEN run
(3966, 5 exchange failures, absorbed by a retry). Its rate per gate-tier run:

| Window | Gate runs | Runs with the signature |
|---|---|---|
| 09-24 → 09-26 | ~16 | 5 |
| 09-27 → 10-17 | ~49 | 1 (4907) |
| 10-18 → 10-24 | ~40 | 13 |

Green runs publish counts only, so these numbers are lower bounds. The mechanism did not change
between windows. What changes is whether the worker that ran `backups.spec.ts` picks up an agent
spec afterwards. No Keycloak, realm, BFF-session or E2E-identity change sits at either boundary:
Keycloak has been 26.8.0 since 10-03, the realm last changed 10-12, and no spec file was added or
removed between 09-25 and 10-19. The new-host reboot of 10-24 12:13 UTC is irrelevant: the cause is
in Keycloak's session model.

### The Keycloak behaviour, reproduced in isolation

Measured on a throwaway Keycloak 26.8.0 (the CI digest `b0f60d48…`) loaded with the committed
`ci-realm.json`. A user signs in through the browser authorization-code flow (session S). Then, in
the **same cookie jar**, the backup consent round trip runs (`scope=openid offline_access`), and
the resulting offline token is revoked:

| Consent variant | Offline token `sid` | Online token exchange after revoke | Online refresh after revoke |
|---|---|---|---|
| **Today**: login client, same browser session | = S | **400** `invalid_token` | **400** `Session not active` |
| Login client, fresh cookie jar (separate session) | ≠ S | 200 | 200 |
| `prompt=login` on the consent request | = S | **400** | **400** |
| Admin API `DELETE /sessions/{sid}?isOffline=true` instead of `/revoke` | = S | **400** | **400** |
| **Dedicated consent client**, same browser session | = S | **200** | **200** |

The probe's Keycloak event is byte-identical to CI's: `type="TOKEN_EXCHANGE_ERROR",
clientId="agent-subject-token", userId="null", error="invalid_token", reason="subject_token
validation failure"`.

**Root cause.** The consent round trip asks for `offline_access` on the **login** client
(`movie-collection-manager`) in a browser that already holds the user's SSO cookie. Keycloak
attaches the offline grant to the user's **existing** session. Revoking that offline token, by any
API, removes the login client's session from the user session, and so ends the online session too.
The BFF still accepts the user's access token because it validates the JWT locally. But every call
that Keycloak itself must honour now fails: the agent subject-token exchange
(`invalid_token`, so "No caller identity") and the session refresh (`Session not active`, so the
user is signed out).

**This is a production defect, not a test artefact.** In production, a member who disables their
last backup schedule, deletes its job, or has their grant revoked loses assistant identity at once,
and is signed out at their next token refresh.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Turning off scheduled backups leaves me signed in (Priority: P1)

A member who granted scheduled-backup permission and then withdraws it stays signed in, and the
assistant can still act as them.

**Why this priority**: it is a user-visible defect in production, and it is the whole of #702,
which is failing gate-tier runs and holding back deploys.

**Independent Test**: on a live Keycloak, sign a user in through the browser flow. Run the consent
round trip in the same browser session, revoke the grant, then exchange and refresh the user's
original session token.

**Acceptance Scenarios**:

1. **Given** a signed-in member who granted backup consent in the same browser session, **When**
   the grant is revoked (last schedule disabled, job deleted, or account teardown), **Then** the
   member's session token still exchanges for an agent subject token.
2. **Given** the same member, **When** the grant is revoked, **Then** the member's session still
   refreshes.
3. **Given** the same member, **When** the grant is revoked, **Then** Keycloak refuses the offline
   token itself (SC-012 of feature 073 still holds).

### User Story 2 — Backups keep running as the member (Priority: P1)

**Independent Test**: mint an access token from a grant made through the dedicated client and call
mc-service with it.

**Acceptance Scenarios**:

1. **Given** a grant made through the dedicated consent client, **When** an unattended run mints an
   access token, **Then** the token's subject is the member and mc-service accepts its audience.
2. **Given** a grant stored BEFORE this change (minted by the login client), **When** an unattended
   run mints from it or the member revokes it, **Then** both still work, using the login client's
   credentials.

### User Story 3 — Production keeps working until the operator enables the client (Priority: P1)

The live production realm is not re-imported on deploy, so the dedicated client does not exist
there until an operator creates it.

**Acceptance Scenarios**:

1. **Given** `BACKUP_CONSENT_CLIENT_ID` is unset, **When** a member grants, uses or revokes consent,
   **Then** behaviour is exactly today's (the login client), and the BFF logs once that consent
   shares the login client.
2. **Given** `BACKUP_CONSENT_CLIENT_ID` is set, **When** the app's init route runs, **Then** the
   consent redirect URI is registered on that client, as it is on the login client today.

### Edge Cases

- A stored token whose `azp` cannot be read is treated like an unreadable blob: the grant is
  unusable, and the member is told to re-enable the schedule. It never falls back to another identity
  (FR-024 of feature 073).
- `BACKUP_CONSENT_CLIENT_SECRET` unset with the client id set: the login client's secret is used.
  Dev and CI realms give the dedicated client the same secret on purpose (see plan).

## Requirements *(mandatory)*

- **FR-001**: The consent authorization request MUST name the configured backup-consent client.
- **FR-002**: Minting from, and revoking, a stored grant MUST authenticate as the client that the
  grant was issued to, read from the token's `azp` claim.
- **FR-003**: With `BACKUP_CONSENT_CLIENT_ID` unset, the BFF MUST behave exactly as before.
- **FR-004**: The dev and CI realms MUST define the dedicated client. It is confidential, uses the
  standard flow only with PKCE S256, accepts `offline_access` as an optional scope, carries the
  `mc-service-audience` mapper, and has the consent callback redirect URIs. The prod realm template
  MUST define it too, for fresh installs.
- **FR-005**: The CI BFF environment MUST set `BACKUP_CONSENT_CLIENT_ID`, so the gate tier runs the
  fixed path. CI imports its realm fresh every run, so the client always exists there. Dev and
  production realms that already exist are imported `IGNORE_EXISTING` and so lack the client. They
  opt in after creating it in the running realm, with the operator block in
  `docs/runbooks/backups.md`. Setting the variable first would break consent ("client not found").

## Success Criteria *(mandatory)*

- **SC-001**: The new live-Keycloak integration test fails on `main` (exchange 400 after revoke) and
  passes with the fix.
- **SC-002**: The existing offline-token, consent and account-deletion integration suites pass,
  with 0 skipped under `MCM_REQUIRE_LIVE_STACK=1`.
- **SC-003**: The PR's app-e2e run logs zero `Agent subject-token exchange failed` lines.

## Out of Scope

- **Making a failed subject-token mint a hard error** (#702 acceptance criterion 3). With the cause
  removed, the remaining degrade path is no longer reachable from this defect. Changing it alters
  the assistant's behaviour for every mint failure, so it is a separate decision, filed as its own
  item.
- **Creating the client in the live production realm.** That is an operator step, given in the
  runbook and in a backlog item. Until then US3 keeps production on today's behaviour.
