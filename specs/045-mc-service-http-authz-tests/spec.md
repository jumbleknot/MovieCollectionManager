# Feature Specification: mc-service HTTP-layer authorization test enablement

**Feature Branch**: `mc-service-http-authz-tests`

**Created**: 2026-08-01

**Status**: **Backfilled retrospectively** — the implementation shipped in PR #126 *before* this
artifact set existed. See §Process deviation.

**Input**: `docs/proposals/PRD-McServiceHttpAuthzIntegration.md` (G1, G3, G4, G5)

---

## Process deviation (read first)

This spec was written **after** the code, which inverts the mandatory
[proposal → spec → plan → tasks → implementation](../../openwiki/process/spec-driven-development.md)
lifecycle. It is recorded here rather than quietly normalised.

- **What happened.** The owner asked for the PRD's §3.1 go/no-go spike (legitimately outside SDD —
  it is investigation, and the PRD gates the whole proposal on it). When the spike passed, the
  follow-up instruction "do it" was executed straight into implementation: 13 files, including three
  production files, with no spec/plan/tasks set.
- **Why it was not caught.** The rule was known — it was surfaced mid-session from stored memory and
  then deprioritised as "flag it in the PR body" rather than "stop and write the spec". That is a
  process failure, not a discoverability one.
- **Disposition.** The owner elected to keep the shipped work and backfill this set rather than
  revert and re-run the lifecycle. The two preventative fixes are a hard SDD gate at the top of
  [CLAUDE.md](../../CLAUDE.md) and a PR-mechanics index entry alongside it.
- **Consequence for this document.** Requirements below are written to describe the *shipped*
  behaviour and are already satisfied. Nothing here is speculative; every success criterion cites
  measured evidence.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - An authorization regression at the mc-service HTTP boundary fails the build (Priority: P1)

A developer removes, reorders, or narrows the centralized auth layer on the `/api/v1` sub-router —
the kind of change that leaves every happy-path test green because authenticated requests still
work. CI must go red on the change itself, not months later in production.

**Why this priority**: This is the entire reason the proposal exists. mc-service authorization is
enforced as a *layer, not a per-handler check*
([role-enforcement-is-a-layer](../../openwiki/gotchas/role-enforcement-is-a-layer.md)), so its
failure mode is silent: a broken layer serves 200 where it should serve 401/403 and no happy-path
suite notices. Before this work that negative behaviour was verified nowhere in-process — 21 tests
that should have covered it were `#[ignore]`d.

**Independent Test**: Delete `.layer(auth_layer)` from the protected sub-router in `router.rs` and
run `pnpm nx test:integration mc-service`. The suite must fail.

**Acceptance Scenarios**:

1. **Given** the auth layer is correctly mounted, **When** an unauthenticated request is made to any
   `/api/v1` endpoint, **Then** the response is `401` and the suite is green.
2. **Given** the auth layer has been deleted from the protected sub-router, **When** the integration
   suite runs, **Then** it fails, naming the endpoints that no longer reject anonymous callers.
3. **Given** a route exists but is not wired, **When** it is requested without a JWT, **Then** it
   returns `404` — so a `401` is positive evidence of "wired *and* protected".
4. **Given** `/health` and `/metrics`, **When** they are requested without a JWT, **Then** they
   return `200` — the layer is scoped to the protected sub-router only.

---

### User Story 2 - The auth suite cannot pass for the wrong reason (Priority: P1)

The suite must be trustworthy in the specific way feature 041 exists to establish: it must fail when
the thing it tests is broken, *and* it must not pass when its own preconditions are absent.

**Why this priority**: Equal-priority with US1 because a green-but-meaningless suite is worse than
an ignored one — it actively misleads. This is not hypothetical: it is the measured default. OIDC
discovery that ends in `Err` still increments the readiness counter, so a service pointed at a dead
Keycloak reports ready and still answers `401` to an anonymous request. Every 401 assertion would
pass with **no identity provider at all**.

**Independent Test**: Point the auth instance at an unreachable Keycloak and confirm the harness
refuses to proceed rather than returning a green 401.

**Acceptance Scenarios**:

1. **Given** Keycloak is unreachable, **When** the shared harness builds an app, **Then** it fails
   with a message naming the unreachable URL — it does not run assertions.
2. **Given** Keycloak is unreachable, **When** an unauthenticated request is issued through an
   *ungated* auth layer, **Then** it still returns `401` — the false green, retained as an
   executable guard so the gate cannot be "simplified" away.

---

### User Story 3 - The suite is deterministic in-process (Priority: P2)

HTTP-layer auth tests run in-process on every PR without reintroducing the flakiness that feature
041 eliminated.

**Why this priority**: P2 because it is the enabler rather than the value. Without it US1 and US2
cannot run at all; with it they are ordinary tests.

**Independent Test**: Run the integration binaries ≥20 consecutive times and observe zero failures.

