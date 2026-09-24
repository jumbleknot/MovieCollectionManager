# Implementation Plan: Self-service account deletion

**Branch**: `076-account-deletion` | **Date**: 2026-09-24 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/076-account-deletion/spec.md`

## Summary

A signed-in user deletes their own account from a new Settings → Account area. Confirming starts a
redirect to the identity provider carrying `prompt=login&max_age=0`; the callback verifies
`auth_time` freshness and `sub` identity, then runs one ordered destruction sequence and redirects
to a public "account deleted" page.

The ordering is the design. Feature 073's `tearDownUserBackups` runs **first** — it revokes the
standing permission at Keycloak before deleting anything, and throws without deleting if that
fails. The Keycloak account is deleted **last**, because it is the only irreversible step.
Everything between is idempotent, so a partial failure is completed by a retry.

Almost nothing here is new machinery. The round trip is modelled on `backups/consent+api.ts`, which
solved the same problem for feature 073; the teardown exists; the admin service account already
holds `manage-users`; and `settings-nav.tsx` documents adding an area as "one row plus a route and a
screen". The new code is a deletion pipeline module, two route files, one screen, and one function
in `keycloak.ts`.

## Technical Context

**Language/Version**: TypeScript 5.x (BFF + app), on Node 24. No Rust or Python change.

**Primary Dependencies**: Expo Router (server routes and screens), Tamagui + `@mcm/design-system`
(UI), `mongodb` driver, Redis via `cache-service`, `axios` via `mc-service-client`, Keycloak Admin
REST API.

**Storage**: MongoDB (`user_agent_config`, backup destinations/jobs/runs), Redis (sessions, pending
requests, cached profile, agent scratch state), Keycloak (the account itself).

**Testing**: `node --test` for BFF unit tests; Jest for the app-layer screen tests; the
`tests/integration/` tier against real Mongo/Redis/Keycloak (no mocking — constitution Test Type
Integrity); Playwright for web E2E.

**Target Platform**: Web (primary) and Android. Native step-up differs — see Structure Decision.

**Project Type**: Web application — Expo Router app with an embedded BFF, calling the Rust
mc-service and Keycloak.

**Performance Goals**: SC-009 — under 30 seconds from confirmation for up to 10 collections and
1,000 movies. The cost is dominated by N sequential mc-service deletes, each a Mongo transaction.

**Constraints**: The destruction order in FR-014/FR-015/FR-021/FR-022 is fixed and may not be
reordered. The pipeline must never authenticate to the user's own storage destination (FR-023).

**Scale/Scope**: One user per invocation, at most once per account. ~6 new files, ~4 modified.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design — see bottom.*

| Principle | Status | How this design satisfies it |
|---|---|---|
| **IdP Boundary — Step-Up Authentication** | **PASS** | Re-auth is a redirect to the IdP with `max_age=0`. The BFF never prompts for credentials, never evaluates MFA, and accepts the IdP's determination. The step-up refresh token is explicitly revoked afterwards, as the principle requires. |
| **No Local Credential Stores** | **PASS** | No password reaches the application. ROPC was considered and rejected (research R1). |
| **Prohibited Patterns** — no in-app re-auth that skips the IdP | **PASS** | There is no in-app re-auth path at all. |
| **Authentication / Token Validation** | **PASS** | The step-up ID token goes through the existing `validateJwt` / `validateAtHash` / `decodeJwtPayload` path used by `auth/login`. |
| **Centralized Access Control** | **PASS** | Routes sit behind the existing `requireAuth` wrapper; the pipeline takes an already-authenticated userId and never reads identity from request input. |
| **Deny By Default / Least Privilege** | **PASS** | No new Keycloak role. `manage-users` is already held by `mcm-bff-service`. |
| **Session Management — Session Invalidation** | **PASS** | `terminateAllSessions` plus `logoutUserSessions` (IAM-level), per the v1.0.4 amendment. |
| **CSRF Protection** | **PASS** | `state` matched on the callback; the pending record is single-use and user-keyed. |
| **Rate Limiting** | **PASS** | The challenge endpoint uses the existing per-IP limiter (research R11). |
| **Safe Error Responses** | **PASS** | RFC 9457 problems via `backup-route-support`'s `problem()`; no internals leak (FR-029). |
| **Audit Logging** | **PASS** | FR-035/036/037. Written synchronously before the operation is treated as complete; no credentials, tokens, session ids or personal detail. |
| **Encryption at Rest** | **N/A** | This feature only destroys encrypted material; it creates none. |
| **TDD (NON-NEGOTIABLE)** | **PASS** | Every task pairs a Verify RED with a Verify GREEN, per `docs/templates/feature-test-tasks-template.md`. |
| **Test Type Integrity** | **PASS** | The pipeline's tests are integration tests against real Mongo, Redis and Keycloak. SC-001 is provable only that way — a mocked IdP cannot demonstrate a token is dead. No `jest.mock()` of external clients under `tests/integration/`. |
| **Technology Agnosticism in Specification** | **PASS** | spec.md names no technology; every technology decision is here or in research.md. |
| **Behavior-Descriptive Identifiers** | **PASS** | `account-deletion.ts`, `deleteUser`, `buildStepUpRequest`, `completeAccountDeletion`. Requirement ids appear only in JSDoc. |
| **Nx as universal task runner** | **PASS** | All test and lint invocations go through `pnpm nx`. |

**No violations. Complexity Tracking is empty and omitted.**

## Project Structure

### Documentation (this feature)

```text
specs/076-account-deletion/
├── plan.md              # This file
├── spec.md
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   ├── bff-api.md
│   └── ui-contract.md
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
frontend/mcm-app/
├── src/
│   ├── bff-server/
│   │   ├── account-deletion.ts              # NEW — the ordered pipeline; the feature's core
│   │   ├── account-step-up.ts               # NEW — build the authorize URL, verify the proof
│   │   ├── keycloak.ts                      # MODIFIED — add deleteUser()
│   │   ├── cache-service.ts                 # MODIFIED — park/take the pending deletion request
│   │   ├── agent-config-store.ts            # MODIFIED — add remove() (full delete, not clear())
│   │   └── backup-offline-token.ts          # UNCHANGED — tearDownUserBackups is called, not altered
│   ├── app/
│   │   ├── bff-api/account/
│   │   │   ├── delete-challenge+api.ts      # NEW — POST: begin the round trip
│   │   │   └── delete+api.ts                # NEW — GET callback: verify, then delete
│   │   └── (app)/settings/
│   │       └── account.tsx                  # NEW — thin route
│   ├── screens/settings/
│   │   └── account-settings-screen.tsx      # NEW — the danger zone
│   └── components/settings/
│       └── settings-nav.tsx                 # MODIFIED — one row in SETTINGS_AREAS
└── tests/
    ├── (bff-server/unit-tests/)             # pipeline ordering + abort semantics, injected failures
    ├── integration/
    │   └── account-deletion.integration.test.ts   # NEW — real Mongo/Redis/Keycloak; proves SC-001
    └── e2e/web/
        └── account-deletion.spec.ts         # NEW — the full redirect round trip
