# Implementation Plan: mc-service HTTP-layer authorization test enablement

**Branch**: `mc-service-http-authz-tests` | **Date**: 2026-08-01 | **Spec**: [spec.md](./spec.md)

**Status**: **Backfilled retrospectively** — records what was built and why, in PR #126. See the
process-deviation note in [spec.md](./spec.md).

## Summary

21 mc-service integration tests were `#[ignore]`d behind a reason that turned out to be wrong. The
root cause is a deterministic ordering bug in `axum-keycloak-auth` 0.8.3, not JWKS flakiness. The fix
is a condition-based readiness gate in the shared test harness, enabled by returning the existing
`KeycloakAuthInstance` from the router builder. That un-ignores 18 tests, deletes 2 that assert at
the wrong layer, and fixes 1 whose stated blocker did not exist.

## Technical Context

**Language/Version**: Rust 1.97 (edition 2021)

**Primary Dependencies**: `axum` 0.8, `axum-keycloak-auth` **0.8.3 (latest published — no bump
available)**, `tower`, `tokio`, `tracing` / `tracing-subscriber`

**Storage**: MongoDB replica set (`rs0`) for the integration DB; Keycloak realm `grumpyrobot` for JWKS

**Testing**: `cargo test` via `scripts/mc-service-integration-guard.mjs`, run through Nx
(`pnpm nx test:integration mc-service`) per [nx-task-runner](../../openwiki/invariants/nx-task-runner.md)

**Target Platform**: Linux; in CI a `rust:1-bookworm` container with `--network host`

**Project Type**: Rust/Axum microservice (backend)

**Performance Goals**: no measurable added wall clock; the gate is tens of ms per app build

**Constraints**: no dependency bump; no change to production auth behaviour; must not reintroduce
the flakiness feature 041 eliminated

**Scale/Scope**: 13 files — 3 production, 8 test, 2 docs

## Constitution Check

*GATE: re-checked after implementation, since this plan is retrospective.*

| Principle | Status |
|---|---|
| **Centralized Access Control** | **Strengthened.** The layer-not-handler design is now verified negatively at the HTTP boundary; SC-002 proves the suite fails when the layer is removed. No per-handler auth was introduced. |
| **Clean Architecture** | **Strengthened.** The 2 deleted tests asserted adapter-layer enforcement of application-layer rules; deleting them removes a standing invitation to move validation into the adapter. |
| **Test-first / RED→GREEN** | **Partially violated, disclosed.** Tests pre-existed (written RED long ago) so the un-ignoring is arguably GREEN-first. The two *new* guards and the logging fix were written against observed failures and confirmed to fail before passing. The whole change bypassed SDD sequencing — see spec.md. |
| **Structured logging & audit** | **Corrected.** `duration_ms` now honours the numeric contract. |
| **Nx as universal task runner** | Respected — verification via the Nx target and its guard. |

**Deviation requiring human approval**: the SDD sequencing violation. Raised with the owner, who
elected to keep the work and backfill. Recorded rather than waived silently.

## Root cause (the decisive finding)

Read from the crate source, not inferred:

1. `Action::dispatch()` performs all its work — including `pending.store(true)` — **inside** a
   `tokio::spawn`.
2. `KeycloakAuthService::poll_ready` asserts `discovery.is_pending()` whenever
   `discovery.version() == 0`.
3. `#[tokio::test]` uses a **current-thread** runtime; nothing yields between
   `KeycloakAuthInstance::new()` and the first request, so the spawned discovery task has never been
   polled: `pending == false` **and** `version == 0` → the assert fires.

Reproduced **100% of the time, in 0.05s**, in isolation. It read as intermittent only because any
incidental yield point hides it.

## Options considered

| Option | Verdict |
|---|---|
| **A1 — bare `tokio::task::yield_now()`** before the first request | **Rejected.** Works, and needs no production change — but `version` is incremented even when discovery ends in `Err`, so the entire 401 suite passes against a dead Keycloak. Retained as an executable guard demonstrating the false green. |
| **A2 — condition-based wait on `is_operational()`** | **Chosen.** Airtight regardless of runtime flavour: once true, `version() > 0` permanently and the asserting branch is unreachable for the life of the process. Also guarantees JWKS is genuinely loaded. |
| **B — bump `axum-keycloak-auth`** | **Unavailable.** 0.8.3 is the latest published version. |
| **Do nothing; rely on E2E** | **Rejected on evidence.** The spike passed, so the PRD's own kill criterion was not met. |

## Design

`KeycloakAuthLayer::instance` is a public `Arc<KeycloakAuthInstance>` with a `setter(into)` builder,
so the instance can be shared with the caller without restructuring the layer.

- `router::build_with_auth_handle(db, config) -> (Router, Arc<KeycloakAuthInstance>)` — new; contains
  the former body of `build`.
- `router::build(db, config) -> Router` — now delegates and drops the handle. **Byte-identical
  wiring**; `main.rs` is untouched.
- `middleware::auth::build_auth_layer` takes `Arc<KeycloakAuthInstance>` instead of a value.
- `common::wait_until_operational(instance, timeout) -> bool` — polls `is_operational()` every 10 ms
  up to a 30 s bound. Bounded, so a dead dependency fails loudly instead of hanging
  (per `condition-based-waiting`, not an arbitrary sleep).
- `common::build_test_app()` / `build_test_app_with_auth_instance()` — the single gated entry point,
  replacing **five duplicated `build_test_app()` copies**. Consolidation is load-bearing, not tidiness:
  it makes omitting the gate impossible in one binary.

## Project Structure

```
backend/mc-service/
├── src/api/
│   ├── router.rs                         # build_with_auth_handle (new) + build delegates
│   └── middleware/
│       ├── auth.rs                       # build_auth_layer takes Arc<…>
│       └── logging.rs                    # duration_ms as u64
└── tests/integration/
    ├── common/mod.rs                     # gate + shared harness
    ├── health_test.rs                    # un-ignored; logging fixed; 2 false-green guards
    ├── collections/http_test.rs          # un-ignored (7)
    └── movies/
        ├── http_list_test.rs             # un-ignored (5)
        ├── http_create_update_test.rs    # un-ignored (3)
        ├── http_delete_test.rs           # un-ignored (2)
        └── create_test.rs                # 2 wrong-layer tests deleted
.forgejo/workflows/app-ci.yml             # stale "stays ignored" comment corrected
```

## Verification strategy

1. **Reproduce before fixing** — confirm the ignored test fails, and why.
2. **Isolate the variable** — a spike binary comparing gated vs ungated with an otherwise identical
   router, plus dead-Keycloak cases. Removed once its findings became permanent guards.
3. **Prove it bites (SC-002)** — delete `.layer(auth_layer)`, confirm red, restore, confirm green.
4. **Measure flake-freedom (SC-003)** — 20 consecutive rounds of all three binaries.
5. **Run the real gate** — `scripts/mc-service-integration-guard.mjs`, plus
   `cargo clippy -p mc-service -- -D warnings`.

## Risks

- **R1 — reintroducing flakiness.** Retired: 0 failures across 60 runs, and the race is structurally
  removed rather than narrowed.
- **R2 — dep-bump churn.** Not applicable; no bump.
- **R3 — CI now depends on a reachable Keycloak** where the step was previously
  Keycloak-independent (everything was ignored). Verified satisfied by the existing job env; the
  trade is deliberate — a Keycloak regression now fails loudly instead of skipping to green.
- **R4 — `duration_ms` type change** from JSON string to number. Correct per T015b, but it is the
  one non-neutral change; flagged for review in PR #126.
