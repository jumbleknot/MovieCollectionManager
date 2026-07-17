# Implementation Plan: Integration-Test CI Enforcement

**Branch**: `041-integration-test-ci-enforcement` | **Date**: 2026-07-17 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/041-integration-test-ci-enforcement/spec.md`

## Summary

Enforce the integration-test tier in CI for all three projects. PR #77 wired the **agent** integration suite
into the `app-e2e` job and exposed 8 pre-existing failures now excluded via `@pytest.mark.ci_quarantine`. This
feature (a) fixes and un-quarantines all 8 agent tests so the gate reverts to `-m "not golden"`, (b) adds an
`mc-service test:integration` step to `app-e2e` against the already-running replica-set Mongo, (c) adds an
`mcm-app test:integration` step against the already-running Keycloak + Redis + BFF, and (d) generalizes PR #77's
skip-must-fail discipline into one shared, cross-language convention with a documented per-suite legitimate-skip
allowlist. The `app-e2e` job already stands up every real dependency all three suites need — the work is wiring +
the existing skip-escalation guarantee + per-test remediation of the 8 agent defects, not new infrastructure.

## Technical Context

**Language/Version**: CI workflow (Forgejo Actions YAML) + Python 3.13 (agent suite, `uv`/pytest) + Rust (mc-service,
`cargo test` via `@monodon/rust`) + TypeScript/Node 20 (mcm-app BFF, `jest`). No new language introduced.

**Primary Dependencies**: Existing `app-e2e` stack bring-up (`auth` + `mcm` Compose projects, `up-agents-prod`);
`pnpm nx test:integration <project>`; the agent `conftest.py` skip-escalation hook; the mcm-app
`jest.integration.config.js` + `tests/integration/setup/env.ts`; the mc-service `tests/integration/common/mod.rs`
harness. Golden-cassette harness for any relocated model-decision assertions.

**Storage**: Reuses the running stack's real stores — replica-set `mc-service-store-mongo` (host `27017`, member
`localhost:27017`, `directConnection=true`), `mcm-bff-store-mongo` (host `27018`), `mcm-bff-cache-redis` (host
`6379`, tests pin **db 1**). No new stores.

**Testing**: pytest (agent), `cargo test --tests --test-threads=1` (mc-service), `jest --config
jest.integration.config.js` (mcm-app) — all via Nx targets. Real dependencies only (constitution §Test Type
Integrity); no mocking in any `tests/integration/`.

**Target Platform**: The self-hosted `kvm` host runner that already runs `app-e2e` (persistent, rootless Docker,
KVM). Rust toolchain install pattern already proven in `mc-service-checks`.

**Project Type**: Web application monorepo (Rust backend service + Expo/React-Native BFF frontend + Python agent
layer), CI/CD on the homelab Forgejo forge.

**Performance Goals**: Bounded, justified `app-e2e` wall-clock increase — the two new suites run in minutes on the
already-warm stack, before the ~15-min emulator legs, preserving fast-fail ordering. No target beyond "small and
justified" (SC-006).

**Constraints**: No new host ports (reuse published `27017`/`27018`/`6379`/`3001`/`8082`/`8099`); no new secrets
(reuse Forgejo Actions store + `gen-ci-env`); no mocking in integration suites; prod/CI port isolation and the
secret/naming/collision gates stay green; a misconfigured run must FAIL, never skip-to-green (no-false-green).

**Scale/Scope**: 8 agent tests to remediate across 4 files; 2 new CI steps in one workflow job; 1 shared
skip-escalation convention spanning 3 languages; 1 marker + filter removal; docs update. Single feature branch.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Assessment |
|---|---|
| **Test Type Integrity (NON-NEGOTIABLE)** | ✅ This feature *enforces* the principle. All three suites run against **real** Keycloak/Redis/Mongo/downstream services; no mocking is introduced. Any relocation of a model-decision assertion goes to the golden-cassette harness (record/replay of a real model), not to a mock. |
| **TDD (NON-NEGOTIABLE)** | ✅ The tests pre-exist. The "Verify RED" analog is the **broken-on-purpose** acceptance check (SC-003/AC2/AC3): a deliberate regression must turn each suite red, proving the gate bites before we trust the green. For the add-persist item, if diagnosis reveals a real product bug, the already-RED test drives the fix (classic TDD). |
| **Behavior-Descriptive Identifiers** | ✅ Any new artifact (a shared skip-preflight module, a legitimate-skip allowlist) is named for behavior, not `FR-###`; requirement IDs live in comments only. The existing `ci_quarantine` marker is **removed**, not renamed. |
| **Nx primary invocation** | ✅ Every suite runs via `pnpm nx test:integration <project>`; no direct pnpm/cargo call becomes the primary path. |
| **Secrets Management** | ✅ No new literals. Reuses Forgejo Actions secrets + `gen-ci-env.mjs` + `gen-dev-secrets.mjs`; the mc-service/mcm-app suites read creds from the env the job already provisions. |
| **Backend testing standards** | ✅ mc-service integration tests validate API contracts against a real replica-set Mongo + real Keycloak JWKS, run via Nx. |
| **Prod/CI port isolation (feature 029)** | ✅ No new published ports; the collision gate stays green. |
| **Logging/Monitoring, Auth, Clean Architecture, Frontend layering** | ➖ Not materially touched — this is test-enablement + CI wiring. A product fix arising from the add-persist diagnosis must itself comply (e.g. any mc-service change stays within Clean Architecture). |

