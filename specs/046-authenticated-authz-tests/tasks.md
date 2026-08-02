# Tasks: Authenticated HTTP authorization tests for mc-service

**Branch**: `046-authenticated-authz-tests` | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

**Input**: [spec.md](./spec.md), [plan.md](./plan.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: This feature **is** tests. Every task below either writes one, proves one bites, or wires
the environment they need.

**Organization**: grouped by user story so each is independently implementable and testable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: which user story the task serves (US1, US2, US3)
- Every task names its exact file path

**No Platform Parity Table** — mc-service is a backend service with no UI surface of its own
(`docs/templates/feature-test-tasks-template.md` § Adapting to project type). The consuming client's
E2E obligation is handled in T028.

---

## RED discipline for this feature — read before starting

The behaviour under test **already exists and is already correct**. A newly written assertion
therefore goes green on its first run, and a compile error is **not** an acceptable RED. Three
mechanisms are used, and each task states which one applies:

| Mechanism | When | What "RED" means |
|---|---|---|
| **Genuine test-first** | The helper's own pure functions, which do not exist yet (T005 → T006) | The stub's behaviour fails the assertion |
| **Mutation RED** | Every assertion about production behaviour (T008–T020) | The named source edit is applied, the test fails, the edit is reverted |
| ~~Compile failure~~ | never | Not accepted as RED — a test that has never *run* red has not been verified |

**A mutation is applied, observed, and reverted inside the task pair that names it.** Never leave one
in place across tasks, and never commit one. Every revert is `git checkout -- <path>`.

### Mutation catalogue

| # | File · line | Edit | Reverts with |
|---|---|---|---|
| M1 | `backend/mc-service/tests/integration/common/auth.rs` | make `user_token()` return `format!("{token}x")` — an invalid signature | `git checkout -- backend/mc-service/tests/` |
| M2 | [`src/api/collections/create.rs:18`](../../backend/mc-service/src/api/collections/create.rs#L18) | `let owner_id = token.subject.to_string();` → `let owner_id = "not-the-caller".to_string();` | `git checkout -- backend/mc-service/src/` |
| M3 | [`src/adapters/mongodb/collection_repository.rs:106,181,235`](../../backend/mc-service/src/adapters/mongodb/collection_repository.rs#L106) | `doc! { "_id": oid, "ownerId": owner_id }` → `doc! { "_id": oid }` (all three) | `git checkout -- backend/mc-service/src/` |
| M4 | [`src/application/access_control.rs:25`](../../backend/mc-service/src/application/access_control.rs#L25) | `if collection.authorizes(caller_id, required)` → `if true` | `git checkout -- backend/mc-service/src/` |
| M5 | [`src/api/middleware/error_handler.rs:27`](../../backend/mc-service/src/api/middleware/error_handler.rs#L27) | delete the `[("Content-Type", "application/problem+json")]` tuple element | `git checkout -- backend/mc-service/src/` |
| M6 | [`src/api/middleware/error_handler.rs:40`](../../backend/mc-service/src/api/middleware/error_handler.rs#L40) | append `" at src/adapters/mongodb/collection_repository.rs:106"` to the `CollectionNotFound` detail | `git checkout -- backend/mc-service/src/` |

### Standard commands

```bash
# whole new module (~1 s once compiled)
pnpm nx test:integration mc-service -- collections::http_authz_test

# one test
pnpm nx test:integration mc-service -- collections::http_authz_test::<test_name>

# the real gate (~2 min) — read the counts, never the exit status
pnpm nx test:integration mc-service
```

A passthrough filter puts the guard in delegate mode: it skips the executed-count assertion but still
forbids a bare `#[ignore]`. **Baseline on this branch, measured 2026-08-02: 164 executed, 0 ignored,
0 failed.**

---

## Phase 1: Setup

**Purpose**: make the dependency and the credentials available. No test can run without both.

- [ ] T001 Declare `reqwest` in `[dev-dependencies]` of `backend/mc-service/Cargo.toml` as `reqwest = { version = "0.12", default-features = false, features = ["json", "rustls-tls"] }`, then run `cargo metadata --manifest-path backend/mc-service/Cargo.toml >/dev/null` and inspect `git diff Cargo.lock`.

  **Type**: Config change | **Risk**: Low | **Spec reference**: [plan.md § Technical Context](./plan.md), [research.md R2](./research.md)

  **Done when**: `git diff Cargo.lock` shows **only** `reqwest` added to `mc-service`'s own dependency list and **no new `[[package]]` block**. `reqwest` 0.12.28 is already resolved transitively via `axum-keycloak-auth` (Cargo.lock:2768), and `rustls`/`hyper-rustls`/`webpki-roots` are already present. If a new package appears, the feature list pulled something extra — fix the features rather than accepting the lock change.

- [ ] T002 [P] Add `E2E_ROPC_CLIENT_ID`, `E2E_ROPC_CLIENT_SECRET`, `E2E_TEST_USER` and `E2E_TEST_PASSWORD` to `backend/mc-service/.env.local`, copying the values from `frontend/mcm-app/.env.e2e.local`.

  **Type**: Config change | **Risk**: None | **Spec reference**: FR-001, FR-009

  **Done when**: all four are readable from that file. **Copy them by hand or with a real dotenv parser — do NOT `set -a; . frontend/mcm-app/.env.e2e.local`**: a value contains characters that break shell sourcing (`line 4: … command not found`). `backend/mc-service/.env.local` is gitignored (`.gitignore:506`); **never commit it**, and never echo a value into the transcript.

**Checkpoint**: dependency declared, credentials on disk.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the token helper and the harness accessor. **⚠️ No user story can begin until this phase
is complete** — every story needs a credential, and US1 needs the database handle.

- [ ] T003 Add `pub async fn build_test_app_with_db() -> (axum::Router, Database)` to `backend/mc-service/tests/integration/common/mod.rs`.

  **Type**: New harness function | **Risk**: Medium | **Spec reference**: [plan.md § Design 2](./plan.md), [research.md R3](./research.md)

  Refactor so all three public builders (`build_test_app`, `build_test_app_with_auth_instance`, `build_test_app_with_db`) delegate to **one** private constructor that keeps the existing `wait_until_operational` assertion. **The gate is load-bearing**: OIDC discovery that ends in `Err` still marks the auth layer ready, so an ungated path would let the whole suite pass green against a dead Keycloak (feature 045's finding). Do not copy the builder body; delegate.

  **Done when**: `pnpm nx test:integration mc-service` still reports **164 executed, 0 ignored, 0 failed** — this task must be behaviour-neutral for the existing suite.

- [ ] T004 Create `backend/mc-service/tests/integration/common/auth.rs` with the two pure functions **stubbed**, and declare `pub mod auth;` in `backend/mc-service/tests/integration/common/mod.rs`.

  **Type**: New file | **Risk**: Low | **Spec reference**: [contracts/test-credential-helper.md](./contracts/test-credential-helper.md)

  Stub bodies deliberately: `read_credential(key) -> Result<String, String>` returns `Err("missing credential".to_string())` when unset, and `subject_from_access_token(jwt) -> Result<String, String>` returns `Err("bad token".to_string())`. The stubs exist so T005 has something to fail against — this is the one genuinely test-first seam in the feature.

  **Done when**: `cargo build --manifest-path backend/mc-service/Cargo.toml --tests` succeeds.

- [ ] T005 Create `backend/mc-service/tests/integration/collections/http_authz_test.rs`, declare it in `backend/mc-service/tests/integration/collections/mod.rs` **and** in the `mod collections { … }` block of `backend/mc-service/tests/integration/collections_test.rs`, and write the two credential-failure tests.

  **Type**: Test | **Risk**: Low | **Spec reference**: [spec.md § Edge Cases](./spec.md) — FR-007, SC-005

  **Scenarios covered**:
  - Edge case: "credentials are absent → the suite must fail loudly and name what is missing"

  Tests: `missing_credential_failure_names_the_variable` asserts that `read_credential` for an **absent** key returns `Err` whose message **contains that key's name**; `undecodable_token_failure_names_the_field` asserts `subject_from_access_token("not-a-jwt")` returns `Err` naming what could not be read. Neither test may mutate process env — that is the whole reason these functions are pure ([research.md R7](./research.md)).

  **The key must be one that is guaranteed absent** — e.g. `MC_SERVICE_TEST_NONEXISTENT_CREDENTIAL`, following the precedent in [`src/config.rs`](../../backend/mc-service/src/config.rs)'s own unit test. Do **not** name a real credential such as `E2E_TEST_PASSWORD`: T002 puts it in `.env.local` and any earlier test's `dotenvy` call loads it into the process env, so `read_credential` would return `Ok`, the test would assert nothing, and the RED below could never be observed. The property under test — *the message names the key you asked for* — is proven exactly as well by a synthetic key, and only by one.

  **Verify RED**:
  ```bash
  pnpm nx test:integration mc-service -- collections::http_authz_test
  ```
  **Expected RED**: 2 failing — `message must name MC_SERVICE_TEST_NONEXISTENT_CREDENTIAL, got "missing credential"` and the equivalent for the token decode. If either shows 0 failures, the test is trivially passing (almost certainly because the key it asked for is actually set) and must be corrected before T006.

- [ ] T006 Implement `read_credential` and `subject_from_access_token` in `backend/mc-service/tests/integration/common/auth.rs`.

  **Type**: Implementation | **Risk**: Low | **Prerequisite**: T005 verified RED.

  `read_credential` reads the process env and returns `Err` naming **the variable** (never a value) when unset or empty. `subject_from_access_token` base64url-decodes the JWT's payload segment with the `base64` crate, parses it with `serde_json`, and returns `sub`; its `Err` names which step failed (segment / decode / parse / missing `sub`). **No signature verification** — the token's authenticity is proven by the service accepting it, which is what US2 asserts.

  **Verify GREEN**:
  ```bash
  pnpm nx test:integration mc-service -- collections::http_authz_test
  ```
  **Expected GREEN**: `2 passed; 0 failed`.

- [ ] T007 Implement `user_token()` and `user_subject()` in `backend/mc-service/tests/integration/common/auth.rs`.

  **Type**: Implementation | **Risk**: Medium | **Spec reference**: FR-001, FR-002, FR-009 · full contract in [contracts/test-credential-helper.md](./contracts/test-credential-helper.md)

  ROPC `POST {KEYCLOAK_URL}/realms/{KEYCLOAK_REALM}/protocol/openid-connect/token` with `grant_type=password` + `client_id`/`client_secret`/`username`/`password`, form-encoded, via `reqwest`. Cache `{ access_token, subject }` in a `tokio::sync::OnceCell` — one call per test binary. Load env with `dotenvy::from_filename("backend/mc-service/.env.local")` **then** `dotenvy::dotenv()`, both ignoring failure, matching `common::test_db()` (the working directory differs between a repo-root and a package-root cargo run).

  **Fail hard, never skip**: panic naming the missing variable, or the status code and endpoint on a non-2xx. **Never** echo the token, secret, password, or the response body — the body can carry credential material (constitution: Sensitive Data Prohibition).

  **Verify**: deferred by design — this function has no assertion of its own; T008 is its first executable proof. Do not add a smoke test that merely checks the token is non-empty; the control test proves the stronger property that the *service* accepts it.

**Checkpoint**: a real credential is obtainable in-process. User stories can now begin.

---

## Phase 3: User Story 2 — a signed-in user can reach their own data (Priority: P1)

**Goal**: prove a real token is accepted end-to-end, and that the service records the authenticated
subject as the owner.

**Independent Test**: create a collection over HTTP with a real credential and read it back.

**Why this story runs first** — both US1 and US2 are P1, and the spec says why: US2 is the *control*.
Without it, a `404` from US1 is ambiguous, because it could equally mean the credential was rejected
and everything returns an error. Ordering the control first makes every later assertion interpretable.

- [ ] T008 [US2] Write `authenticated_request_is_never_unauthorized` in `backend/mc-service/tests/integration/collections/http_authz_test.rs`.

  **Type**: Test | **Risk**: Low | **Spec reference**: [spec.md#user-story-2](./spec.md)

  **Scenarios covered**:
  - US2-AC3: given a valid credential, any protected endpoint responds — never `401`

  `GET /api/v1/collections` via `common::build_test_app()` and `tower::ServiceExt::oneshot`, with `Authorization: Bearer {user_token().await}`. Assert the status is **neither `401` nor `403`** — the second half proves `require_app_role` saw the `mc-user` role, not just that the signature verified.

  **Verify RED** — apply mutation **M1**, then:
  ```bash
  pnpm nx test:integration mc-service -- collections::http_authz_test::authenticated_request_is_never_unauthorized
  ```
  **Expected RED**: 1 failing — `a valid credential must never be rejected: got 401 Unauthorized`.

- [ ] T009 [US2] Revert mutation **M1** (`git checkout -- backend/mc-service/tests/`) and confirm the control passes.

  **Type**: Verification | **Risk**: None | **Prerequisite**: T008 verified RED.

  **Verify GREEN**:
  ```bash
  pnpm nx test:integration mc-service -- collections::http_authz_test
  ```
  **Expected GREEN**: `3 passed; 0 failed` (2 from Phase 2 + this one).

- [ ] T010 [US2] Write `authenticated_create_collection_stamps_authenticated_subject_as_owner` and `authenticated_owner_can_read_own_collection` in `backend/mc-service/tests/integration/collections/http_authz_test.rs`.

  **Type**: Test | **Risk**: Low | **Spec reference**: [spec.md#user-story-2](./spec.md) — FR-003

  **Scenarios covered**:
  - US2-AC1: creating a collection succeeds and the stored owner is that user's identity
  - US2-AC2: a collection the user owns is returned when requested

  Build with **`common::build_test_app_with_db()`** — the database handle is needed for the storage assertion below. `POST /api/v1/collections` with a real bearer → assert `201`, then assert the owner **twice, at two different layers**:

  1. the response body's `ownerId` equals `user_subject().await`;
  2. the **stored** document's `ownerId` in Mongo equals it too — read the row directly, mirroring `stored_owner()` in [`movies/dac_authorization_test.rs:130`](../../backend/mc-service/tests/integration/movies/dac_authorization_test.rs#L130).

  Both are needed and they catch different faults: FR-003 is about the **recorded** owner, so a serialization-layer bug that echoes the caller's subject back while persisting something else would pass on the response assertion alone. In both cases the expected subject comes from the *token*, never from the service's own response — comparing a response to itself would pass even if the service stamped a constant ([research.md R6](./research.md)).

  Then `GET /api/v1/collections/{id}` → `200`, same `collectionId`. Use a `Uuid`-suffixed collection name so a duplicate-name conflict can never be mistaken for an authorization result.

  **Verify RED** — apply mutation **M2**, then:
  ```bash
  pnpm nx test:integration mc-service -- collections::http_authz_test
  ```
  **Expected RED**: 2 failing — `stored ownerId must equal the authenticated subject: got "not-the-caller"`, and the read-back returning `404` because the collection was created under a different owner.

- [ ] T011 [US2] Revert mutation **M2** (`git checkout -- backend/mc-service/src/`) and confirm the story passes.

  **Type**: Verification | **Risk**: None | **Prerequisite**: T010 verified RED.

  **Verify GREEN**:
  ```bash
  pnpm nx test:integration mc-service -- collections::http_authz_test
  ```
  **Expected GREEN**: `5 passed; 0 failed`.

**Checkpoint**: the credential works end-to-end and ownership is provably the authenticated subject.
Every `404` from here on is interpretable.

---

## Phase 4: User Story 1 — a tenant cannot discover another tenant's data (Priority: P1) 🎯 MVP

**Goal**: prove that a foreign-owned resource answers `404` — never `403` — for read, modify, delete,
and for a movie nested inside it.

**Independent Test**: seed a collection owned by another subject, request it over HTTP with a real
token, observe `404`.

**This is the security-critical story.** A regression here leaks the existence of other tenants' data.

- [ ] T012 [US1] Write the foreign-owner fixture helper plus `foreign_collection_read_is_not_found_not_forbidden`, `foreign_collection_update_is_not_found_not_forbidden` and `foreign_collection_delete_is_not_found_not_forbidden` in `backend/mc-service/tests/integration/collections/http_authz_test.rs`.

  **Type**: Test | **Risk**: Medium | **Spec reference**: [spec.md#user-story-1](./spec.md) — FR-004

  **Scenarios covered**:
  - US1-AC1: a signed-in user requesting another subject's collection gets `404`
  - US1-AC2: modify and delete of another subject's collection also get `404`, not `403`

  Use `common::build_test_app_with_db()`, call `adapters::mongodb::indexes::create_indexes(&db)`, then seed the collection with `MongoCollectionRepository::create(OTHER_TENANT_SUBJECT, …)` — it **cannot** be created over HTTP, because every write path stamps `owner_id = token.subject`.

  Two fixture invariants must be asserted or the whole exercise is vacuous ([data-model.md F-3.1/F-3.2](./data-model.md)):
  1. `OTHER_TENANT_SUBJECT != user_subject().await` — otherwise the test reads the user's own data;
  2. the seeded document is **still present and unmodified** in Mongo after the refused `PATCH`/`DELETE` — otherwise `404` would only mean "absent".

  Every case asserts `404` **and** `assert_ne!(status, StatusCode::FORBIDDEN)` with a message saying why: a `403` confirms the resource exists and is the existence leak this design prevents. The `assert_ne!` is logically redundant with the `assert_eq!(404)` — keep it anyway, and say so in a comment: FR-004 explicitly requires failing a `403`, and the dedicated assertion is what produces the diagnostic message. It is not dead weight for a reviewer to strip.

  **Order of operations in each test** — this is what reconciles invariant 2 with the cleanup convention:

  ```text
  seed fixture → issue the HTTP request → capture status + body
              → re-read the fixture document from Mongo (capture presence + fields)
              → common::cleanup_db(&db)
              → assert on the captured values
  ```

  Everything is *captured* while the database is alive and *asserted* after it is dropped, so a failing assertion never leaks a database. This is the existing convention in `movies/dac_authorization_test.rs`, not a new one.

  **Verify RED** — apply mutation **M3** (all three filter sites), then:
  ```bash
  pnpm nx test:integration mc-service -- collections::http_authz_test
  ```
  **Expected RED**: 3 failing — `cross-tenant read must be 404 (no existence leak): got 200 OK`, and the equivalents returning `200` for `PATCH` and `204` for `DELETE`.

- [ ] T013 [US1] Revert mutation **M3** (`git checkout -- backend/mc-service/src/`) and confirm the collection cases pass.

  **Type**: Verification | **Risk**: None | **Prerequisite**: T012 verified RED.

  **Verify GREEN**:
  ```bash
  pnpm nx test:integration mc-service -- collections::http_authz_test
  ```
  **Expected GREEN**: `8 passed; 0 failed`.

- [ ] T014 [US1] Write `foreign_collection_movie_read_is_not_found` in `backend/mc-service/tests/integration/collections/http_authz_test.rs`.

  **Type**: Test | **Risk**: Low | **Spec reference**: [spec.md#user-story-1](./spec.md) — FR-005

  **Scenarios covered**:
  - US1-AC3: a movie inside another subject's collection returns `404`

  Seed the foreign collection **and** a movie inside it via `MongoMovieRepository`, then `GET /api/v1/collections/{id}/movies/{movieId}` with the real bearer. Assert `404` and not `403`. The refusal comes from `authorize_collection_access`, a different seam from the collection repository's filter — which is why this needs its own test and its own mutation.

  **Verify RED** — apply mutation **M4**, then:
  ```bash
  pnpm nx test:integration mc-service -- collections::http_authz_test::foreign_collection_movie_read_is_not_found
  ```
  **Expected RED**: 1 failing — `cross-tenant movie read must be 404: got 200 OK`.

- [ ] T015 [US1] Revert mutation **M4** (`git checkout -- backend/mc-service/src/`) and confirm the nested case passes.

  **Type**: Verification | **Risk**: None | **Prerequisite**: T014 verified RED.

  **Verify GREEN**:
  ```bash
  pnpm nx test:integration mc-service -- collections::http_authz_test
  ```
  **Expected GREEN**: `9 passed; 0 failed`.

- [ ] T016 [US1] Prove the fixture guards themselves bite, in `backend/mc-service/tests/integration/collections/http_authz_test.rs`.

  **Type**: Test verification | **Risk**: None | **Spec reference**: [data-model.md F-3.1](./data-model.md)

  Temporarily set `OTHER_TENANT_SUBJECT` to `user_subject().await`'s value. The guard from T012 must fail — if the suite instead goes green, the cross-tenant tests are reading the user's own data and prove nothing. Revert immediately.

  **Expected RED**: ≥1 failing — `the foreign fixture's owner must differ from the authenticated subject`.

  **Done when**: the guard has been observed failing under the equal-owner condition and passing after the revert. **No mutation may remain in the working tree.**

**Checkpoint**: the isolation boundary is verified at the HTTP boundary for read, update, delete and
the nested movie — MVP complete.

---

## Phase 5: User Story 3 — authorization failures are machine-readable (Priority: P2)

**Goal**: the first *authenticated* error paths the suite has ever exercised return a well-formed RFC
9457 body with no diagnostic leakage.

**Independent Test**: trigger a cross-tenant refusal and assert on the response's content type and
body fields.

- [ ] T017 [US3] Write `cross_tenant_refusal_body_is_problem_json` in `backend/mc-service/tests/integration/collections/http_authz_test.rs`.

  **Type**: Test | **Risk**: Low | **Spec reference**: [spec.md#user-story-3](./spec.md) — FR-006 · shape in [contracts/authenticated-http-authorization.md § 2.3](./contracts/authenticated-http-authorization.md)

  **Scenarios covered**:
  - US3-AC1: the content type is the standard problem format and the body carries type, title and status

  Reuse the foreign-owner fixture. Assert `content-type` is `application/problem+json`; the body has `type`, `title` and `status`; `status` equals the HTTP status line (`404`); and `type` **ends with** `COLLECTION_NOT_FOUND`. Match the suffix, not the whole URI — the `.example` host is a deliberate non-resolvable RFC 2606 namespace and an assertion must not "correct" it to a real domain.

  **Verify RED** — apply mutation **M5**, then:
  ```bash
  pnpm nx test:integration mc-service -- collections::http_authz_test::cross_tenant_refusal_body_is_problem_json
  ```
  **Expected RED**: 1 failing — `error responses must use application/problem+json: got "application/json"`.

- [ ] T018 [US3] Revert mutation **M5** (`git checkout -- backend/mc-service/src/`) and confirm the shape assertion passes.

  **Type**: Verification | **Risk**: None | **Prerequisite**: T017 verified RED.

  **Verify GREEN**:
  ```bash
  pnpm nx test:integration mc-service -- collections::http_authz_test
  ```
  **Expected GREEN**: `10 passed; 0 failed`.

- [ ] T019 [US3] Write `authenticated_error_body_carries_no_diagnostics` in `backend/mc-service/tests/integration/collections/http_authz_test.rs`.

  **Type**: Test | **Risk**: Low | **Spec reference**: [spec.md#user-story-3](./spec.md) — FR-006

  **Scenarios covered**:
  - US3-AC2: an authenticated error body contains no stack trace or internal diagnostic text

  Assert the raw body contains none of `panicked`, `backtrace`, `src/`, `.rs:`, or MongoDB driver error text. Assert on the **whole body string**, not on parsed fields — a leak can arrive in any field, including one the DTO does not declare.

  **Verify RED** — apply mutation **M6**, then:
  ```bash
  pnpm nx test:integration mc-service -- collections::http_authz_test::authenticated_error_body_carries_no_diagnostics
  ```
  **Expected RED**: 1 failing — `error body must not leak a source path: found "src/adapters/mongodb/collection_repository.rs:106"`.

- [ ] T020 [US3] Revert mutation **M6** (`git checkout -- backend/mc-service/src/`) and confirm the leakage assertion passes.

  **Type**: Verification | **Risk**: None | **Prerequisite**: T019 verified RED.

  **Verify GREEN**:
  ```bash
  pnpm nx test:integration mc-service -- collections::http_authz_test
  ```
  **Expected GREEN**: `11 passed; 0 failed`.

**Checkpoint**: all three stories complete and independently verified.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [ ] T021 Forward the four credentials into the mc-service integration step of `.forgejo/workflows/app-ci.yml` (the `app-e2e` job, ~line 482).

  **Type**: Config change | **Risk**: Medium | **Spec reference**: FR-008

  Add to the existing `docker run`: `-e E2E_ROPC_CLIENT_ID=mcm-bff-test`, plus the **bare** forms `-e E2E_ROPC_CLIENT_SECRET`, `-e E2E_TEST_USER`, `-e E2E_TEST_PASSWORD` so no secret is restated in the workflow file. All three already exist in that job — the bring-up step writes `E2E_ROPC_CLIENT_SECRET` to `$GITHUB_ENV` (app-ci.yml:389-390) and the job env supplies the other two from repository secrets (app-ci.yml:256-257). Update the step's comment block to say the suite now performs a ROPC login, so the next reader knows why a realm-import regression fails here.

  **Done when**: the step passes all four, and no literal secret value appears in the diff.

- [ ] T022 Run the real gate and record the counts.

  **Type**: Verification | **Risk**: None | **Spec reference**: SC-001, SC-004

  ```bash
  pnpm nx test:integration mc-service
  ```
  **Expected**: `3 integration binaries executed 175 tests` (**164 baseline + 11**), `0 ignored`, `0 failed`. If the number differs from 164 + the tests actually written, reconcile before proceeding — a count that does not add up means a test is not being discovered. Read the counts, never the exit status.

- [ ] T023 Prove the missing-credential path end-to-end.

  **Type**: Verification | **Risk**: None | **Spec reference**: FR-007, SC-005

  Comment `E2E_TEST_PASSWORD` out of `backend/mc-service/.env.local` (unsetting it in the shell alone is not enough — `dotenvy` loads the file back), then:
  ```bash
  env -u E2E_TEST_PASSWORD pnpm nx test:integration mc-service
  ```
  **Expected**: the run **FAILS**, naming `E2E_TEST_PASSWORD`. It must not skip and must not report success. Restore the line afterwards. The identity-provider-unreachable half of SC-005 is already covered by the two guards at the end of `health_test.rs` — **leave them alone**.

- [ ] T024 Measure the flake bar — 20 consecutive full runs, zero failures.

  **Type**: Verification | **Risk**: Low | **Spec reference**: SC-004

  ```bash
  for i in $(seq 1 20); do
    pnpm nx test:integration mc-service || { echo "FAILED on round $i"; break; }
  done
  ```
  **Expected**: 20/20 clean, matching 045's baseline of 20 rounds × 3 binaries. Record the per-round wall clock and confirm the added time is within the "a few seconds" budget of SC-004 (baseline ~2 min).

- [ ] T025 Lint and format.

  **Type**: Verification | **Risk**: None

  ```bash
  pnpm nx lint mc-service
  cargo fmt --manifest-path backend/mc-service/Cargo.toml -- <only the files this feature touched>
  ```
  **Expected**: clippy `-D warnings` clean. `--all-targets` has **9 pre-existing failures** on clean `main` and is not the gate; `cargo fmt --check` drifts in 7 untouched files — **format only what you touch**.

- [ ] T026 Confirm lock discipline with `git diff Cargo.lock`.

  **Type**: Verification | **Risk**: None

  **Expected**: only `mc-service` gaining `reqwest`; **no new `[[package]]` block**. This closes the T001 loop after the dev-dependency has actually been compiled against.

- [ ] T027 [P] Update `docs/proposals/PRD-McServiceHttpAuthzIntegration.md` to close **G2** and correct its `403` claim.

  **Type**: Documentation | **Risk**: None | **Spec reference**: [research.md R4, R5](./research.md)

  Record three things: the audience-mapper unknown was already solved (a ROPC token carries `aud ∋ movie-collection-manager` and the `mc-user` role); the PRD's "403 for a non-owner" is **wrong** — the design returns `404` with no existence leak, and this feature asserts `404` while explicitly failing a `403`; and G2b (the `require_app_role` `403`) remains open with its prerequisite — a role-less identity, unavailable because the realm is runtime-managed with no committed source. Update the `Not done` list at the end of [specs/045-mc-service-http-authz-tests/tasks.md](../045-mc-service-http-authz-tests/tasks.md) to match.

  **Done when**: the PRD has no remaining goal that this feature in fact delivered, and no surviving claim that a non-owner gets `403`.

- [ ] T028 Settle the full-stack E2E regression obligation and record the reasoning in this file.

  **Type**: Verification | **Risk**: Low | **Spec reference**: [feature-validation-checklist](../../openwiki/invariants/feature-validation-checklist.md), FR-010

  The repo's Definition of Done requires a consuming client's E2E regression **even for backend-only features**, because a backend change reaches users through the API. Confirm the premise does not apply here: `git diff --stat backend/mc-service/src/` must be **empty** — this feature touches no production source, so the deployed artifact is byte-identical and there is nothing for an E2E run to regress. The `app-e2e` job runs on this PR regardless and covers it.

  **Done when**: the empty `src/` diff is confirmed and stated in the PR description. **If that diff is not empty, the exemption is void** — rebuild mc-service, redeploy the container, and run `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app` before claiming completion.

---

## Dependencies & Execution Order

### Phase dependencies

- **Phase 1 (Setup)** — no dependencies; T001 and T002 are independent of each other.
- **Phase 2 (Foundational)** — depends on Phase 1. **Blocks every user story**: T007 provides the
  credential all three need, T003 the database handle US1 needs.
- **Phase 3 (US2)** — depends on Phase 2.
- **Phase 4 (US1)** — depends on Phase 2. Technically independent of US2, but **US2 first is
  strongly advised**: without the control, a `404` from US1 cannot be distinguished from a rejected
  credential.
- **Phase 5 (US3)** — depends on Phase 2, and reuses US1's foreign-owner fixture, so it is cheapest
  after Phase 4.
- **Phase 6 (Polish)** — depends on all stories being complete.

### Within a story

Each test task is immediately followed by its revert-and-verify-GREEN partner. **Never start the next
test task with a mutation still applied** — a second mutation on top of an unreverted first makes the
RED unattributable.

### Parallel opportunities

Genuinely limited, and worth stating plainly rather than inventing:

- **T001 ∥ T002** — different files, no ordering.
- **T027** is independent of every code task and can run any time after Phase 5.
- **Everything else is serial.** T005–T020 all edit the *same* file
  (`collections/http_authz_test.rs`), and the mutation-based RED mechanism requires exclusive control
  of the working tree — two concurrent mutations would make both REDs meaningless. Marking these `[P]`
  would be false parallelism.

---

## Implementation Strategy

### MVP

**Phase 1 + Phase 2 + Phase 3 (US2) + Phase 4 (US1)** — the credential, the control, and the
isolation boundary. That is the whole security value of the feature; US3 hardens an existing contract
and can land after.

### Incremental delivery

1. Setup + Foundational → a real credential is obtainable in-process.
2. Add US2 → the credential is proven accepted and ownership proven correct → **stop and validate**.
3. Add US1 → the isolation boundary is verified at the HTTP boundary → **MVP complete**.
4. Add US3 → error bodies are machine-readable and leak-free.
5. Polish → CI wiring, gates, flake bar, docs.

### Single-developer note

This is a one-person, one-runner feature: the mutation-RED loop needs exclusive control of the
working tree, so parallel staffing would fight over it. Sequence it.

---

## Completion Checklist

Before marking `046-authenticated-authz-tests` complete, verify every success criterion from
[spec.md](./spec.md):

- [ ] **SC-001**: a signed-in user reads their own collection and is refused another's, verified
  automatically on every merge (T010/T011, T012/T013, T021)
- [ ] **SC-002**: every cross-tenant refusal reports "not found"; **zero** report "forbidden" — and a
  change to "forbidden" fails the build (T012, T014 — each asserts `assert_ne!(403)`)
- [ ] **SC-003**: removing owner scoping from a read path turns the suite red (T012's mutation M3,
  observed and reverted)
- [ ] **SC-004**: **zero ignored** tests, added runtime within a few seconds (T022, T024)
- [ ] **SC-005**: with credentials absent the suite fails and names the cause (T023); with the identity
  provider unreachable, the pre-existing `health_test.rs` guards cover it
- [ ] All test tasks used the TDD checkpoint format, and every Verify RED was **observed failing**
  before its GREEN
- [ ] **No mutation remains in the working tree** — `git status` clean of `backend/mc-service/src/`
  changes, and `git diff --stat backend/mc-service/src/` empty (T028)
- [ ] `pnpm nx test:unit mc-service` — unit tests pass (untouched by this feature; run as regression)
- [ ] **Code coverage** — constitution § Backend Quality Standards requires ≥70% for new features.
  **No coverage run is required here, and this line records why**: the feature adds **no production
  code** (`git diff --stat backend/mc-service/src/` is empty, T028), so there is no new line for
  coverage to measure and the ratio can only rise — 11 new tests exercise existing paths. If T028's
  `src/` diff turns out non-empty, this exemption is void: run
  `cargo tarpaulin --manifest-path backend/mc-service/Cargo.toml --out Lcov` and confirm ≥70%.
- [ ] `pnpm nx test:integration mc-service` — **175 executed, 0 ignored, 0 failed** (T022)
- [ ] `pnpm nx lint mc-service` — clippy `-D warnings` clean (T025)
- [ ] Full-stack E2E obligation settled — `src/` diff empty, so the `app-e2e` job on this PR covers it
  (T028)
- [ ] `git diff Cargo.lock` shows no new `[[package]]` (T026)
- [ ] PR opened from a **real branch** via `POST …/pulls` with the `git credential fill` token —
  **never AGit**, whose head receives no Actions secrets
  ([ci-diagnostics](../../docs/runbooks/ci-diagnostics.md) § Opening a pull request)
- [ ] `rtk gain` — token compression confirmed (run last; it measures the runs above)
