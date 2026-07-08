---
description: "Task list for DAST Security Scanning (OWASP ZAP)"
---

# Tasks: DAST Security Scanning (OWASP ZAP)

**Input**: Design documents from `specs/031-dast-zap-scanning/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/)

**Tests**: Included. The constitution mandates TDD; test tasks carry a **Verify RED** (expected failure before impl) and paired impl tasks carry a **Verify GREEN**. The scan itself is validated via the quickstart scenarios; the automatable code (gate + auth + guard) is unit-tested.

**Organization**: By user story (US1 local baseline → US2 CI gate → US3 allowlist). No application (TS/Rust/Python) source changes — this is security tooling + CI config.

**Platform Parity**: N/A — DevOps/security tooling, not a web/mobile client feature (no parity table).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no incomplete deps)
- **[Story]**: US1 / US2 / US3 (setup/foundational/polish carry no story label)

## Path Conventions

New config tree `security/zap/`; executable glue in `scripts/*.mjs`; CI in `.forgejo/workflows/app-ci.yml`; runbook in `docs/runbooks/`. Absolute repo-root-relative paths shown per task.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create the config tree and keep scan output out of git.

- [X] T001 Create the `security/zap/` structure (`security/zap/`, `security/zap/scripts/`, `security/zap/contexts/`, `security/zap/reports/.gitkeep`) with a `security/zap/README.md` skeleton (what/why + "how to run" placeholder).
- [X] T002 [P] Add `.gitignore` entries: `security/zap/reports/` and `security/zap/**/*.local.*` (scan output + any local auth artifacts never committed — FR-015, SC-008).
- [X] T003 [P] Scaffold `security/zap/allowlist.yaml` as an empty list with a header comment documenting the entry schema (`pluginId`, `uriPattern`, `justification`, `addedBy`) per [data-model.md](./data-model.md).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The shared scan harness (in-scanner auth + runner + contexts) that BOTH the baseline (US1) and full (US2) scans depend on.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T004 [P] Implement the ZAP authentication script `security/zap/scripts/bearer-auth.js`: performs Keycloak ROPC (`grant_type=password`, client `mcm-bff-test`, user `${DAST_TEST_USER}`) reading params from env, injects `Authorization: Bearer <access_token>` for the `mc-service` and `agent-gateway` contexts, and re-mints on a 401 verification signal. MUST NOT log the token. Contract: [contracts/zap-scan-contract.md](./contracts/zap-scan-contract.md).
- [X] T005 [P] Implement the ZAP httpsender script `security/zap/scripts/bff-session-refresh.js`: on a `401` for a `bff`-context request, calls `POST /bff-api/auth/refresh` with the current `mcm_refresh_token`, updates `mcm_access_token`, retries once. MUST NOT log cookie values (FR-013).
- [X] T006 Implement the runner core `scripts/zap-scan.mjs` (Node ESM): CLI `--target <local|ci>` `--mode <baseline|full>`; resolve target base URLs to Compose DNS (`mcm-bff-service-nonsecure:3000`, `mc-service:3001`, `movie-assistant-gateway:8000`); launch `ghcr.io/zaproxy/zaproxy:stable` attached to the Compose network (`docker run --network …`); mount `security/zap/` + reports; collect reports to `security/zap/reports/`. Depends on T004, T005. (Baseline/full plan wiring added in US1/US2.)
  - **BFF cookie acquisition (C2 — no browser in the job)**: a headless HTTP helper `scripts/dast-bff-login.mjs` performs the OAuth Authorization-Code + PKCE flow directly against Keycloak (GET authorize → POST the login-form action with `${DAST_TEST_USER}`/`${DAST_TEST_PASSWORD}` → capture the redirect `code` → POST to the BFF `/bff-api/auth/login`), yielding the three `mcm_*` cookies written to `security/zap/reports/.auth.local.json` (gitignored). This avoids installing Playwright/browsers in the `node:22` dast job. Does NOT reuse the Playwright `global-setup` (that needs a browser).
  - **Env var mapping (C3)**: scripts read `DAST_TEST_USER`, `DAST_TEST_PASSWORD`, `DAST_ROPC_CLIENT_ID`, `DAST_ROPC_CLIENT_SECRET`; `zap-scan.mjs` populates each from its `E2E_*` equivalent (`E2E_TEST_USER`/`E2E_TEST_PASSWORD`/`E2E_ROPC_CLIENT_ID`/`E2E_ROPC_CLIENT_SECRET`) when the `DAST_*` var is unset, so the existing E2E secrets are reused with no new secret material.
  - **Unreachable target (C6)**: if a target does not resolve/respond (e.g. the `agents` profile is down), log a visible WARNING and skip that target — never silently report a clean pass. (Distinct from an auth *failure* against a reachable target, which fails fast per FR-012.)
- [X] T007 [P] Test: safety guard in `scripts/zap-scan.mjs` — add a unit test `scripts/__tests__/zap-scan.guard.test.mjs` asserting `--mode full` **exits non-zero** unless `DAST_ALLOW_ACTIVE=1` AND the target is a known disposable Compose/localhost host (FR-017, research D8).
  - **Acceptance scenarios covered**: spec Edge Case "Destructive scan hitting shared data" (FR-017).
  - **Verify RED**: `node --test scripts/__tests__/zap-scan.guard.test.mjs`
    - **Expected failure output**: test `rejects --mode full without DAST_ALLOW_ACTIVE` fails — the run is permitted (exit 0) because the guard does not yet exist; node reports `1 failing`.
- [X] T008 Implement the D8 safety guard in `scripts/zap-scan.mjs` (refuse active mode off a disposable target; default invocation is baseline).
  - **Verify GREEN**: `node --test scripts/__tests__/zap-scan.guard.test.mjs` → passes.
- [X] T009 [P] Define the shared ZAP contexts + script registration reused by both plans: `security/zap/contexts/` (or an inlined `environment` + `script` block documented for include) covering `bff` (session-cookie), `mc-service` (bearer), `agent-gateway` (bearer); Keycloak URLs allowed for auth but excluded as scan targets.

**Checkpoint**: Auth + runner + contexts ready — scan plans can now be authored and run.

---

## Phase 3: User Story 1 - Repeatable local authenticated baseline (Priority: P1) 🎯 MVP

**Goal**: One documented command runs a non-destructive, authenticated baseline scan of all three targets and emits HTML/JSON/SARIF.

**Independent Test**: Run the baseline against the local stack; confirm the report lists protected post-auth URLs (not just the public surface) and that collection/movie state is unchanged.

- [X] T010 [US1] Author `security/zap/zap-baseline.yaml` (Automation Framework): jobs `addOns` → `environment` (3 contexts from T009) → `script` (register T004/T005) → `spider` (+ `spiderAjax` for the BFF UI) → `passiveScan-wait` → `report`×3 (`traditional-html`, `traditional-json`, `sarif-json` → `security/zap/reports/`). **No `activeScan` job** (FR-005).
- [X] T011 [US1] Wire baseline mode in `scripts/zap-scan.mjs` to invoke `zap-baseline.yaml` (`zap.sh -cmd -autorun`). Depends on T006, T010.
- [X] T012 [P] [US1] Add an Nx `dast` target in `infrastructure-as-code/project.json` (run-commands wrapping `node scripts/zap-scan.mjs`), enabling `pnpm nx dast infrastructure-as-code`.
- [X] T013 [US1] Test: authenticated-coverage + non-destructive assertion — add `scripts/__tests__/baseline-coverage.test.mjs` (or a quickstart-driven check) that runs the baseline and asserts `report.json` `crawledUrls` include protected endpoints (e.g. `/bff-api/collections`, mc-service `/api/v1/...`) and that a fail-fast error is raised when auth cannot be established (FR-012, SC-002).
  - **Acceptance scenarios covered**: US1 scenarios 2 (authenticated crawl inventory) and 4 (no authenticated session → fail fast).
  - **Verify RED**: run before T010/T011 are wired (or with the auth env unset): `node --test scripts/__tests__/baseline-coverage.test.mjs`
    - **Expected failure output**: assertion `crawledUrls includes protected endpoints` fails — the inventory contains only `/login`, `/register`, `/init`; node reports `1 failing` (public-only crawl).
- [ ] T014 [US1] Make Scenario 1 pass: bring up the local `auth` + `mcm` stack **including `--profile agents`** (so all three targets, incl. the gateway, are reachable — C6), then run `pnpm nx dast infrastructure-as-code` (baseline); confirm reports emitted and authenticated crawl present. If the `agents` profile is not up, the gateway target must log a WARNING and be skipped (T006), not silently pass.
  - **Verify GREEN**: [quickstart.md](./quickstart.md) Scenario 1 — reports at `security/zap/reports/report.{html,json,sarif}`, protected URLs in `crawledUrls`, collection/movie counts unchanged (SC-003).

**Checkpoint**: MVP — a developer can run an authenticated baseline scan locally and get a risk-ranked report.

---

## Phase 4: User Story 2 - CI pipeline gates merges on new High-risk findings (Priority: P2)

**Goal**: CI runs the active scan (BFF+mc-service) + passive gateway against the throwaway stack and fails the build on any un-allowlisted High.

**Independent Test**: A crafted High finding fails the gate and appears in the artifact; a benign run passes and publishes artifacts; docs-only PRs skip the job.

- [X] T015 [P] [US2] Test: gate fails on un-allowlisted High — `scripts/__tests__/check-dast-findings.test.mjs` feeds a synthetic ZAP `traditional-json` with a High finding and an empty allowlist; expects **exit 1** and the finding in the summary (SC-004).
  - **Acceptance scenarios covered**: US2 scenario 2 (new High → job fails).
  - **Verify RED**: `node --test scripts/__tests__/check-dast-findings.test.mjs`
    - **Expected failure output**: the test errors because `scripts/check-dast-findings.mjs` does not exist (module-not-found), so no exit-1 assertion can pass; node reports `1 failing`.
- [X] T016 [US2] Implement `scripts/check-dast-findings.mjs`: parse `--report <json>`, apply `--allowlist` (default `security/zap/allowlist.yaml`; matching added in US3), fail (exit 1) on remaining High, warn on Medium/Low, print grouped summary; expose `--selftest` (embedded synthetic RED+GREEN). No secrets in output. Contract: [contracts/zap-scan-contract.md](./contracts/zap-scan-contract.md).
  - **Verify GREEN**: `node --test scripts/__tests__/check-dast-findings.test.mjs` and `node scripts/check-dast-findings.mjs --selftest` → both pass (exit 0).
- [X] T017 [US2] Author `security/zap/zap-full.yaml`: like baseline plus an `activeScan` job scoped to the `bff` and `mc-service` contexts only; `agent-gateway` stays spider+passive (clarification Q2, FR-006).
- [X] T018 [US2] Wire full mode in `scripts/zap-scan.mjs` to invoke `zap-full.yaml` (gated by the T008 safety guard). Depends on T006, T017.
- [X] T019 [US2] Add the `dast` job to `.forgejo/workflows/app-ci.yml` per [contracts/ci-integration-contract.md](./contracts/ci-integration-contract.md): `runs-on: kvm`, `needs: [changes]`, `if: needs.changes.outputs.app == 'true'`; steps = docker verify → `gen-dev-secrets` + `gen-ci-env` → bring up `auth` then `mcm` (`--profile app --profile bff-nonsecure`) → **bring up the agent stack `pnpm nx up-agents-prod infrastructure-as-code`** so the gateway target exists (C1, FR-003/FR-006) → `DAST_ALLOW_ACTIVE=1 node scripts/zap-scan.mjs --target ci --mode full` → **scan `security/zap/reports/*` for secret leakage** (fail if the test password/token appears — C4, SC-008) → **always** `upload-artifact@v3` (`dast-report`, `security/zap/reports/**`, `if-no-files-found: ignore`) → gate `node scripts/check-dast-findings.mjs --report security/zap/reports/report.json` → `if: always()` teardown: `down -v --remove-orphans` for both stacks **and `pnpm nx down-agents-prod infrastructure-as-code`**.
- [X] T020 [P] [US2] Extend the `changes` paths-filter `app` list in `.forgejo/workflows/app-ci.yml` with `security/zap/**`, `scripts/zap-scan.mjs`, `scripts/check-dast-findings.mjs`; add `dast` to `trigger-cd`'s `needs` with the skipped-tolerant / failed-blocking rule used for `app-e2e` (SC-007).
- [X] T021 [P] [US2] Add a guardrails self-test step in `.forgejo/workflows/guardrails.yml` (naming/gates job): `node scripts/check-dast-findings.mjs --selftest` (repo `--selftest`-then-scan convention), so the gate logic is verified on every push.

**Checkpoint**: CI enforces the security gate; artifacts published; path-gated.

---

## Phase 5: User Story 3 - Triaged findings suppressed without weakening the gate (Priority: P3)

**Goal**: An allowlist entry suppresses a specific High from the gate while it stays visible in reports; unrelated new Highs still fail.

**Independent Test**: Allowlist a High → gate passes for it; the finding remains in the report; a different un-allowlisted High still fails.

- [X] T022 [P] [US3] Test: allowlist suppresses gate but not report — extend `scripts/__tests__/check-dast-findings.test.mjs` with cases: (a) High + matching allowlist entry → **exit 0**; (b) a *different* un-allowlisted High still → **exit 1**; (c) an allowlist entry with blank `justification` → **error** (SC-006, FR-010).
  - **Acceptance scenarios covered**: US3 scenarios 1 (allowlisted → passes), 2 (finding still visible in report), 3 (unrelated new High still fails).
  - **Verify RED**: `node --test scripts/__tests__/check-dast-findings.test.mjs`
    - **Expected failure output**: case (a) fails — with allowlist matching not yet implemented the allowlisted High is still counted, so the gate returns exit 1 instead of 0; node reports `1 failing` (cases b/c may pass).
- [X] T023 [US3] Implement allowlist matching in `scripts/check-dast-findings.mjs`: match by `pluginId` + `uri` against `uriPattern`; require non-empty `justification` + `addedBy` (else error); suppress matched findings from the **gate only** — they remain in the parsed/reported set (visible in HTML/JSON). Depends on T016.
  - **Verify GREEN**: `node --test scripts/__tests__/check-dast-findings.test.mjs` → all cases pass.
- [X] T024 [P] [US3] Document the triage workflow in `security/zap/README.md` and add one worked example entry (commented) to `security/zap/allowlist.yaml` showing the required fields.

**Checkpoint**: All three stories independently functional.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [ ] T025 [P] Write `docs/runbooks/dast-scanning.md`: local run (PowerShell + Bash), CI behavior, triage/allowlist process, the disposable-target guard, and the "no new ports / network-attach" rationale.
- [ ] T026 [P] Finalize `security/zap/README.md` (how to run both modes, where reports go, how to add an allowlist entry).
- [ ] T027 Add a brief DAST note to `CLAUDE.md` (Testing / CI section) pointing to the runbook and the `pnpm nx dast` target.
- [ ] T028 Run the full [quickstart.md](./quickstart.md) validation (Scenarios 1–5) and confirm the done-checklist.
- [ ] T029 Regression: `pnpm nx e2e mcm-app` still green (no app regression from infra/CI changes) and `node scripts/check-prod-ci-port-collision.mjs` green (no new published ports). Then `rtk gain` > 80%.

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (P1)** → no deps.
- **Foundational (P2)** → after Setup; **blocks all stories** (auth scripts + runner + guard + contexts).
- **US1 (P3 phase)** → after Foundational. MVP.
- **US2 (P4)** → after Foundational. Independent of US1 at runtime, but naturally follows (reuses runner/auth). The gate script (T016) is a US2 deliverable.
- **US3 (P5)** → after US2 (extends the same `check-dast-findings.mjs`).
- **Polish (P6)** → after desired stories complete.

### Story independence

- **US1** testable alone: local baseline scan produces an authenticated, non-destructive report.
- **US2** testable alone: gate script fails on a synthetic High (no US1 needed); CI job runs the full scan.
- **US3** testable alone: allowlist suppresses a synthetic High while keeping it visible — exercised purely through `check-dast-findings.mjs` unit tests.

### Within each story

- Tests (RED) before implementation (GREEN). Auth/runner before plans. Plans before CI wiring.

---

## Parallel Opportunities

- **Setup**: T002, T003 in parallel.
- **Foundational**: T004, T005, T009 in parallel (distinct files); T007 in parallel with them; T006 needs T004/T005; T008 needs T007.
- **US1**: T012 [P] alongside T010/T011.
- **US2**: T015 [P] first; T020, T021 [P] alongside T019 (distinct concerns/files, though all three touch workflow YAML — sequence T019 → then T020/T021 if editing the same file).
- **US3**: T022 [P], T024 [P].
- **Polish**: T025, T026 in parallel.

### Parallel example — Foundational

```bash
# Distinct files, no interdeps:
Task: "Implement security/zap/scripts/bearer-auth.js"          # T004
Task: "Implement security/zap/scripts/bff-session-refresh.js"  # T005
Task: "Define security/zap/contexts/ shared contexts"          # T009
Task: "Write scripts/__tests__/zap-scan.guard.test.mjs"        # T007
```

---

## Implementation Strategy

### MVP first (US1 only)

1. Setup (T001–T003) → 2. Foundational (T004–T009) → 3. US1 (T010–T014). **STOP & VALIDATE** quickstart Scenario 1. This alone delivers a repeatable authenticated local scan.

### Incremental delivery

1. Foundation ready → 2. US1 (MVP: local baseline) → 3. US2 (CI gate + full scan) → 4. US3 (allowlist). Each increment is independently testable and adds value without breaking the prior.

---

## Notes

- No application source changes — all work is `security/zap/` config, `scripts/*.mjs`, and CI/doc files.
- Secrets (`DAST_TEST_USER`, `DAST_TEST_PASSWORD`, ROPC client secret) come from env / Forgejo Actions store / `.env.e2e.local` — never committed, never logged (FR-015, SC-008).
- Reuse the existing `e2e-test-user` (mc-user) + `mcm-bff-test` ROPC client + `E2E_ROPC_CLIENT_SECRET` — no new users/clients/secrets (research D7).
- ZAP attaches to the Compose network → no new published ports → `check-prod-ci-port-collision.mjs` stays green (FR-016).
- Commit after each task or logical group; keep the forge host literal / domain out of any committed file.
