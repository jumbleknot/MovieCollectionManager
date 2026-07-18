# HANDOFF — Feature 041: Integration-Test CI Enforcement

**For**: a fresh implementation session. **Date**: 2026-07-17. **Branch**: `041-integration-test-ci-enforcement`
(off `main`).

## TL;DR

SDD planning is complete (spec → plan → research → data-model → contracts → tasks, analyzed + remediated). No
implementation code has been written yet. Start at [tasks.md](./tasks.md) T001. **Read the authoritative memory
`project_mcm_agent_integration_ci` FIRST** — it holds the per-test quarantine buckets and un-quarantine plan that
Workstream A (US1) executes.

## What this feature does

Enforce the integration-test tier in CI for all three projects (the tier the constitution mandates but PR #77
proved was unenforced):

- **US1 (P1, MVP)** — fix + un-quarantine all **8** `@pytest.mark.ci_quarantine` agent tests; revert the `app-ci`
  agent step from `-m "not golden and not ci_quarantine"` to `-m "not golden"`.
- **US2 (P2)** — run `mc-service test:integration` in the `app-e2e` job against the already-running replica-set
  Mongo (+ Keycloak JWKS).
- **US3 (P3)** — run `mcm-app test:integration` in `app-e2e` against the already-running BFF + Keycloak + Redis.
- **US4 (P1)** — one shared, cross-language **skip-must-fail** convention so a misconfigured run fails loudly,
  never skips-to-green.

Reuses the **existing** `app-e2e` stack — no new integration stack, no new host ports, no new secrets.

## State of the artifacts (all in `specs/041-integration-test-ci-enforcement/`)

| File | Status |
|---|---|
| spec.md | Complete — 4 user stories, 14 FR, 7 SC, checklist all-pass |
| plan.md | Complete — Constitution Check PASS; tech context; change surface |
| research.md | Complete — 6 decisions (D1–D6) resolving every unknown |
| data-model.md | Complete — suites, marker, skip-convention shape, CI-step wiring |
| contracts/app-e2e-integration-steps.md | Complete — env/ports/pass-fail for Steps A/B/C |
| contracts/skip-escalation-convention.md | Complete — one flag, three runner guards, allowlist policy |
| quickstart.md | Complete — run each suite locally + prove each gate bites |
| tasks.md | Complete — **37 tasks** (T001–T037), analyzed + remediated (C1/C2/D1) |

**Uncommitted**: the whole `specs/041-…/` dir is untracked; `.specify/feature.json` and `CLAUDE.md` (SPECKIT plan
pointer) are modified. **First action in the fresh session: commit these planning artifacts** (a git-commit hook
is wired but optional). Nothing else is staged.

## Where to start

1. Read memory `project_mcm_agent_integration_ci` (quarantine buckets + per-test plan) and this feature's
   [plan.md](./plan.md) + [research.md](./research.md).
2. Follow [tasks.md](./tasks.md) in order: **Setup (T001–T003) → Foundational (T004–T006) → US1 (T007–T018, the
   MVP) → US2 (T019–T023) ‖ US3 (T024–T029) → US4 (T030–T032) → Polish (T033–T037)**.
3. US1 is independently shippable and highest-signal — **ship it first**, then B/C.

## Load-bearing facts (already verified against the repo — don't re-derive)

- **The `app-e2e` job already stands up everything all three suites need** (`.forgejo/workflows/app-ci.yml`):
  replica-set `mc-service-store-mongo` + `rs-init`, Keycloak + realm, Redis, dev BFF `:8082`, the agent stack.
  The two new steps go **after** bring-up, **before** the web/APK/emulator legs (fast-fail), mirroring the PR #77
  agent step.
- **Published ports** (host loopback): Mongo `27017`, BFF Mongo `27018`, Redis `6379`, mc-service `3001`, dev BFF
  `8082`, Keycloak `8099`.
- **mc-service integration** (`cargo test --tests --test-threads=1`): the replica set's `rs-init` initiates its
  member as **`localhost:27017`**, so a host-run test connects with
  `MC_DB_URL=mongodb://localhost:27017/mc_db?replicaSet=rs0&directConnection=true` — `directConnection=true` is
  load-bearing (CLAUDE.md replica-set gotcha). `health_test.rs` needs `KEYCLOAK_URL=http://localhost:8099`,
  realm `grumpyrobot`, client `movie-collection-manager` (JWKS on app build). Rust toolchain install pattern is
  already in the `mc-service-checks` job (rustup minimal + `build-essential pkg-config libssl-dev`).
- **mcm-app integration** (`jest`, `maxWorkers:1`, `forceExit:true`): drives the live BFF over HTTP;
  `tests/integration/setup/env.ts` loads `.env.e2e.local` then `.env.local`, pins Redis to **db 1**, and uses BFF
  Mongo `27018`. Confirm the vars it needs exist on the host runner (align filenames with `gen-ci-env.mjs` or
  export the handful into the step env) — this is T024.
- **Skip-escalation**: the agent `conftest.py` `pytest_runtest_makereport` hook + `_LEGITIMATE_SKIPS` is the
  reference. Reuse the same flag `MCM_REQUIRE_LIVE_STACK=1` for all three; add a **jest preflight** (T004, throws
  on required-dep-down) and a **cargo executed-count guard** (T005, an all-`#[ignore]`/zero-run fails). Rust has
  no skip primitive — a missing DB already panics via `.expect()`.

## Gotchas / rules

- **No mocking in any `tests/integration/`** (constitution §Test Type Integrity). Relocate brittle model-decision
  assertions to the **golden-cassette** harness (`agents/movie-assistant/tests/golden/`), never to a mock.
- **Add-persist (T012/T013) is potential-bug-first** — an approval-resume dropped-write and a flake look
  identical; diagnose before touching the test; attach Verify-RED/GREEN if it's a product fix.
- **US2 (T019) and US3 (T025) both edit `.forgejo/workflows/app-ci.yml`** — coordinate the two step insertions to
  avoid a self-conflict.
- **Broken-on-purpose proofs (SC-003, 3-for-3)**: T018 (agent), T021 (mc-service), T027 (mcm-app) — each must turn
  its step red, then revert.
- **CI is on the Forgejo forge**, not GitHub Actions. PRs target `main` on `origin` (the forge). CI diagnosis (the
  status endpoint, `~/mcm-ci-last-failure/`, tokens) is in private memory `reference_mcm_ci_monitor_access` +
  `project_mcm_ci_failures_20260709`.
- **RTK must be active** (`rtk gain` > 80%) before any test run — constitution prerequisite.
- Locally, **Metro OOMs after ~1–2 agent `/run` calls**; the agent suite is designed to run in the containerized
  `app-e2e` stack. Diagnose any "flakiness" as a real regression FIRST (dev-container baseline ×3).

## Definition of done

- AC1: `grep -r ci_quarantine agents/movie-assistant/tests` → nothing; agent step reads `-m "not golden"`.
- AC2/AC3: mc-service + mcm-app integration run in `app-e2e` and pass; each deliberate regression turns its step
  red (SC-003).
- AC4: each newly-wired suite fails on its own partial-down (SC-004); optional-profile-down stays skipped.
- AC5: `app-e2e` wall-clock increase bounded + justified vs the T003 baseline; fast-fail order preserved; the
  secret / naming / prod-CI-port-collision gates stay green.
- Web E2E regression (`pnpm nx e2e mcm-app`) green — required for every feature, including this CI/backend one.
- Docs updated (T033); memory `project_mcm_agent_integration_ci` updated with outcomes (T037).
