# Implementation Plan: Authenticated HTTP authorization tests for mc-service

**Branch**: `046-authenticated-authz-tests` | **Date**: 2026-08-02 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from [specs/046-authenticated-authz-tests/spec.md](./spec.md)

**Parent**: [PRD-McServiceHttpAuthzIntegration.md](../../docs/proposals/PRD-McServiceHttpAuthzIntegration.md)
(G2) · **Predecessor**: [045](../045-mc-service-http-authz-tests/plan.md), which delivered the
unauthenticated half.

## Summary

The mc-service integration suite proves `401` without a token and nothing else. This feature adds the
authenticated half: a ROPC token helper for the Rust test harness, and a new test module asserting an
authenticated happy path, cross-tenant `404` (never `403`), and the RFC 9457 shape of authenticated
error bodies.

The whole change is test-scoped. No production source file changes behaviour. The only non-test
edits are a `[dev-dependencies]` line, a harness accessor that hands the test its own `Database`
handle, and four environment variables added to the existing CI step.

## Technical Context

**Language/Version**: Rust, edition 2021 (CI toolchain: `rust:1-bookworm`)

**Primary Dependencies**: `axum` 0.8, `axum-keycloak-auth` 0.8.3, `tower`, `tokio`, `mongodb` 3,
`dotenvy`, `base64`, `serde_json` — all already present. **One added `[dev-dependencies]` entry:
`reqwest` 0.12.28**, already resolved in the workspace `Cargo.lock` transitively via
`axum-keycloak-auth`, so no new `[[package]]` enters the lock.

**Storage**: MongoDB replica set `rs0` (`localhost:27017`, `directConnection=true`) for the
per-test database; Keycloak realm `grumpyrobot` (`localhost:8099` in CI, `:8081` locally) for JWKS
**and now for token issuance**.

**Testing**: `cargo test` driven by `scripts/mc-service-integration-guard.mjs`, invoked through Nx
(`pnpm nx test:integration mc-service`) per
[nx-task-runner](../../openwiki/invariants/nx-task-runner.md). The guard runs with
`--test-threads=1`, so the added tests are serialized within their binary.

**Target Platform**: Linux. In CI, a `rust:1-bookworm` container run with `--network host` so it
reaches the published Mongo and Keycloak ports on the rootless daemon's loopback.

**Project Type**: Rust/Axum microservice (backend). This feature is a **test-only** change to it.

