# Tasks: mc-service HTTP-layer authorization test enablement

**Branch**: `mc-service-http-authz-tests` | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

**Status**: **Backfilled retrospectively.** Every task below was completed in PR #126 before this
file existed. Checkboxes record what actually happened, with the evidence that closed each one; they
are not a forward plan. The RED/GREEN column is filled in honestly — where a task did not follow the
tasks-template's Verify-RED-then-GREEN order, it says so.

---

## Phase 0: Go/no-go spike (PRD §3.1)

- [x] **T001** Reproduce the failure and read the crate source for the mechanism.
  **RED**: `cargo test --test health_test protected_routes_require_auth -- --ignored` panics at
  `axum-keycloak-auth-0.8.3/src/service.rs:62`, `assertion failed: …is_pending()`, in 0.05s, on the
  first attempt. Root cause: `Action::dispatch` sets `pending` inside `tokio::spawn`; nothing yields
  before the first `poll_ready` on a current-thread runtime.
- [x] **T002** Assess Option B (dependency bump). `cargo search` → **0.8.3 is the latest published
  version**; no bump exists. Option A is the only path.
- [x] **T003** Prove a readiness gate makes the first request deterministic, with the router the only
  controlled variable. 8-test spike binary: control panics (`#[should_panic]`), gated returns 401.
- [x] **T004** Characterise the cheap alternative and its failure mode. A bare `yield_now()` also
  silences the assert **but** returns a green 401 against an unreachable Keycloak — `version` is
  incremented even on `Err`. Decides A2 over A1.
- [x] **T005** Measure the flake bar on the spike. 20 sequential + 20 parallel runs, **0 failures**.
- [x] **T006** Record the go/no-go outcome in the PRD (§3.1a) — **GO**.

## Phase 1: Enabler (production, behaviour-neutral)

- [x] **T007** Add `router::build_with_auth_handle` returning `(Router, Arc<KeycloakAuthInstance>)`;
  make `build` delegate and drop the handle.
  *Verified*: `cargo build` clean; `main.rs` untouched; wiring unchanged.
- [x] **T008** Change `build_auth_layer` to take `Arc<KeycloakAuthInstance>` (the builder field is
  already `Arc` with `setter(into)`).

## Phase 2: Shared harness (US3 — determinism)

- [x] **T009** Add `common::wait_until_operational(instance, timeout)` — bounded condition-based
  poll, returns `false` on timeout rather than hanging.
- [x] **T010** Add `common::build_test_app` / `build_test_app_with_auth_instance`, asserting the gate
  with a message naming the unreachable URL. Satisfies **FR-001, FR-002**.
- [x] **T011** Collapse the **five** duplicated `build_test_app()` copies (health_test,
  http_list_test, http_create_update_test, http_delete_test, collections/http_test) onto the shared
  harness. Satisfies **FR-003**.
  *Note*: `#![allow(dead_code)]` added to `common/mod.rs` — each binary uses a different subset, so
  the warnings are structural.

## Phase 3: US1 — the regression must fail the build

- [x] **T012** Un-ignore the 18 auth-negative / route-wiring tests across 5 files. Satisfies
  **FR-004**.
  *Deviation from the tasks-template RED/GREEN order*: these tests were authored RED historically and
  were simply re-enabled, so no new RED step preceded them. The equivalent evidence is T016.
- [x] **T013** Verify measured route-wiring semantics rather than assuming them. An unrouted
  `/api/v1` path returns **404**, not 401 — so `401` is positive evidence of "wired and protected".
  *(This corrected an assumption made during implementation: the first version of the check asserted
  401 and failed.)*
- [x] **T014** Delete the 2 wrong-layer `create_test` cases. Satisfies **FR-005**.
  *Checked first*: their named replacements exist and are active in `http_create_update_test.rs`, so
  coverage is preserved.

## Phase 4: US2 — the suite must not pass for the wrong reason

- [x] **T015** Add the two permanent guards to `health_test.rs`:
  `unauthenticated_401_is_returned_even_when_keycloak_is_unreachable` (the false green, demonstrated)
  and `readiness_gate_reports_not_operational_for_unreachable_keycloak` (the gate has teeth).
  Satisfies **FR-008**. Retire the spike binary and its `[[test]]` entry.