```

**Structure Decision**: Everything lands in `frontend/mcm-app`. mc-service is **not** modified —
research R5 chose the BFF-side per-collection delete over a new purge endpoint, so there are no Rust
changes and no new privileged surface on the domain service. `backup-offline-token.ts` is called but
not edited: feature 073's teardown already carries the ordering guarantee this feature depends on,
and changing it would put that guarantee at risk for the caller it was written for.

**Native step-up is deferred to a follow-up, and this needs a decision.** The acceptance criteria
and every success criterion are written against the web path. The constitution requires a different
mechanism on native — the BFF cannot redirect a native app, so the client initiates the flow and the
PKCE verifier is then necessarily client-side (research R10). That is a second flow with its own
tests, and folding it in roughly doubles the surface. This plan implements web. If Android parity is
required within this feature rather than as a follow-up, the task list grows accordingly.

## Implementation notes the task list must preserve

**The destruction order, which is the feature.** Any reordering is a defect even if every step still
runs:

1. `tearDownUserBackups(userId)` — revokes at the IdP first, then drops destinations, jobs, runs.
   Throws on revocation failure having deleted nothing.
2. Collections — list, then `DELETE /api/v1/collections/{id}` each, using the **step-up** access
   token (R4). A `404` counts as success.
3. `user_agent_config` document — full delete. **Only after step 1**: the standing permission lives
   in this document as `offlineRefreshEnc`, so deleting it earlier destroys the record of a token
   still live at Keycloak — backlog item #544 reintroduced, and worse (R7).
4. Redis per-user state — cached profile, agent UI snapshot, agent import file, pending consent.
5. `terminateAllSessions(userId)`, then `logoutUserSessions(userId)`.
6. `deleteUser(userId)` — last, irreversible.
7. Revoke the step-up refresh token; audit; clear auth cookies; redirect.

**Failure at any step aborts and reports "not deleted".** Never a partial success (FR-028).

**The two places retry-safety must be written rather than inherited** (R8): `404` on the
per-collection delete, and `404` on `deleteUser`. Everything else is already idempotent.

**Step-up verification is three checks, all of which must pass**: `sub` equals the session user;
`auth_time` is present and within 5 minutes; the pending record's `state` matches and is consumed
single-use. A missing `auth_time` is a refusal — a missing claim must never read as a satisfied one.

**Never construct a destination driver.** FR-023 forbids authenticating to the user's storage at any
point. `backup-destination-driver.ts` exposes `delete(key)` and `backup-retention.ts` already calls
it; the deletion pipeline must not import either. A lint-visible import check is cheaper than a
review catching it.

## Phase 0 — Research

Complete. See [research.md](research.md): R1 step-up mechanism (and why not `acr_values` or ROPC),
R2 the consent-route precedent, R3 client-disconnect behaviour (verified), R4 which token performs
the mc-service deletes, R5 domain-data deletion, R6 the admin delete, R7 the enumerated per-user
stores and the `offlineRefreshEnc` ordering trap, R8 retry-safety step by step, R9 the settings
area, R10 the native path, R11 rate limiting.

Two items remain open and are named there: whether Keycloak emits `auth_time`/`amr` for this client
(observable only against a running stack; the first implementation task settles it), and whether
native step-up is in scope for v1 (a scoping call, raised above).

## Phase 1 — Design & Contracts

Complete. [data-model.md](data-model.md), [contracts/bff-api.md](contracts/bff-api.md),
[contracts/ui-contract.md](contracts/ui-contract.md), [quickstart.md](quickstart.md).

## Constitution re-check after Phase 1

Re-evaluated against the designed contracts and data model. **Still no violations.** Three points
the design surfaced that were worth re-testing:

- **Audit content vs FR-036.** The audit event must identify the account and the originating
  address. `userId` is an opaque Keycloak identifier, not personal data, and the constitution's
  never-log list names "full PII (names, emails …)" — so `userId` and IP are recorded and the email
  address is not, which is also why FR-031 forbids retaining the address for a notification.
- **The step-up token's lifetime.** Holding a second live token set for the duration of the pipeline
  is a real exposure on the failure path; revoking it in a `finally` (step 7) bounds the window to
  the operation itself and satisfies the constitution's step-up token-replacement rule.
- **Test Type Integrity.** SC-001 cannot be demonstrated by a unit test — proving a token is dead
  requires presenting it to a real Keycloak. The integration test must not mock the IdP, which the
  constitution independently requires of anything under `tests/integration/`.