**Performance Goals**: one ROPC round trip per test binary, cached in a `OnceCell`; added wall clock
budgeted at **< 2 s** for the whole suite (SC-004's "no more than a few seconds").

**Constraints**: no production authorization behaviour may change; the suite must keep **zero ignored
tests**; missing credentials must fail hard, never skip; no new package may enter `Cargo.lock`.

**Scale/Scope**: ~10 new tests across 1 new test file; 5 files touched (1 new test module, 1 new
helper module, `common/mod.rs`, `Cargo.toml`, `app-ci.yml`).

## Constitution Check

*GATE: evaluated before Phase 0 and re-evaluated after Phase 1 design (results identical — see
[Post-design re-check](#post-design-constitution-re-check)).*

| Principle | Status |
|---|---|
| **Test Type Integrity (NON-NEGOTIABLE)** | **Satisfied, and this is the load-bearing one.** Everything is real: a real Keycloak issues the token, the real `KeycloakAuthLayer` validates it, the real router serves the request, a real replica-set Mongo stores the fixture. No `mockall`, no in-memory substitute, no HTTP mocking anywhere under `tests/integration/`. |
| **Test-Driven Development (NON-NEGOTIABLE)** | **Satisfied with a disclosed nuance.** The behaviour under test already exists and is already correct, so a newly written assertion goes green immediately — a compile error is not a meaningful RED. The honest RED for this feature is **mutation**: remove owner scoping from the read path and the cross-tenant tests must fail. That is SC-003, and it is promoted from a final check to the per-story RED gate — see [Verification strategy](#verification-strategy). Every task will carry an executable Verify RED and Verify GREEN per `docs/templates/feature-test-tasks-template.md`. |
| **Security — Secrets Management** | **Satisfied.** The four credentials are read from process env only. `backend/mc-service/.env.local` is gitignored (`.gitignore:506`); CI supplies them from repository secrets and the bring-up-minted `E2E_ROPC_CLIENT_SECRET` already in `$GITHUB_ENV`. No credential is written to a committed file, and no token or password may appear in an assertion message or a log line. |
| **Centralized Access Control** | **Strengthened, not touched.** The tests verify the existing layer from outside; they add no per-handler check. `require_app_role` and `KeycloakAuthLayer` are unmodified. |
| **Behavior-Descriptive Identifiers** | **Satisfied.** Test and helper names state behaviour (`foreign_collection_read_is_not_found_not_forbidden`). No `FR-###`/`SC-###`/`US#` appears in an identifier; requirement provenance goes in the doc comment. Environment-variable names (`E2E_ROPC_*`) are an external contract shared with the frontend E2E suite and are exempt by the same principle. |
| **Logging & Monitoring — Sensitive Data Prohibition** | **Satisfied by design.** The helper must never log or panic-print the access token or the password; the fail-hard message names the *variable*, never the value. |
| **Rust Safety First / minimal vetted dependencies** | **Satisfied.** `reqwest` is already compiled into this workspace's dependency graph; promoting it to a declared dev-dependency adds no package. No second HTTP client is introduced. No `unsafe`. |
| **Backend Quality Standards** | `pnpm nx lint mc-service` (clippy `-D warnings`) must stay clean; `cargo fmt` applied to touched files only (7 untouched files already drift on `main`). |
| **Nx as universal task runner** | **Satisfied.** All verification runs through `pnpm nx test:integration mc-service` / `pnpm nx lint mc-service`. |
| **Technology Agnosticism in Specification** | **Satisfied.** `spec.md` names no library, port, or claim name; every such detail lives here. |

**No violations. [Complexity Tracking](#complexity-tracking) is therefore empty.**

## Project Structure

### Documentation (this feature)

```text
specs/046-authenticated-authz-tests/
├── spec.md              # approved, unchanged by this command
├── HANDOFF.md           # session handoff (measured facts, settled decisions)
├── plan.md              # this file
├── research.md          # Phase 0 — decisions and rejected alternatives
├── data-model.md        # Phase 1 — test-fixture entities and their invariants
├── quickstart.md        # Phase 1 — how to run and validate this feature
├── contracts/
│   ├── authenticated-http-authorization.md   # the HTTP contract being asserted
│   └── test-credential-helper.md             # the helper's public surface
├── checklists/          # pre-existing spec quality checklist
└── tasks.md             # Phase 2 — NOT created by /speckit-plan
```

### Source Code (repository root)

```text
backend/mc-service/
├── Cargo.toml                                  # + reqwest in [dev-dependencies]
└── tests/integration/
    ├── common/
    │   ├── mod.rs                              # + build_test_app_with_db(); + `pub mod auth`
    │   └── auth.rs                             # NEW — ROPC token helper
    ├── collections_test.rs                     # + `pub mod http_authz_test;`
    └── collections/
        ├── mod.rs                              # + `pub mod http_authz_test;`
        └── http_authz_test.rs                  # NEW — every assertion in this feature

.forgejo/workflows/app-ci.yml                   # + 4 `-e` flags on the mc-service docker run
```

**Structure Decision**: the tests land in a **new file inside the existing `collections_test`
binary**, not a new binary. Two reasons, both concrete:

1. The unauthenticated suite from 045 stays byte-identical, so a red result is unambiguously
   attributable to this feature.
2. The guard derives its binary list from the `[[test]]` targets in `Cargo.toml` and requires **every
   discovered binary to execute ≥ 1 test**. A new binary would add a new way for the suite to be
   miscounted; a new module inside an existing binary cannot.

The helper is a sibling module under `common/` rather than a file inside `collections/`, because the
movie-side and any future binary will want it too.

## Design

### 1. Token helper — `tests/integration/common/auth.rs`

Public surface (full contract in
[contracts/test-credential-helper.md](./contracts/test-credential-helper.md)):

```rust
pub async fn user_token() -> String;     // cached bearer token for the seeded test identity
pub async fn user_subject() -> String;   // the `sub` claim of that same token
```

- **Grant**: OAuth2 Resource Owner Password Credentials against
  `{KEYCLOAK_URL}/realms/{KEYCLOAK_REALM}/protocol/openid-connect/token`, client
  `E2E_ROPC_CLIENT_ID` (`mcm-bff-test`) with `E2E_ROPC_CLIENT_SECRET`, user `E2E_TEST_USER` /
  `E2E_TEST_PASSWORD`. Measured working during design: the issued token carries
  `aud ∋ movie-collection-manager` and `resource_access.movie-collection-manager.roles = ["mc-user"]`,
  which is exactly what `build_auth_layer`'s `expected_audiences` and `require_app_role` demand.
- **Caching**: a `tokio::sync::OnceCell` holding `{ access_token, subject }`. One network call per
  test binary; the suite finishes far inside the token's lifetime, so no refresh logic
  (spec Assumptions).
- **Env loading**: `dotenvy::from_filename("backend/mc-service/.env.local")` **and**
  `dotenvy::dotenv()`, both ignoring failure — the same double-attempt `common::test_db()` already
  uses, because the test binary's working directory differs between a repo-root `cargo test
  --manifest-path` run and a package-root run. In CI neither file exists and the values arrive as
  real process env.
- **Fail-hard**: a missing variable panics with a message **naming the variable**; a non-2xx token
  response panics with the status and the endpoint. Never the value. This is FR-007 and it is why
  there is no conditional gate anywhere in the design.
- **Testability of the failure path**: the env read and the JWT-payload decode are extracted as
  **pure functions** returning `Result<_, String>`, so the "names the missing input" requirement is
  asserted directly without mutating process env mid-suite (which `--test-threads=1` would tolerate
  but which would still be a landmine for any future parallel run).
- **Subject extraction**: base64url-decode the JWT's payload segment and read `sub`, using the
  `base64` + `serde_json` crates already in `[dependencies]` (external test binaries link the
  package's normal dependencies as well as its dev-dependencies). No signature verification here —
  the token's authenticity is proven by the service accepting it, which is the point of US2.

### 2. Harness accessor — `tests/integration/common/mod.rs`

Cross-tenant testing needs a fixture owned by *somebody else*, and that cannot be created over HTTP:
every write path stamps `owner_id = token.subject`. It must be seeded through the repository into
**the same database the router is wired to** — and today `build_test_app()` creates that database
internally and drops the handle.

Add one accessor:

```rust
pub async fn build_test_app_with_db() -> (axum::Router, Database);
```

All three public builders (`build_test_app`, `build_test_app_with_auth_instance`,
`build_test_app_with_db`) delegate to a single private constructor that keeps the JWKS readiness
assertion. That property is load-bearing and 045 established it: discovery ending in `Err` still
marks the layer ready, so an ungated path would let the whole suite pass green against a dead
Keycloak. **No new code path may bypass the gate**, which is exactly why this is a delegation and
not a fourth copy.

The new test module calls `adapters::mongodb::indexes::create_indexes(&db)` itself, matching what
`main.rs` does at startup and what every existing repository-level test does. `build_test_app` is
*not* changed to create indexes — that would alter the 045 tests' behaviour for no benefit.

### 3. Test module — `tests/integration/collections/http_authz_test.rs`

Requests are issued in-process with `tower::ServiceExt::oneshot` against the real router (the
established pattern; `Router` is `Clone`, so a multi-request test clones per call). `reqwest` is used
**only** to talk to Keycloak — never to reach the service under test.

| # | Test | Story | Asserts |
|---|---|---|---|
| 1 | `authenticated_create_collection_stamps_authenticated_subject_as_owner` | US2 | `201`; response `ownerId` == `user_subject()` |
| 2 | `authenticated_owner_can_read_own_collection` | US2 | create then `GET` → `200`, same `collectionId` |
| 3 | `authenticated_request_is_never_unauthorized` | US2 | `GET /collections` with the token is neither `401` nor `403` — the control that makes every `404` below interpretable |
| 4 | `foreign_collection_read_is_not_found_not_forbidden` | US1 | `GET` foreign id → `404`, and explicitly `assert_ne!(403)` |
| 5 | `foreign_collection_update_is_not_found_not_forbidden` | US1 | `PATCH` → `404`, not `403`; fixture unchanged in Mongo |
| 6 | `foreign_collection_delete_is_not_found_not_forbidden` | US1 | `DELETE` → `404`, not `403`; fixture still present in Mongo |
| 7 | `foreign_collection_movie_read_is_not_found` | US1 | `GET /collections/{id}/movies/{movieId}` → `404` |
| 8 | `cross_tenant_refusal_body_is_problem_json` | US3 | `content-type: application/problem+json`; body has `type`/`title`/`status`; `status == 404`; `type` ends `COLLECTION_NOT_FOUND` |
| 9 | `authenticated_error_body_carries_no_diagnostics` | US3 | body contains no `panicked`, no backtrace, no source path, no driver error text |
| 10 | `missing_credential_failure_names_the_variable` | Edge / FR-007 | the pure env-reader's `Err` message contains the requested variable name |

Every test drops its database via `common::cleanup_db` before asserting, matching the existing
convention (assert-after-cleanup, so a failure never leaks a database).

Two invariants the fixture itself must assert, or the whole exercise can silently become vacuous:

- the foreign owner's subject **differs** from `user_subject()` — otherwise the "cross-tenant" tests
  would be reading the user's own data and would pass for the wrong reason;
- the foreign fixture **exists in Mongo** at the moment the `404` is observed — otherwise `404` would
  merely mean "absent", not "hidden". Tests 5 and 6 additionally re-read it after the refusal.

### 4. CI wiring — `.forgejo/workflows/app-ci.yml`

The mc-service step already runs cargo inside `rust:1-bookworm` with explicit `-e` flags. Four are
added:

```text
-e E2E_ROPC_CLIENT_ID=mcm-bff-test
-e E2E_ROPC_CLIENT_SECRET      # already in $GITHUB_ENV — minted at bring-up, pinned into the realm import
-e E2E_TEST_USER               # app-e2e job env, from repository secrets
-e E2E_TEST_PASSWORD           # app-e2e job env, from repository secrets
```

All four already exist in that job: the bring-up step writes `E2E_ROPC_CLIENT_SECRET` to
`$GITHUB_ENV` (app-ci.yml:389-390) and the job env carries `E2E_TEST_USER`/`E2E_TEST_PASSWORD`
(app-ci.yml:256-257). The bare `-e NAME` form forwards them without restating a secret in the
workflow file. FR-008 is satisfied by placement: this is the same step that already gates a merge.

## Verification strategy

1. **Prove RED by mutation, per story.** Before each story's tests can be called done, temporarily
   remove owner scoping from the corresponding read path and confirm the new tests fail; restore and
   confirm they pass. This is SC-003 and, for a feature whose subject already works, it is the only
   RED that means anything.
2. **Prove the control is real.** Test 3 must fail if the token is corrupted — a one-character edit
   to the bearer value should turn it `401`.
3. **Run the real gate**: `pnpm nx test:integration mc-service --skip-nx-cache`. The executed count
   must rise from **164** and ignored must stay **0**. A cached Nx run prints only "Successfully ran
   target" and hides the counts — `--skip-nx-cache` is mandatory whenever the numbers matter.
4. **Missing-credential behaviour**: run the suite with `E2E_TEST_PASSWORD` unset and confirm it
   fails naming that variable (SC-005's credential half). The identity-provider-unreachable half is
   already covered by the two guards at the end of `health_test.rs` — leave them alone.
5. **Flake bar**: ≥ 20 consecutive runs, zero failures, matching 045's baseline.
6. **Lint/format**: `pnpm nx lint mc-service` clean; `cargo fmt` on touched files only. `--all-targets`
   has 9 pre-existing failures on clean `main` and is not the gate.
7. **Lock discipline**: `git diff Cargo.lock` must show only `mc-service`'s own dependency list
   gaining `reqwest` — **no new `[[package]]` block**.

## Risks

| # | Risk | Mitigation / status |
|---|---|---|
| R1 | **CI's mc-service step now depends on a working ROPC login**, not just a reachable Keycloak. A realm-import regression fails this step. | Accepted deliberately, and it is the same trade 045 made for JWKS. The failure is loud and names the endpoint. The realm import already pins the same client the BFF integration suite logs in through, so the two fail together rather than mysteriously. |
| R2 | **Credential duplication** — the four values now live in `backend/mc-service/.env.local` as well as `frontend/mcm-app/.env.e2e.local`. | Owner-approved during design; the alternative was a Rust test reading the frontend project's env file. Both files are gitignored. Documented in [quickstart.md](./quickstart.md). |
| R3 | **`reqwest` feature drift** — if `axum-keycloak-auth` later drops the TLS features this crate relies on, an `https` Keycloak would stop resolving. | Declare the dev-dependency with explicit `default-features = false, features = ["json", "rustls-tls"]` so the requirement is stated rather than inherited. `rustls`/`hyper-rustls`/`webpki-roots` are already in the lock, so this adds no package. See [research.md](./research.md) R2. |
| R4 | **A future parallel run** (`--test-threads > 1`) could make the `OnceCell` contend or make an env-mutating test racy. | The helper is `OnceCell`-based (safe under contention) and no test mutates process env — the failure-message assertion targets a pure function precisely for this reason. |
| R5 | **The `403` gap stays open.** `require_app_role`'s refusal remains unverified at the HTTP boundary. | Deferred with its prerequisite recorded in spec § Out of Scope: it needs a role-less identity, and the realm is runtime-managed with no committed source. It guards a small centralized check; the isolation boundary this feature covers is the security-critical one. |

## Post-design Constitution re-check

Re-evaluated after Phase 1. No gate changed status. The design added one production-adjacent file to
the touch list (`Cargo.toml`) and one harness accessor, neither of which alters runtime behaviour:
`build_test_app_with_db` is additive and delegates through the same JWKS gate, and the dev-dependency
is invisible to the `mc-service` binary. **FR-010 (no production authorization change) holds by
construction — `src/` is not touched at all.**

## Complexity Tracking

*No constitution violations. This section is intentionally empty.*