- [x] **T016** **Broken-on-purpose proof (SC-002).**
  **RED**: with `.layer(auth_layer)` deleted from the protected sub-router, **7 tests fail** —
  `health_test::protected_routes_require_auth` + 6 in `collections::http_test`.
  **GREEN**: restored → all pass.
  *Finding*: `list_collections_route_is_wired_not_404` stayed green under the break — correct for
  what it asserts, but it means wiring tests alone would not catch a dropped auth layer.

## Phase 5: G5 — the logging test

- [x] **T017** Determine why `logging_middleware_emits_structured_json` was ignored.
  **The stated reason was false**: no global tracing subscriber exists anywhere in `src/` or
  `tests/`, so there was no "subscriber conflict".
- [x] **T018** Fix the assertion shape. The middleware emits a `request` **span** plus a
  `request completed` **event**; the test looked for a flat `message == "request"` with span fields
  inline. Confirmed against
  [logging-and-audit](../../openwiki/invariants/logging-and-audit.md) ("correlation via a per-request
  `request_id` span") that the implementation, not the contract, was authoritative here.
- [x] **T019** Fix `duration_ms`. **RED**: captured line showed `"duration_ms":"0"` — a **string**,
  because `Duration::as_millis()` returns `u128`, which `tracing` renders via `Debug`.
  **GREEN**: cast to `u64` in `logging.rs`; field is now a JSON number. Satisfies **FR-006**.
  *This is the only non-behaviour-neutral production change in the feature.*

## Phase 6: Verification & documentation

- [x] **T020** Full gate: `scripts/mc-service-integration-guard.mjs` → **164 executed, 0 ignored,
  0 failed** (was 151 / 21 ignored). **SC-001**.
- [x] **T021** Flake bar: 20 rounds × 3 binaries = **60 runs, 0 failures, 0 panics** (3,280
  executions); plus 20 further rounds of the auth surface alone (0/60). Per-round wall clock stable
  at ~48–58 s. **SC-003, SC-004**.
- [x] **T022** `cargo clippy -p mc-service -- -D warnings` clean. Formatted only the files touched;
  pre-existing drift in 7 untouched files deliberately left alone.
- [x] **T023** Verify CI provides a reachable Keycloak, since the step is no longer
  Keycloak-independent. `app-ci.yml` already exports `KEYCLOAK_URL=http://localhost:8099`, realm,
  client id, and runs `--network host`. Corrected that step's now-false "tests stay ignored" comment.
- [x] **T024** Update `docs/proposals/PRD-McServiceHttpAuthzIntegration.md` (§3.1a spike, §3.2a
  implementation, §4a results, scope-table correction) and the stale
  `specs/041-…/IMPLEMENTATION-STATUS.md` pointer.

## Phase 7: Process remediation (after the deviation was raised)

- [x] **T025** Add a hard SDD gate and the PR-mechanics pointer to the top of
  [CLAUDE.md](../../CLAUDE.md); verify with `node scripts/check-openwiki-governance.mjs` (G8 requires
  every line to carry a link; G9 requires targets to resolve).
- [x] **T026** Backfill this spec/plan/tasks set, disclosing the deviation rather than normalising it.

---

## Not done — carried to the parent PRD

- [ ] **G2 — ROPC token helper** (`tests/integration/common/auth.rs`): mint owner `mc-user`, a second
  non-owner `mc-user`, and an `mc-admin` against the live Keycloak; ensure the audience mapper so
  tokens pass `KeycloakAuthLayer` validation.
- [ ] **G2a** — 403 ownership test (non-owner writing an owned resource).
- [ ] **G2b** — OR-role assertion (`mc-user` OR `mc-admin`), which the layer cannot express natively
  and `require_app_role` implements.
- [ ] **G2c** — `application/problem+json` shape + status assertions on an authenticated error
  ([rfc-9457-problem-details](../../openwiki/gotchas/rfc-9457-problem-details.md)).

These are the sole outstanding items of `docs/proposals/PRD-McServiceHttpAuthzIntegration.md`. None
blocks the shipped work; all require the token helper first.
