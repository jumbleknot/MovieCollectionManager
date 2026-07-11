---
description: "Task list for feature 033 — SAST & SCA static security scanning"
---

# Tasks: SAST & SCA Static Security Scanning

**Input**: Design documents from `specs/033-sast-semgrep/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: REQUIRED — the constitution mandates TDD. Every code artifact is written test-first (RED) then implemented (GREEN). Custom Semgrep rules ship with `semgrep --test` fixtures (FR-019).

**Organization**: Grouped by user story. US1 (local unified scan) is the MVP; US2 adds the blocking CI gate; US3 adds the suppression/expiry workflow. Later stories consume earlier artifacts but each is independently testable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1 / US2 / US3 (setup/foundational/polish carry no story label)

## Path Conventions

Repo-root layout per [plan.md](plan.md): config-as-code under `security/sast/`, scripts under `scripts/`, Nx target in `infrastructure-as-code/project.json`, CI job in `.forgejo/workflows/guardrails.yml`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create the `security/sast/` config tree, mirroring `security/zap/`.

- [X] T001 Create `security/sast/` directory tree with `security/sast/reports/.gitkeep`, and add `security/sast/reports/` (except `.gitkeep`) to `.gitignore` mirroring the `security/zap/reports/` ignore rule.
- [X] T002 [P] Create `security/sast/README.md` skeleton (scanners, code/dependency surfaces, report formats, triage workflow) mirroring the structure of `security/zap/README.md`.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Config-as-code data consumed by the orchestrator. MUST exist before any scanner runs.

**⚠️ CRITICAL**: Blocks all user stories.

- [X] T003 Create `security/sast/severity-map.yaml` — the native→normalized severity mapping per [research.md](research.md) R4 (Semgrep ERROR/WARNING/INFO, CVSS bands, pnpm levels, unscored-advisory→High, informational→Low).
- [X] T004 Create `security/sast/semgrep.yaml` — Semgrep run config listing community packs (`p/typescript`, `p/react`, `p/nodejs`, `p/python`, `p/owasp-top-ten`) and a config include of `security/sast/rules/`; explicitly NOT `p/secrets` (FR-006). Add a `.semgrepignore` excluding build artifacts (`node_modules`, `dist`, `.expo`, `android`, `ios`, `_expo`, coverage, generated Rust `target`).

**Checkpoint**: Config foundation ready — orchestrator work can begin.

---

## Phase 3: User Story 1 - Repeatable local SAST & SCA scan with a unified report (Priority: P1) 🎯 MVP

**Goal**: A single command statically scans the repo (code + all dependency graphs) and produces one consolidated, risk-normalized `findings.json` + human summary + SARIF — no running app stack.

**Independent Test**: Run `node scripts/sast-scan.mjs --scope full` in a checkout; confirm one report listing SAST findings (TS/JS + Python) and SCA findings (cargo/pnpm/pip) each with a normalized severity, and every expected scanner marked `ran: true`.

### Tests for User Story 1 (write FIRST — must FAIL)

- [X] T005 [P] [US1] Write failing `scripts/__tests__/sast-scan.guard.test.mjs` (`node:test`): asserts normalization applies `severity-map.yaml`, `blocking` is derived per data-model (High/Critical AND (sast OR runtime)), SCA `scope` classification (runtime vs dev), fail-fast + non-zero exit on a missing toolchain, and fail-fast on an unmapped native severity. Validate output against `contracts/findings.schema.json`.
- [X] T006 [P] [US1] Write `semgrep --test` fixtures for every custom rule under `security/sast/rules/` (annotated `ruleid:`/`ok:` insecure+safe pairs) — failing because the rules do not exist yet (FR-019 / SC-007).

### Implementation for User Story 1

- [X] T007 [P] [US1] Implement custom rule `security/sast/rules/mcm-no-console-in-bff.yaml` (WARNING/Medium) — direct `console.*` in `src/bff-server/**` or `bff-api/**`. Include `metadata.mcmRequirement` traceability comment (FR-004).
- [X] T008 [P] [US1] Implement custom rule `security/sast/rules/mcm-no-token-logging.yaml` (ERROR/High) — logging a raw token/JWT/`authorization`/session id/email in server code.
- [X] T009 [P] [US1] Implement custom rule `security/sast/rules/mcm-auth-before-authz.yaml` (ERROR/High) — a BFF route handler reaching `createMcServiceClient`/upstream call without a preceding `requireAuth`/`requireMcUser` (best-effort structural rule; document limits in a rule comment).
- [X] T010 [P] [US1] Implement custom rule `security/sast/rules/mcm-no-jwt-payload-tracing.yaml` (ERROR/High) — tracing/logging a decoded JWT payload/token on the TS + Python surfaces (Rust `tracing` best-effort/out-of-scope per research R6).
- [X] T011 [US1] Implement `scripts/sast-scan.mjs` Semgrep runner: `uvx semgrep@<pin> scan --config security/sast/semgrep.yaml` emitting `--json` + `--sarif`; `--scope full` targets the whole tree. Arg parser (`--scope`, `--base`, `--only`, `--out`) mirroring `scripts/zap-scan.mjs`.
- [X] T012 [US1] Add the cargo-audit runner to `scripts/sast-scan.mjs`: `cargo audit --file Cargo.lock --json`; compute the runtime dep set via `cargo tree --edges no-dev --prefix none` for scope classification (research R3).
- [X] T013 [US1] Add the pnpm-audit runner: `pnpm audit --json` (full) + `pnpm audit --prod --json` (runtime set) for scope classification.
- [X] T014 [US1] Add the pip-audit runner: `uv export --frozen --no-emit-project [--no-dev] --format requirements-txt` (runtime vs full) + `uvx pip-audit --format json -r <file>` (cwd `agents/movie-assistant`), classify scope from the runtime export.
- [X] T015 [US1] Implement the normalization layer in `scripts/sast-scan.mjs`: apply `severity-map.yaml`, derive `scope` + `blocking`, emit `findings.json` (conforms to `contracts/findings.schema.json`), `findings.sarif`, `summary.txt`, and per-scanner `*-native.json`. Fail-fast (exit 1) on missing toolchain / unreachable data / unmapped severity (FR-015); record `scanners[].error`.
- [X] T016 [US1] Add secret scrubbing to all report writes + stdout (reuse the `scrubSecretsInText` approach from `scripts/zap-scan.mjs`) — JWT/Bearer/known-key/`mcm_*`-cookie shapes (FR-018 / research R8).
- [X] T017 [US1] Register the `sast` target in `infrastructure-as-code/project.json` (`nx:run-commands`, `node scripts/sast-scan.mjs --scope full`, `cwd {workspaceRoot}`, metadata description) mirroring the `dast` target.
- [X] T018 [US1] Make T005 GREEN and confirm `uvx semgrep --test security/sast/rules/` (T006) passes.

**Checkpoint**: `pnpm nx sast infrastructure-as-code` produces a consolidated normalized report locally (SC-001). MVP delivered.

---

## Phase 4: User Story 2 - CI pipeline gates merges on new High/Critical findings (Priority: P2)

**Goal**: A blocking `sast` check runs the real scan on every push/PR and fails on un-allowlisted High/Critical; SCA runs full, Semgrep is affected-scoped on PRs.

**Independent Test**: Open a PR introducing a High insecure pattern (or a runtime dep with a High advisory) → the `sast` check fails with the finding in the artifact; a benign PR passes.

### Tests for User Story 2 (write FIRST — must FAIL)

- [X] T019 [P] [US2] Write failing `scripts/__tests__/check-sast-findings.test.mjs` (`node:test`, subprocess-invokes the gate like `check-dast-findings.test.mjs`): un-allowlisted blocking High → exit 1; allowlisted High → exit 0; High with `scope: dev` (non-blocking) → exit 0 (warned); clean report → exit 0; blank `justification` → exit 2; `--selftest` → exit 0; unparseable report → exit 2. Covers `contracts/check-sast-findings.cli.md` scenarios a–e.

### Implementation for User Story 2

- [X] T020 [US2] Implement `scripts/check-sast-findings.mjs`: load `--report` findings.json + `--allowlist` (validate required fields `scanner`/`id`/`locationPattern`/`justification`/`addedBy`, compile `locationPattern` regex), compute fail set (`blocking && !suppressed`, suppression = scanner+id equal AND pattern matches `location`), print Medium/Low + dev-scope as warnings, `--selftest`, exit codes 0/1/2 per contract. → makes T019 GREEN.
- [X] T021 [US2] Add `--scope changed` affected-scoping to `scripts/sast-scan.mjs`: `git diff --name-only --diff-filter=ACMR <base>...HEAD` filtered to TS/JS/Py, passed to Semgrep as targets; SCA still runs full (research R2 / FR-014).
- [X] T022 [US2] Add `--emit-allowlist` to `scripts/sast-scan.mjs`: write `reports/allowlist.proposed.yaml` covering all current findings (baseline-seeding aid; does not modify the committed allowlist) (FR-012).
- [X] T023 [US2] Seed and commit `security/sast/allowlist.yaml`: run the full scan with `--emit-allowlist`, triage each current finding with a real `justification`/`addedBy`, commit so `main` passes the gate immediately (FR-012 / SC-006).
- [X] T024 [US2] Add the blocking `sast` job to `.forgejo/workflows/guardrails.yml`: `ubuntu-latest`; steps — checkout (full history for the PR base ref), `corepack enable` + `pnpm install --frozen-lockfile`, uv installer (as in `agent-gates`), ensure Rust + `cargo install cargo-audit --locked` with cache of `~/.cargo/bin/cargo-audit` + `~/.cargo/advisory-db` (monthly rotation key) + Semgrep/uv cache; run `node scripts/check-sast-findings.mjs --selftest`; run `node scripts/sast-scan.mjs --scope changed --base ${base}` on `pull_request` / `--scope full` on `push`; run `node scripts/check-sast-findings.mjs`; upload `security/sast/reports/` as a build artifact (research R5). No `paths:` filter on the job (SCA must run regardless — FR-013).

**Checkpoint**: CI blocks a High/Critical-introducing PR and passes a clean one (SC-002/003/004). Branch-protection covers it via the existing `guardrails*` required glob.

---

## Phase 5: User Story 3 - Triaged findings can be suppressed without weakening the gate (Priority: P3)

**Goal**: An allowlist entry (with optional expiry) suppresses a specific finding from the gate while keeping it visible; new/expired findings still block.

**Independent Test**: Allowlist a High finding → gate passes for it; introduce a different High → still fails; set a past `expiry` on an entry → its finding blocks again.

### Tests for User Story 3 (write FIRST — must FAIL)

- [X] T025 [P] [US3] Extend `scripts/__tests__/check-sast-findings.test.mjs`: allowlisted finding remains present in the report output (visibility, FR-010); an entry with a **past** `expiry` does NOT suppress (exit 1); a future/absent expiry suppresses (exit 0) — scenario (f) in `contracts/check-sast-findings.cli.md`. Failing until T026.

### Implementation for User Story 3

- [X] T026 [US3] Add `expiry` handling to `scripts/check-sast-findings.mjs`: an allowlist entry only suppresses when `expiry` is absent OR `>= today`; keep suppressed findings visible in the printed/serialized report (FR-010/FR-011). → makes T025 GREEN.
- [X] T027 [US3] Document the triage → allowlist workflow (all required fields, regex `locationPattern`, optional `expiry` semantics, "stays visible in reports") in `security/sast/README.md`.

**Checkpoint**: Suppression + expiry demonstrated (SC-005); dev-scope-warn demonstrated (SC-011).

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T028 [P] Write `docs/runbooks/sast-scanning.md` operator runbook (local run, CI job, toolchain/cache notes, keyless fail-closed residual per research R7, triage) mirroring `docs/runbooks/dast-scanning.md`.
- [X] T029 [P] Add the `sast` gate to the CI/CD gate inventory: reference it in `CLAUDE.md` (the guardrails gate list / DAST-adjacent section) and note it is a required check.
- [ ] T030 Run the [quickstart.md](quickstart.md) demonstration scenarios end-to-end (SC-002/003/004/005/008/010/011) and confirm each expected outcome — including SC-010: an advisory affecting an **unchanged** dependency is flagged on a PR that touched **no** dependency manifest (proves SCA is not path-gated).
- [ ] T031 Final validation: `node scripts/check-sast-findings.mjs --selftest`, `node --test scripts/__tests__/check-sast-findings.test.mjs scripts/__tests__/sast-scan.guard.test.mjs`, `uvx semgrep --test security/sast/rules/`, and confirm the `sast` job is green on the feature PR in Forgejo CI; run `rtk gain`.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies.
- **Foundational (Phase 2)**: after Setup — blocks all stories (orchestrator reads `severity-map.yaml` + `semgrep.yaml`).
- **US1 (Phase 3)**: after Foundational. The MVP.
- **US2 (Phase 4)**: consumes US1's `findings.json` + orchestrator; the gate + CI wiring.
- **US3 (Phase 5)**: extends US2's gate (suppression/expiry).
- **Polish (Phase 6)**: after the desired stories.

### Within Each User Story

- Tests (RED) before implementation (GREEN).
- Rules (T007–T010) and the two test files are independent files → parallel.
- Orchestrator scanner-runner tasks (T011–T016) all edit `scripts/sast-scan.mjs` → **sequential**.
- Gate tasks (T020, T026) edit `scripts/check-sast-findings.mjs` → sequential across stories.

### Parallel Opportunities

- Setup T002 ∥ (T001 first for the tree).
- US1: T005 ∥ T006 (tests); T007 ∥ T008 ∥ T009 ∥ T010 (rule files).
- US2/US3 gate work is single-file → little parallelism.
- Polish T028 ∥ T029.

---

## Parallel Example: User Story 1

```bash
# Tests first (parallel, must fail):
Task: "T005 failing sast-scan.guard.test.mjs"
Task: "T006 failing semgrep --test rule fixtures"

# Then the four custom rules in parallel (different files):
Task: "T007 mcm-no-console-in-bff.yaml"
Task: "T008 mcm-no-token-logging.yaml"
Task: "T009 mcm-auth-before-authz.yaml"
Task: "T010 mcm-no-jwt-payload-tracing.yaml"
```

---

## Implementation Strategy

### MVP First (US1 only)

1. Phase 1 Setup → Phase 2 Foundational → Phase 3 US1.
2. **STOP & VALIDATE**: `pnpm nx sast infrastructure-as-code` yields a consolidated report locally (SC-001). Demo-able as a local developer tool even before CI enforcement.

### Incremental Delivery

1. US1 → local scan + report (MVP).
2. US2 → blocking CI gate + seeded baseline (enforcement).
3. US3 → suppression/expiry triage workflow.
4. Polish → runbook + final validation.

---

## Notes

- [P] = different files, no incomplete-task dependency.
- The gate depends only on `findings.json` + `allowlist.yaml` — keep it as small/testable as `check-dast-findings.mjs`.
- No application code, no deployed container, no host ports, no new secrets — this is CI/security tooling only (see plan Constitution Check scope note re: app-behavior E2E N/A).
- Commit after each task or logical group; open the PR to the **Forgejo** `origin` (not the GitHub mirror) so `guardrails` runs.