**Acceptance Scenarios**:

1. **Given** the readiness gate, **When** the suite runs 20 consecutive times, **Then** there are
   zero failures and zero panics.
2. **Given** a test binary using the shared harness, **When** the first protected request is issued,
   **Then** `axum-keycloak-auth`'s `is_pending()` assertion is never evaluated.

---

### Edge Cases

- **Discovery succeeds, then the JWKS endpoint later fails.** Out of scope: `version()` never
  returns to 0, so the readiness branch is not re-entered. Token *validation* failures are a
  different concern, deferred with G2.
- **Keycloak slow to start in CI.** The gate is bounded by a 30s timeout and fails with an
  actionable message rather than hanging.
- **A test binary that never builds an app** (pure adapter tests) is unaffected — it does not touch
  the gate.
- **Unrouted `/api/v1` paths** return `404`, not `401`; verified rather than assumed.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The shared test harness MUST wait for Keycloak OIDC discovery to **succeed** before
  issuing any request through the auth layer.
- **FR-002**: The harness MUST fail the test, with the offending URL named, when discovery does not
  succeed within a bounded timeout. It MUST NOT proceed to assertions.
- **FR-003**: Every HTTP-level integration test MUST obtain its router from the single shared
  harness, so the gate cannot be omitted in one binary.
- **FR-004**: All auth-negative and route-wiring tests MUST execute in CI — no `#[ignore]`.
- **FR-005**: Tests asserting behaviour at a layer that, by design, does not implement it MUST be
  deleted rather than ignored.
- **FR-006**: The request-completion log event MUST carry `duration_ms` as a JSON **number**, and
  `request_id`/`method`/`path` on the `request` span, per T015b and
  [logging-and-audit](../../openwiki/invariants/logging-and-audit.md).
- **FR-007**: Production auth behaviour MUST be unchanged; the enabling production change MUST be
  limited to exposing the existing auth instance to callers.
- **FR-008**: The false-green condition MUST remain covered by an executable test, not only prose.

### Key Entities

- **`KeycloakAuthInstance` handle** — the OIDC discovery owner. Previously constructed and dropped
  inside `router::build`; now also returned so callers can await readiness.
- **Readiness gate** — a bounded condition-based wait on `is_operational()`.
- **Shared harness** — `tests/integration/common`: `build_test_app`,
  `build_test_app_with_auth_instance`, `wait_until_operational`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The mc-service integration suite reports **zero ignored tests**. *Measured: guard went
  from 151 executed / 21 ignored to **164 executed / 0 ignored / 0 failed**.*
- **SC-002**: A deliberate removal of the centralized auth layer turns the suite red. *Measured: 7
  tests fail (`health_test::protected_routes_require_auth` + 6 in `collections::http_test`); green
  again on restore.*
- **SC-003**: The suite is flake-free across ≥20 consecutive runs. *Measured: 20 rounds × 3 binaries
  = 60 runs, 0 failures, 0 panics — 3,280 test executions; plus 20 further rounds of the auth surface
  alone, 0/60.*
- **SC-004**: Wall clock stays bounded. *Measured: ~48–58s per full round, stable across all 20
  rounds; gated HTTP tests ~90–96 ms each.*
- **SC-005**: No happy-path CRUD test is un-ignored. *Met vacuously — no such ignored tests existed;
  see the scope correction below.*

### Scope correction against the PRD

The PRD's §1 table did not match the tree. Enumerated:

| PRD §1 claimed | Actually present |
|---|---|
| ~6–8 auth-negative to un-ignore | **18**, all token-free |
| ~11 happy-path CRUD, keep ignored | **zero — none exist** |
| 2 wrong-layer `create_test` to delete | 2 ✓ |
| (uncounted) tracing conflict | 1 |

Consequence: the ROPC token helper was **never a prerequisite**; it is required only for *new* 403
role/ownership tests.

## Assumptions

- app-ci's mc-service step provides a reachable Keycloak. **Verified**, not assumed: the step
  exports `KEYCLOAK_URL=http://localhost:8099`, realm, client id, and runs `--network host`.
- `axum-keycloak-auth` stays at 0.8.3 (the latest published version; no bump exists).
- The `duration_ms` type change is safe for downstream consumers — string `"0"` → number `0`. **This
  is the one behavioural change in the diff and the only assumption not independently verified.**

## Out of Scope

- **G2 — the ROPC token helper**, and therefore any 403 ownership test, OR-role assertion, or
  `application/problem+json` assertion on an authenticated error. The audience-mapper requirement
  remains untested. This is the sole outstanding item of the parent PRD.
- A production readiness gate for mc-service startup. The same assert is theoretically reachable in
  production before the discovery task is first polled; judged practically unreachable (the server
  binds and awaits first, on a multi-thread runtime). `build_with_auth_handle` makes such a gate
  possible if ever wanted.
- Replacing or reducing the web/mobile E2E legs.
