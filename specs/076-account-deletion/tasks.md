---

description: "Task list for feature 076 — self-service account deletion"
---

# Tasks: Self-service account deletion

**Input**: Design documents from `/specs/076-account-deletion/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: REQUIRED. The constitution makes TDD non-negotiable and mandates the Verify RED / Verify
GREEN checkpoint format from `docs/templates/feature-test-tasks-template.md`. Every test task below
carries a Verify RED; every paired implementation task carries a Verify GREEN.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1 / US2 / US3 — setup, foundational and polish tasks carry none

---

## ⚠️ Read before running any test command

**`--testPathPattern` matches the WHOLE PATH, and this worktree is
`/home/coder/worktrees/076-account-deletion`.** A pattern like `--testPathPattern=account` or
`--testPathPattern=account-deletion` therefore matches *every test file in the repository*, runs the
entire suite, and looks like it worked. Anchor every pattern to the filename and end it with `$`:

```bash
# WRONG — matches the worktree directory, runs everything
pnpm nx test mcm-app -- --testPathPattern=account-deletion

# RIGHT — matches the file
pnpm nx test mcm-app -- --testPathPattern='account-deletion\.test\.ts$'
```

**Always read the suite count.** A Verify RED that reports far more suites than the one you are
working on has not filtered anything, and a Verify RED showing **0 failures** means the test is
trivially passing and must be fixed before implementation.

**Integration tiers skip silently.** Set `MCM_REQUIRE_LIVE_STACK=1` so a skip becomes a failure, and
check the skip count. A green run with the suite skipped proves nothing.

---

## Phase 1: Setup

**Purpose**: Settle the one open research item and register the OAuth redirect URI. No feature code.

- [X] T001 Confirm Keycloak emits `auth_time` (and note whether `amr` appears) on the ID token for the `movie-collection-manager` client, following [quickstart.md](quickstart.md) V0, and record the result in [research.md](research.md) R1

  **Type**: Investigation | **Risk**: High — the whole step-up verification rests on this
  **DONE 2026-09-24.** `auth_time` present and fresh on both ID and access tokens. A second probe
  with a control leg proved `max_age=0` re-prompts even when the SSO session is live and would
  otherwise be reused — so a stolen session cannot complete the step-up. `auth_time` advances on
  re-authentication, so the `authTimeFloor` comparison works. **`amr` is ABSENT** and has been
  removed from the design (data-model §2, §4). Full detail in research R1.

- [X] T002 Register the deletion callback redirect URI on the app client via `ensureClientRedirectUris` in `frontend/mcm-app/src/bff-server/keycloak.ts`

  The URI is `{origin}/bff-api/account/delete`, per [contracts/bff-api.md](contracts/bff-api.md).
  Without it Keycloak refuses the authorization request outright — which is also the property that
  makes the origin-derived redirect safe against a spoofed `Host`.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The shared primitives every story needs. The step-up URL builder lives here rather than
in US2 because the designed contract has **no deletion entry point that bypasses it** — the callback
is the only destructive endpoint, so the two cannot be separated.

**⚠️ CRITICAL**: No user story work begins until this phase is complete.

- [X] T003 [P] Write failing tests for `deleteUser` in `frontend/mcm-app/src/bff-server/unit-tests/keycloak-delete-user.test.ts`

  **Scenarios covered**: US1-AC1 (the account no longer exists), FR-027 (retry-safety)
  Covers: a `204` is success; a **`404` is also success** (the account is already gone, so a retry
  must not fail); a `403`/`500` throws.

  **Verify RED**:
  ```bash
  pnpm nx test mcm-app -- --testPathPattern='keycloak-delete-user\.test\.ts$'
  ```
  **Expected RED**: 3 failing — `deleteUser is not a function`

- [X] T004 [P] Implement `deleteUser(userId)` in `frontend/mcm-app/src/bff-server/keycloak.ts`

  **Prerequisite**: T003 verified RED.
  `DELETE {env.keycloakAdminApiBase}/users/{userId}` with the service-account admin token. Treat
  `404` as success. No realm change is needed — `mcm-bff-service` already holds
  `realm-management: manage-users` (research R6). Do **not** import the E2E helper at
  `tests/e2e/web/setup/keycloak-admin.ts`; `src/` must not depend on test code.

  **Verify GREEN**:
  ```bash
  pnpm nx test mcm-app -- --testPathPattern='keycloak-delete-user\.test\.ts$'
  ```
  **Expected GREEN**: 0 failures — `3 passed`

- [X] T005 [P] Write failing tests for the pending-deletion cache pair in `frontend/mcm-app/src/bff-server/unit-tests/pending-account-deletion.test.ts`

  **Scenarios covered**: US2-AC2 (abandoned request), US2-AC4 (proof reused)
  Covers: park then take returns the record; a **second take returns null** (single-use); a 300s TTL
  is set; parking twice overwrites rather than erroring (a user who restarts must not be stuck).

  **Verify RED**:
  ```bash
  pnpm nx test mcm-app -- --testPathPattern='pending-account-deletion\.test\.ts$'
  ```
  **Expected RED**: 4 failing — `setPendingAccountDeletion is not a function`

- [X] T006 [P] Implement `setPendingAccountDeletion` / `takePendingAccountDeletion` in `frontend/mcm-app/src/bff-server/cache-service.ts`

  **Prerequisite**: T005 verified RED.
  Key `account:delete:pending:{userId}`, TTL 300s, single-use take. Mirror the existing
  `setBackupConsentRequest` / `takeBackupConsentRequest` pair — same shape, same guarantees
  ([data-model.md](data-model.md) §1).

  **Verify GREEN**: same command as T005 | **Expected GREEN**: `4 passed`

- [X] T007 [P] Write failing tests for full agent-config removal in `frontend/mcm-app/src/bff-server/unit-tests/agent-config-remove.test.ts`

  **Scenarios covered**: US1-AC1 (assistant configuration destroyed)
  Covers: `remove(userId)` deletes the whole document; removing a non-existent document is a no-op,
  not an error. Assert explicitly that `remove` is **not** `clear` — `clear()` deliberately keeps
  non-secret settings, and FR-018 requires the document to go.

  **Verify RED**:
  ```bash
  pnpm nx test mcm-app -- --testPathPattern='agent-config-remove\.test\.ts$'
  ```
  **Expected RED**: 2 failing — `remove is not a function`

- [X] T008 [P] Implement `remove(userId)` in `frontend/mcm-app/src/bff-server/agent-config-store.ts`

  **Prerequisite**: T007 verified RED.
  A `deleteOne({ _id: userId })`. Leave `clear()` untouched — it has its own caller and its own
  meaning.

  **Verify GREEN**: same command as T007 | **Expected GREEN**: `2 passed`

- [X] T009 Write failing tests for the step-up authorization URL in `frontend/mcm-app/src/bff-server/unit-tests/account-step-up-request.test.ts`

  **Scenarios covered**: US2-AC1 (re-authentication is required)
  Covers: the URL carries `prompt=login`, `max_age=0`, `code_challenge_method=S256`; **`scope` is
  `openid` and does not contain `offline_access`**; `redirect_uri` is derived from the request
  origin, not a build-time base URL; the returned object exposes the URL but the **verifier is not
  in the URL**.

  **Verify RED**:
  ```bash
  pnpm nx test mcm-app -- --testPathPattern='account-step-up-request\.test\.ts$'
  ```
  **Expected RED**: 5 failing — `Cannot find module '@/bff-server/account-step-up'`

- [X] T010 Implement `buildStepUpRequest(redirectUri)` in `frontend/mcm-app/src/bff-server/account-step-up.ts`

  **Prerequisite**: T009 verified RED.
  Model on `buildConsentRequest` in `backup-offline-token.ts`, with two deliberate differences:
  `scope=openid` only (minting an offline token inside the flow that destroys one would be perverse)
  and `prompt=login&max_age=0` added (research R2).

  **Verify GREEN**: same command as T009 | **Expected GREEN**: `5 passed`

**Checkpoint**: primitives exist. User story work can begin.

---

## Phase 3: User Story 1 — Delete my account and everything this system holds for me (Priority: P1) 🎯 MVP

**Goal**: A confirmed deletion destroys everything in the ordered sequence and the account is gone.

**Independent test**: Create an account with collections, a destination and a schedule; delete it;
confirm from outside the application that the standing permission no longer works and the account
cannot sign in.

**⚠️ This story must not reach a deployed environment without US2.** The callback is the only
destructive endpoint and US2 supplies its refusal paths; merging US1 alone would expose a deletion
whose identity checks are not yet written.

- [X] T011 [US1] Write failing unit tests for the deletion pipeline's ORDER in `frontend/mcm-app/src/bff-server/unit-tests/account-deletion-order.test.ts`

  **Scenarios covered**: US1-AC1, US1-AC2, US3-AC1
  With every collaborator stubbed and recording call order, assert the sequence is exactly:
  teardown → collections → agent config → Redis state → sessions → IdP logout → account delete →
  step-up token revoke. Assert specifically that **the agent config document is deleted after the
  teardown**, because the standing permission lives inside it as `offlineRefreshEnc` and deleting it
  first would strand a live token ([data-model.md](data-model.md) §3).

  **Verify RED**:
  ```bash
  pnpm nx test mcm-app -- --testPathPattern='account-deletion-order\.test\.ts$'
  ```
  **Expected RED**: 8 failing — `Cannot find module '@/bff-server/account-deletion'`

- [X] T012 [US1] Implement the pipeline in `frontend/mcm-app/src/bff-server/account-deletion.ts`

  **Prerequisite**: T011 verified RED.
  The seven ordered steps from [plan.md](plan.md). Calls `tearDownUserBackups` unchanged. Uses the
  step-up access token for the mc-service deletes (research R4). Revokes the step-up refresh token
  in a `finally`, on both paths.

  **Verify GREEN**: same command as T011 | **Expected GREEN**: `8 passed`

- [X] T013 [US1] Write a failing test asserting the pipeline never reaches the user's storage, in `frontend/mcm-app/src/bff-server/unit-tests/account-deletion-no-driver.test.ts`

  **Scenarios covered**: US1-AC3 (artifacts untouched), FR-023
  A static import assertion: `account-deletion.ts` must not import `backup-destination-driver` or
  `backup-retention`. Cheap to pin, and FR-023 is the requirement most likely to be broken by a
  well-meaning later edit that "finishes the cleanup".

  **Verify RED**:
  ```bash
  pnpm nx test mcm-app -- --testPathPattern='account-deletion-no-driver\.test\.ts$'
  ```
  **Expected RED**: 1 failing — module under test does not exist yet

- [X] T014 [US1] Confirm the import guard passes against the T012 implementation

  **Prerequisite**: T012, T013.
  **DONE.** Passed on arrival — 8 assertions, never RED, because T012 was written first and
  already avoided the imports. That is by design for this pair (T014 says "confirm", not
  "implement"): it pins a negative property as a regression guard rather than driving code.

  **Verify GREEN**: same command as T013 | **Expected GREEN**: `1 passed`

- [X] T015 [US1] Write failing tests for the challenge route in `frontend/mcm-app/tests/integration/account-delete-challenge.integration.test.ts`

  **Scenarios covered**: US1-AC1 (entry point), US2-AC1, FR-002
  Covers: `401` without a session; `200` with `{ authorizationUrl }`; a pending record is parked;
  `account_deletion_requested` is audited; **the response body contains no `codeVerifier`**.

  Also pin FR-002: assert the parked record's userId comes from the validated session and that no
  request field can influence it. The design makes deleting another user's account structurally
  impossible — there is no parameter for it — and this assertion is what keeps it that way when
  someone later adds one.

  **Verify RED**:
  ```bash
  MCM_REQUIRE_LIVE_STACK=1 pnpm nx test:integration mcm-app -- --testPathPattern='account-delete-challenge\.integration\.test\.ts$'
  ```
  **Expected RED**: 5 failing — route returns 404

- [X] T016 [US1] Implement `frontend/mcm-app/src/app/bff-api/account/delete-challenge+api.ts`

  **Prerequisite**: T015 verified RED.
  Per [contracts/bff-api.md](contracts/bff-api.md). Origin-derived redirect URI; park the pending
  record with `authTimeFloor` from the current session.

  **Verify GREEN**: same command as T015 | **Expected GREEN**: `5 passed`

- [X] T017 [US1] Write a failing test for the callback happy path in `frontend/mcm-app/tests/integration/account-delete-callback.integration.test.ts`

  **Scenarios covered**: US1-AC1, US1-AC4, US1-AC5, US1-AC6
  A valid callback returns `302` to `/account-deleted`, clears the auth cookies, destroys every
  store, terminates sessions, and audits `account_deletion_completed`.

  **Verify RED**:
  ```bash
  MCM_REQUIRE_LIVE_STACK=1 pnpm nx test:integration mcm-app -- --testPathPattern='account-delete-callback\.integration\.test\.ts$'
  ```
  **Expected RED**: 6 failing — route returns 404

- [X] T018 [US1] Implement `frontend/mcm-app/src/app/bff-api/account/delete+api.ts`

  **Prerequisite**: T017 verified RED.
  Verify, then run the pipeline, then redirect. All outcomes are redirects, never JSON — Keycloak
  sent the user's *browser* here.

  **Verify GREEN**: same command as T017 | **Expected GREEN**: `6 passed`

- [X] T019 [US1] Write the failing test that closes backlog item #544, in `frontend/mcm-app/tests/integration/account-deletion.integration.test.ts`

  **Scenarios covered**: US1-AC2 (SC-001, SC-002, SC-004, SC-009) — **this is the test the feature exists for**
  Capture the stored refresh token before deletion; after deletion, **present it to Keycloak and
  require rejection** (SC-001). A local `$unset` is explicitly not evidence — that is the exact
  failure mode item #544 describes. Also assert sign-in fails (SC-002) and no store returns anything
  for the userId (SC-004). Real Keycloak, no mocking — the constitution forbids it in this tier and
  a mocked IdP cannot demonstrate a token is dead.

  Assert elapsed time from confirmation to completion is under 30 seconds at this fixture size
  (SC-009) — the per-collection loop is sequential, so this is what degrades first if the loop ever
  gains a round trip.

  **Verify RED**:
  ```bash
  MCM_REQUIRE_LIVE_STACK=1 pnpm nx test:integration mcm-app -- --testPathPattern='account-deletion\.integration\.test\.ts$'
  ```
  **Expected RED**: 4 failing — the refresh token is still accepted by Keycloak

- [X] T020 [US1] Confirm SC-001 passes against the T012/T018 implementation

  **Prerequisite**: T012, T018, T019.
  **Verify GREEN**: same command as T019 | **Expected GREEN**: `4 passed`, skip count 0

- [X] T021 [US1] Write a failing test that the user's artifacts survive, in the same integration file

  **Scenarios covered**: US1-AC3 (SC-003)
  Write real artifacts to a destination, delete the account, then list the destination and assert
  the same object count and the same contents.

  **Verify RED**:
  ```bash
  MCM_REQUIRE_LIVE_STACK=1 pnpm nx test:integration mcm-app -- --testPathPattern='account-deletion\.integration\.test\.ts$' -t 'artifacts'
  ```
  **Expected RED**: 1 failing — destination not yet reachable from the test fixture

- [X] T022 [US1] Confirm artifacts are untouched | **Verify GREEN**: same as T021 | **Expected GREEN**: `1 passed`

- [X] T023 [P] [US1] Write failing screen tests in `frontend/mcm-app/src/screens/settings/account-settings-screen.test.tsx`

  **Scenarios covered**: US1-AC1, FR-003, FR-004
  Covers: the danger zone renders; the dialog lists **both** what is destroyed and what is not; the
  dialog's default control is Cancel; deletion takes two deliberate acts; each `?error=` value
  renders its message and every message says the account was **not** deleted.

  **Verify RED**:
  ```bash
  pnpm nx test mcm-app -- --testPathPattern='account-settings-screen\.test\.tsx$'
  ```
  **Expected RED**: 6 failing — component does not exist

- [X] T024 [US1] Implement the screen, route and nav row

  **Prerequisite**: T023 verified RED.
  `frontend/mcm-app/src/screens/settings/account-settings-screen.tsx` (content),
  `frontend/mcm-app/src/app/(app)/settings/account.tsx` (thin route — routes never define screen
  components), and one row in `SETTINGS_AREAS` in
  `frontend/mcm-app/src/components/settings/settings-nav.tsx`. testIDs exactly as
  [contracts/ui-contract.md](contracts/ui-contract.md) §2 lists them.

  **Verify GREEN**: same command as T023 | **Expected GREEN**: `6 passed`

- [X] T025 [P] [US1] Add the public `/account-deleted` screen and its test in `frontend/mcm-app/src/app/account-deleted.tsx`

  **Must be a public route.** The user has no session when they arrive, so a guarded route bounces
  them to login — which reads as "your deletion failed".

  **Verify GREEN**:
  ```bash
  pnpm nx test mcm-app -- --testPathPattern='account-deleted'
  ```
  **Expected GREEN**: `2 passed`


> **Deviation, T015/T017.** The task list placed these under `tests/integration/`, but they mock
> `requireAuth` and the stores — which makes them unit tests, and the constitution forbids mocking
> the dependency under test inside `tests/integration/`. They live at
> `src/bff-server/unit-tests/account-delete-routes.test.ts` instead. The real-Keycloak proof
> (T019/T020) is unaffected and remains a true integration test.

**Checkpoint**: deletion works end to end on the happy path. Not yet safe to deploy — US2 next.

---

## Phase 4: User Story 2 — Prove it is me before anything is destroyed (Priority: P2)

**Goal**: No deletion proceeds without a fresh, matching, single-use authentication.

**Independent test**: Submit a deletion carrying a stale, mismatched, absent or replayed proof and
confirm each is refused with nothing destroyed.

- [X] T026 [US2] Write failing tests for every refusal path in `frontend/mcm-app/src/bff-server/unit-tests/account-step-up-verify.test.ts`

  **Scenarios covered**: US2-AC1 through US2-AC5, US2-AC8 (SC-007)
  One case per enumerated `reason`: `no_pending`, `state_mismatch`, `subject_mismatch`,
  `stale_auth`, `missing_auth_time`. Plus: a failed verification **still consumes** the pending
  record, so a bad proof cannot be retried against it.

  **Write the `missing_auth_time` case first.** It is the check most likely to be implemented the
  wrong way round, and the one whose failure is silent — a missing claim must never read as a
  satisfied requirement.

  **Verify RED**:
  ```bash
  pnpm nx test mcm-app -- --testPathPattern='account-step-up-verify\.test\.ts$'
  ```
  **Expected RED**: 6 failing — `verifyStepUpProof is not a function`

- [X] T027 [US2] Implement `verifyStepUpProof` in `frontend/mcm-app/src/bff-server/account-step-up.ts`

  **Prerequisite**: T026 verified RED.
  Three checks, all must pass: `sub` equals the session user; `auth_time` present, within 300s, and
  greater than `authTimeFloor`; `state` matches and is consumed. Reuse the existing `validateJwt` /
  `validateAtHash` path from `auth/login` rather than hand-rolling token validation.

  **Verify GREEN**: same command as T026 | **Expected GREEN**: `6 passed`

- [X] T028 [US2] Write a failing test that nothing is destroyed on a refusal, in `frontend/mcm-app/tests/integration/account-delete-callback.integration.test.ts`

  **Scenarios covered**: US2-AC2, US2-AC3, US2-AC8
  For each refusal reason: every store still holds the user's data afterwards, the account still
  exists, and `account_deletion_reauth_rejected` is audited with the right `reason`.

  **Verify RED**:
  ```bash
  MCM_REQUIRE_LIVE_STACK=1 pnpm nx test:integration mcm-app -- --testPathPattern='account-delete-callback\.integration\.test\.ts$' -t 'refus'
  ```
  **Expected RED**: 5 failing — refusals not yet wired into the route

- [X] T029 [US2] Wire the refusals into `delete+api.ts` | **Verify GREEN**: same as T028 | **Expected GREEN**: `5 passed`

- [X] T030 [P] [US2] Write a failing test for the second-factor branch in `frontend/mcm-app/tests/integration/account-deletion-mfa.integration.test.ts`

  **Scenarios covered**: US2-AC6, US2-AC7 (SC-013)
  Enrol TOTP on a fixture user and assert the step-up demands it; assert a user **without** TOTP is
  not refused for lacking one (FR-008). Without an enrolled fixture this branch is never exercised —
  the conditional 2FA subflow only triggers for users who have a credential configured (research R1).

  **Verify RED**:
  ```bash
  MCM_REQUIRE_LIVE_STACK=1 pnpm nx test:integration mcm-app -- --testPathPattern='account-deletion-mfa\.integration\.test\.ts$'
  ```
  **Expected RED**: 2 failing — no TOTP fixture user exists

- [X] T031 [US2] Add the TOTP fixture user and confirm both branches | **Verify GREEN**: same as T030 | **Expected GREEN**: `2 passed`

- [X] T032 [P] [US2] Write a failing test for the last-administrator refusal in `frontend/mcm-app/tests/integration/account-delete-challenge.integration.test.ts`

  **Scenarios covered**: SC-010, FR-013
  The sole `mc-admin` gets `409` and nothing is destroyed; an admin who is **not** the last one
  deletes normally.

  **Verify RED**: `… -t 'administrator'` | **Expected RED**: 2 failing — refusal not implemented

- [X] T033 [US2] Implement the last-administrator check in the challenge route | **Verify GREEN**: same as T032 | **Expected GREEN**: `2 passed`

- [X] T034 [P] [US2] Add per-IP rate limiting to the challenge route and a test asserting `429`

  Uses the existing limiter (research R11). The deletion endpoint is self-limiting; the challenge
  endpoint is not, and an unlimited one is a way to spray authorization requests at the IdP.

  **Verify GREEN**: `… -t 'rate'` | **Expected GREEN**: `1 passed`

**Checkpoint**: deletion is now safe to deploy. This is the real shippable increment.

---

## Phase 5: User Story 3 — A deletion that fails is safe to try again (Priority: P3)

**Goal**: Partial failures abort cleanly, report honestly, and complete on retry.

**Independent test**: Force each step to fail in turn; confirm the account remains retryable, the
standing permission is never stranded, and a retry succeeds.

- [X] T035 [US3] Write failing tests for abort semantics at every step in `frontend/mcm-app/src/bff-server/unit-tests/account-deletion-failure.test.ts`

  **Scenarios covered**: US3-AC1, US3-AC2, US3-AC3 (SC-005, SC-008)
  A revocation failure destroys **nothing** and throws. A failure at step N leaves N+1… untouched.
  Every failure reports "not deleted" — never partial success. `account_deletion_failed` is audited
  with the enumerated `step`.

  **Verify RED**:
  ```bash
  pnpm nx test mcm-app -- --testPathPattern='account-deletion-failure\.test\.ts$'
  ```
  **Expected RED**: 9 failing — abort handling not implemented

- [X] T036 [US3] Implement abort handling and the `finally` step-up token revoke in `account-deletion.ts`

  **Prerequisite**: T035 verified RED.
  The `finally` revoke matters most on the **failure** path: it must not leave a second live token
  set for an account that still exists (plan.md, Constitution re-check).

  **Verify GREEN**: same command as T035 | **Expected GREEN**: `9 passed`

- [X] T037 [US3] Write failing tests for idempotency in the same file

  **Scenarios covered**: US3-AC2 (SC-006)
  Run each step twice and assert the second run succeeds. Cover the two places retry-safety must be
  **written rather than inherited** (research R8): `404` from the per-collection delete, and `404`
  from `deleteUser`. Everything else is already idempotent — assert that too, so a later change that
  breaks it is caught.

  **Verify RED**: same command as T035, `-t 'idempot'` | **Expected RED**: 4 failing

- [X] T038 [US3] Implement 404-as-success in the collection loop | **Verify GREEN**: same as T037 | **Expected GREEN**: `4 passed`

- [X] T039 [P] [US3] Write a failing test that an in-flight backup run stops, in `frontend/mcm-app/tests/integration/account-deletion.integration.test.ts`

  **Scenarios covered**: FR-034
  Start an unattended run, delete the owner mid-run, and assert the run fails and stops — it must
  not retry against records that no longer exist, and must not report success.

  **Verify RED**: `… -t 'in flight'` | **Expected RED**: 2 failing

- [X] T040 [US3] Make the runner fail closed when its owner's records vanish | **Verify GREEN**: same as T039 | **Expected GREEN**: `2 passed`

- [X] T041 [P] [US3] Write and verify the client-disconnect test (SC-012) in the integration file

  **Scenarios covered**: US1 edge case, FR-032, FR-033
  Drop the client immediately after the callback is accepted, then assert **from outside** that the
  deletion completed. Research R3 verified that no inbound abort plumbing exists, so this should
  pass without new code — the test pins that property so a future change cannot silently remove it.

  **Verify GREEN**: `… -t 'disconnect'` | **Expected GREEN**: `1 passed`

  If this fails, abort plumbing has been introduced somewhere; fix the cause, not the test.

- [X] T042 [P] [US3] Write and verify the re-registration test (SC-014)

  **Scenarios covered**: US1 edge case, FR-025, FR-026
  Delete, register again with the same email, and assert the new account has zero collections, zero
  destinations, zero schedules, zero run history and no standing permission.

  **Verify GREEN**: `… -t 'register again'` | **Expected GREEN**: `1 passed`

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T043 [P] Add the web E2E spec `frontend/mcm-app/tests/e2e/web/account-deletion.spec.ts`

  Settings → Account → dialog (both lists visible) → confirm → Keycloak → `/account-deleted`; then
  the session is dead and sign-in fails.

  ```bash
  pnpm nx e2e mcm-app -- --grep "account deletion"
  ```
  **Expected**: 1 passed. Playwright runs here in its official image — a failing `nx e2e` is about
  that target, not evidence that E2E cannot run in this environment.

- [X] T044 [P] Assert the audit stream in an integration test: every event in [data-model.md](data-model.md) §4 fires, and **no entry contains a credential, token, session id, name or email** (SC-011, FR-037)

- [X] T045 **SUPERSEDED — native parity implemented instead** (operator directive). The Android path now runs the real client-initiated OIDC step-up rather than failing closed; see `use-account-deletion.ts`. Verified via CI.

  Native step-up is deferred (plan.md Structure Decision). Until it lands the button must not
  silently do nothing, and must certainly not delete without a step-up.

- [ ] T046 [P] Run the full touched-tier check — derive the tiers from the diff, not from memory

  ```bash
  pnpm nx lint mcm-app && pnpm nx typecheck mcm-app
  pnpm nx test mcm-app
  MCM_REQUIRE_LIVE_STACK=1 pnpm nx test:integration mcm-app
  ```
  A tier you did not think of is a tier that did not run.

- [ ] T047 Close backlog item #544 — **after the pull request MERGES**, not before

  **Operator directive, 2026-09-24: do not close until the pull request has merged successfully.**
  That supersedes the note this task originally carried, which said a merged PR is not closure —
  the two are not in conflict: verification is necessary but no longer sufficient. T020 has
  passed with a skip count of 0, so the evidence the item asks for exists; the close waits on
  the merge.

  T045 is superseded by the same directive: native parity is now IN scope for this feature
  rather than a follow-up, and is to be verified via CI.

---

## Dependencies

```
Phase 1 (T001-T002)
      │  T001 is blocking and may invalidate the design — do it first
      ▼