**Result**: PASS. No violations; Complexity Tracking not required.

## Project Structure

### Documentation (this feature)

```text
specs/041-integration-test-ci-enforcement/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0 output — the 6 resolved decisions
├── data-model.md        # Phase 1 output — suites, markers, skip-escalation config shape
├── quickstart.md        # Phase 1 output — run each suite locally + prove the gate bites
├── contracts/
│   ├── app-e2e-integration-steps.md   # CI step contract (env, ports, pass/fail) for B + C + reverted A
│   └── skip-escalation-convention.md  # the cross-language no-false-green contract
├── checklists/
│   └── requirements.md  # spec quality checklist (from /speckit-specify)
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
.forgejo/workflows/
└── app-ci.yml                          # app-e2e job: revert agent filter to `-m "not golden"`;
                                        #   + "mc-service integration tests" step (Rust toolchain + MC_DB_URL + KEYCLOAK_URL)
                                        #   + "BFF integration tests" step (BFF_BASE_URL + Keycloak + Redis db1 + Mongo 27018)

agents/movie-assistant/
├── pyproject.toml                      # remove the `ci_quarantine` marker registration once unused
└── tests/
    ├── integration/
    │   ├── test_curator_enrich.py      # bucket A (TMDB ×3): un-quarantine after provisioning/diagnosis fix
    │   ├── test_resolution_realistic.py# bucket A (TMDB ×1): un-quarantine
    │   ├── test_query_flow.py          # bucket B (tool-choice ×2): relocate to golden / loosen / fix prompt
    │   ├── test_search_flow.py         # bucket B (tool-choice ×1): relocate to golden / loosen / fix prompt
    │   └── test_gateway_add_e2e.py     # bucket C (add-persist ×1): diagnose real-bug vs flake, then fix
    └── golden/                         # destination for any relocated model-decision assertions (bucket B)

frontend/mcm-app/tests/integration/setup/
└── env.ts (+ a small dependency preflight)  # skip-escalation for jest: hard-fail when a required dep is down

backend/mc-service/tests/integration/
└── common/mod.rs                       # already `.expect()`s the Mongo connection (hard-fail); add a
                                        #   run-executed guard so an all-`#[ignore]` run cannot pass green

docs/runbooks/                          # + CLAUDE.md Test Run Protocol: integration tier now runs in CI
                                        #   for all 3 projects; how to run each locally against the stack
```

**Structure Decision**: No new project or module. Changes are surgical edits to one CI workflow file, the agent
test suite (+ its golden harness and any product/prompt fix the diagnosis requires), the two other suites' minimal
skip-escalation preflight, and documentation. The feature deliberately **reuses** the `app-e2e` stack rather than
provisioning a separate integration-test stack (spec Assumption; PRD Non-Goal).

## Complexity Tracking

> No Constitution Check violations — this section intentionally left empty.