Phase 2 (T003-T010)   foundational primitives; T003/T005/T007 are [P]
      ▼
Phase 3 US1 (T011-T025) ──────┐
      ▼                        │  US1 must not deploy without US2
Phase 4 US2 (T026-T034) ◀──────┘
      ▼
Phase 5 US3 (T035-T042)   depends on US1's pipeline existing
      ▼
Phase 6 (T043-T047)
```

**Story independence**: US2 and US3 both act on the pipeline US1 builds, so they are sequential
after it rather than parallel with it. That is a property of a destructive feature with one entry
point, not a modelling failure — there is deliberately no deletion path that bypasses the step-up.

## Parallel opportunities

- **Phase 2**: T003/T004, T005/T006, T007/T008 are three independent pairs in three separate files.
- **Phase 3**: T023/T024 (UI) and T025 run alongside the BFF work in T011–T022.
- **Phase 5**: T039, T041 and T042 touch different scenarios in the integration file and can be
  written in parallel, though they share a file so they merge sequentially.
- **Phase 6**: T043, T044 and T046 are independent.

## Implementation strategy

**MVP is US1 + US2, not US1 alone.** US1 is independently testable and the template would normally
call it the MVP, but it delivers an irreversible destructive endpoint whose identity checks live in
US2. Ship them together.

**US3 can follow.** Without it, a partial failure is recoverable but untidy — the account survives
and a retry works; what is missing is the proof that it always does.

**The one test that matters** is T019/T020: the standing permission proved dead by presenting it to
Keycloak. Everything else supports it. If time runs short, that is the one to protect.
