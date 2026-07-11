---
description: "Task list for SAST/SCA baseline hardening (feature 034)"
---

# Tasks: SAST/SCA Baseline Hardening

**Input**: Design documents from `specs/034-hardening/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [quickstart.md](./quickstart.md)

**Tests**: This is a dependency/config remediation feature with **no new application behavior**. Per plan.md Complexity Tracking, the TDD checkpoint is adapted: the "test" for each finding is **RED** = the finding present + its `security/sast/allowlist.yaml` entry required, **GREEN** = a fresh Linux/CI-equivalent scan shows the finding absent + the entry deleted with `scripts/check-sast-findings.mjs` still green. Existing suites guard against functional regression from bumps/container changes.

**Organization**: Grouped by the four priority user stories (P1–P4). Each story is an independently shippable slice that burns down its own allowlist entries.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1=runtime dep CVEs, US2=non-root containers, US3=CI/CD supply-chain, US4=dev-dep bumps
- Exact file paths included in each task.

## Scan authority (applies to every "re-scan" task)

The **CI `sast` job in `.forgejo/workflows/guardrails.yml` is the authoritative scan** (Linux file discovery). Local `pnpm nx sast infrastructure-as-code` on Windows is indicative only — an allowlist entry is deleted only after the finding is confirmed absent on the CI/Linux scan (feature-033 platform-discovery lesson). `NO_COLOR=1` when uv runs under Node.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Establish the baseline measurement so the burn-down is provable.

- [ ] T001 Capture the pre-remediation baseline: run `pnpm nx sast infrastructure-as-code` and record the blocking-finding count + the current `security/sast/allowlist.yaml` blocking-entry count (the 55-blocking / feature-033 baseline) into a scratch note for the branch. This is the number SC-006 measures "materially smaller" against.
- [ ] T002 Ensure the agent venv is synced for pip-audit: `cd agents/movie-assistant && uv sync` (pip-audit audits the INSTALLED venv, not the manifest — quickstart.md prereq).
- [ ] T003 [P] Confirm `pnpm install` and the Rust toolchain (`cargo audit --version`) are ready so all four scanners run locally for fast iteration.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: One shared understanding that gates every burn-down deletion.

**⚠️ CRITICAL**: The delete-on-fix rule (data-model.md) governs all stories: never delete an allowlist entry until a fresh authoritative scan confirms the finding is absent; if blocked upstream, REWRITE the justification to "blocked by upstream constraint: <detail>" instead (FR-012). The FR-010 keep-list is untouchable.

- [ ] T004 Record the FR-010 untouchable entries so no story deletes them by accident: `gcm-no-tag-length` (agent-config-crypto), `mcm-no-token-logging` + `mcm-auth-before-authz` (unit-test), `gha-curl-pipe-shell` (accepted CI bootstrap) in `security/sast/allowlist.yaml`, plus the documented-but-non-allowlisted false-positives (`bypass-tls-verification`, `logger-credential-disclosure`, `mcm-no-console-in-bff`). These are NEVER remediation targets.

**Checkpoint**: Baseline captured, keep-list fixed — story burn-down can begin.

---

## Phase 3: User Story 1 - Runtime dependency CVEs remediated (Priority: P1) 🎯 MVP

**Goal**: Clear all 19 runtime advisories across 13 packages (Python/JS/Rust) and delete their allowlist entries.

**Independent Test (RED→GREEN)**: Before — each advisory present in `findings.json`, its `pip-audit`/`pnpm-audit`/`cargo-audit` entry required. After — the bump lands, a fresh authoritative scan shows the advisory absent, the entry is deleted, and `node scripts/check-sast-findings.mjs` stays green. Affected services build + existing tests pass.

### Python (agent layer — `agents/movie-assistant/uv.lock`)

- [ ] T005 [US1] Bump the seven Python targets via lockfile-targeted upgrade in `agents/movie-assistant/`: `uv lock --upgrade-package aiohttp --upgrade-package cryptography --upgrade-package langchain --upgrade-package langchain-anthropic --upgrade-package langsmith --upgrade-package pydantic-settings --upgrade-package starlette` then `uv sync`. Confirm `uv.lock` shows aiohttp≥3.14.1, cryptography≥48.0.1, langchain≥1.3.9, langchain-anthropic≥1.4.6, langsmith≥0.8.18, pydantic-settings≥2.14.2, starlette≥1.3.1. If a direct parent constraint blocks a fix, raise the floor in `agents/movie-assistant/pyproject.toml` and re-lock (research.md R1).
- [ ] T006 [US1] Verify agent-layer regression: run the agent `pytest` suite (unit + `leak_scan`) via its Nx target; LangChain 1.3.x and starlette 1.2→1.3 are the framework-level risk (watch for API drift). If a bump breaks a test and the break is real, revert that package and REWRITE its allowlist justification (FR-012) instead of deleting.
- [ ] T007 [US1] Re-run pip-audit (`cd agents/movie-assistant && uv run --with pip-audit pip-audit`, `NO_COLOR=1`) and the full `pnpm nx sast infrastructure-as-code`; confirm each of the eight aiohttp advisories, plus the langchain/langchain-anthropic, pydantic-settings, langsmith, cryptography, and both starlette advisories, is ABSENT.
- [ ] T008 [US1] Delete the cleared `pip-audit` entries from `security/sast/allowlist.yaml`: `CVE-2026-54273/54274/54276/54277/54278/54279/54280`, `PYSEC-2026-237` (aiohttp), `CVE-2026-55443` (langchain|langchain-anthropic), `CVE-2026-58203` (pydantic-settings), `CVE-2026-59152` (langsmith), `GHSA-537c-gmf6-5ccf` (cryptography), `PYSEC-2026-248`, `PYSEC-2026-249` (starlette). Re-run `node scripts/check-sast-findings.mjs` → green.

### JavaScript (root `pnpm-lock.yaml`)

- [ ] T009 [P] [US1] Bump the JS runtime deps: `pnpm update form-data hono undici --recursive`; where a transitive parent caps below the fix, add a version-scoped `pnpm.overrides` block in root `package.json` (`"form-data": ">=4.0.6"`, `"hono": ">=4.12.25"`, `"undici@<6.27.0": ">=6.27.0"` — scope the undici override to 6.x so the dev 7.x copy is untouched, research.md R2). Run `pnpm install`.
- [ ] T010 [US1] Verify JS regression: `pnpm nx test mcm-app` (unit) — these libs sit under the BFF/Expo server request path.
- [ ] T011 [US1] Re-run `pnpm audit` + `pnpm nx sast infrastructure-as-code`; confirm `GHSA-hmw2-7cc7-3qxx` (form-data), `GHSA-88fw-hqm2-52qc` (hono), `GHSA-vxpw-j846-p89q` (undici) absent from runtime scope. Delete those three `pnpm-audit` entries from `security/sast/allowlist.yaml`; gate green.

### Rust (root `Cargo.lock`)

- [ ] T012 [P] [US1] Bump the Rust transitive dep: `cargo update -p crossbeam-epoch --precise 0.9.20` (or latest ≥0.9.20 that resolves) from repo root — no `Cargo.toml` edit (research.md R3).
- [ ] T013 [US1] Verify Rust regression: `pnpm nx test mc-service`. Re-run `cargo audit` + the SAST scan; confirm `RUSTSEC-2026-0204` absent, delete its `cargo-audit` entry from `security/sast/allowlist.yaml`; gate green.

**Checkpoint**: All 19 runtime advisories cleared or carried-forward with rewritten justification; allowlist SCA blocking entries drop from 19 → residual. US1 shippable.

---

## Phase 4: User Story 2 - Container images run as a non-root user (Priority: P2)

**Goal**: Add a non-root `USER` to the five app-tier Dockerfiles and delete the `dockerfile.security.missing-user` allowlist entry.

**Independent Test (RED→GREEN)**: Before — `dockerfile.security.missing-user` fires for the five files, entry required. After — each image runs a non-root user, a fresh scan reports zero such findings for those files, the entry is deleted, and each image still starts + serves (web E2E for BFF; agent E2E for gateway + MCP).

- [ ] T014 [P] [US2] Harden `frontend/mcm-app/Dockerfile` (`node:alpine`, BusyBox): in the `runner` stage add `RUN addgroup -S mcm && adduser -S mcm -G mcm && chown -R mcm:mcm /app/runtime` and `USER mcm` before `CMD ["node","server.js"]` (research.md R4).
- [ ] T015 [P] [US2] Harden `agents/movie-assistant/Dockerfile` (`python:3.13-slim`, Debian): in the `runtime` stage add `RUN groupadd --system app && useradd --system --gid app --no-create-home app`, change the copy to `COPY --from=build --chown=app:app /app /app`, and `USER app` before `CMD`.
- [ ] T016 [P] [US2] Harden `mcp-servers/movie-mcp/Dockerfile` with the same Debian non-root pattern as T015 (`--chown=app:app` on the runtime `COPY`, `USER app` before `CMD`).
- [ ] T017 [P] [US2] Harden `mcp-servers/spreadsheet-mcp/Dockerfile` with the same Debian non-root pattern.
- [ ] T018 [P] [US2] Harden `mcp-servers/web-api-mcp/Dockerfile` with the same Debian non-root pattern (outbound-only; no inbound bind concern).
- [ ] T019 [US2] Rebuild + smoke-start each image: `pnpm nx build mcm-app`; `pnpm nx up-agents-prod infrastructure-as-code`. Confirm each container starts as the non-root user and serves. If any Python process needs to write under `/app`, redirect its cache to `/tmp` via env in the Dockerfile rather than reverting to root (research.md R4 edge).
- [ ] T020 [US2] Re-run the authoritative SAST scan; confirm `dockerfile.security.missing-user` fires zero times for the five files. Delete the shared `dockerfile.security.missing-user` entry from `security/sast/allowlist.yaml` (or NARROW its `locationPattern` if any single image provably cannot drop root, with a recorded reason). Gate green.
- [ ] T021 [US2] Run the real-user-path regression against the rebuilt images: `pnpm nx e2e mcm-app` (web) and `pnpm nx e2e:mobile mcm-app` (containerized agent E2E — exercises the hardened gateway + MCP + BFF). Rebuild-before-test already done in T019 (stale image = meaningless E2E).

**Checkpoint**: Five images non-root; `dockerfile.security.missing-user` cleared. US2 shippable.

---

## Phase 5: User Story 3 - CI/CD supply-chain controls tightened (Priority: P3)

**Goal**: Pin actions to commit SHAs, add release-age cooldowns, and triage `run-shell-injection`; clear the corresponding findings/entries.

**Independent Test (RED→GREEN)**: Before — `github-actions-mutable-action-tag` (~40, Medium/warning), `minimum-release-age` (Medium/warning), and the blocking `run-shell-injection` entry present. After — mutable-tag + release-age findings cleared (warnings gone), each shell-injection step is refactored (cleared) or retained-with-specific-justification, and the workflows still run green in CI.

- [ ] T022 [US3] Pin every third-party action in `.forgejo/workflows/guardrails.yml`, `app-ci.yml`, `cd-deploy.yml`, `renovate.yml` to its full commit SHA with a trailing `# vX.Y.Z` comment (resolve via `git ls-remote https://github.com/<owner>/<repo> refs/tags/<tag>`). Cover `actions/checkout`, `pnpm/action-setup`, `actions/setup-node`, `astral-sh/setup-uv`, `actions/upload-artifact`, `dorny/paths-filter`, `docker/*`, and any others. Local/composite (path-referenced) actions are exempt (research.md R5).
- [ ] T023 [P] [US3] Add `"minimumReleaseAge": "3 days"` to `renovate.json`; validate with `npx --yes renovate-config-validator renovate.json` (research.md R6).
- [ ] T024 [P] [US3] Add a minimum-release-age policy to `pnpm-workspace.yaml` (pnpm ≥10 `minimumReleaseAge`) and confirm exotic (git/http) sub-deps are blocked; add `minimum-release-age` to `.npmrc` to clear `npm-missing-minimum-release-age` (research.md R6).
- [ ] T025 [US3] Triage each of the six `run-shell-injection` steps in `app-ci.yml` + `cd-deploy.yml`: classify the interpolated `${{ … }}` value as attacker-controllable (PR title/body/branch → REFACTOR into a step `env:` + quoted `"$VAR"`) or trusted-internal (job output/secret/`github.sha` → RETAIN). Apply the refactors (research.md R7).
- [ ] T026 [US3] Re-run the authoritative scan. For refactored steps, confirm no `run-shell-injection` finding. Update `security/sast/allowlist.yaml`: if ALL six are refactored, delete the shared `run-shell-injection` entry; otherwise NARROW it to only the retained steps and REPLACE the generic baseline justification with a specific per-step trusted-value justification (SC-005 — no generic justification may remain). Confirm `github-actions-mutable-action-tag` and `minimum-release-age` warnings are gone.
- [ ] T027 [US3] Push the branch and confirm `guardrails` + `app-ci` run green with the pinned SHAs (a bad SHA fails fast at action resolution — CLAUDE.md CI-monitor loop; status via the commit-status endpoint, not the tasks list).

**Checkpoint**: Actions SHA-pinned, cooldowns added, shell-injection triaged. US3 shippable.

---

## Phase 6: User Story 4 - Dev/build-only dependency CVEs cleared (Priority: P4)

**Goal**: Opportunistically clear non-blocking dev/build advisories; no allowlist bookkeeping.

**Independent Test**: Before — advisories present as warnings. After — the scan warning set no longer lists them; no build/test regresses. (No RED/GREEN allowlist step — these are warnings, not blockers.)

- [ ] T028 [P] [US4] Bump the JS dev/build deps via `pnpm update` (with version-scoped `pnpm.overrides` where a transitive floor is needed): `undici` (7.x dev copy →≥7.28.0, distinct from the 6.x runtime override in T009), `vite`≥8.0.16, `ws`≥8.21.0, `minimatch`≥9.0.7, `picomatch`≥4.0.4, `http-proxy-middleware`≥3.0.7, `esbuild`≥0.28.1, `tmp`≥0.2.7. Run `pnpm install`.
- [ ] T029 [P] [US4] Bump the Rust dev advisory: `cargo update -p quick-xml` (→≥0.41.0) from repo root.
- [ ] T030 [US4] Verify no regression: `pnpm nx run-many --targets=test,lint` + `pnpm nx test mc-service`. Drop any single bump that proves disruptive (FR-008 — these are non-blocking). Re-run the SAST scan; confirm the warning set shrank.

**Checkpoint**: Dev-dep noise reduced. US4 shippable (optional).

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T031 [P] Sync `docs/proposals/sast-sca-hardening-backlog.md`: check off / annotate each cleared item and record any carried-forward debt with its upstream-constraint reason (research.md cross-cutting).
- [ ] T032 Confirm SC-006: the `security/sast/allowlist.yaml` blocking-entry count is materially below the T001 baseline; the only remaining blocking entries are the FR-010 keep-list + recorded carried-forward debt. Note the before/after counts.
- [ ] T033 Final authoritative validation: on CI, `node scripts/check-sast-findings.mjs` exits green (SC-001); the web E2E + agent E2E from T021 pass; agent/JS/mc-service suites pass (SC-008). Run `rtk gain` to confirm >80% compression on the test runs.
- [ ] T034 Update the memory note `project_mcm_034_hardening.md` + `MEMORY.md` with the outcome (entries burned down, any carried-forward debt, PR number).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately.
- **Foundational (Phase 2)**: Depends on Setup — fixes the keep-list + delete-on-fix rule before any deletion.
- **User Stories (Phase 3–6)**: All depend on Foundational. They are **independent of each other** and may proceed in any order or in parallel — US1 (deps), US2 (containers), US3 (CI), US4 (dev-deps) touch disjoint files, except both US1 and US4 edit `pnpm-lock.yaml`/`package.json` overrides (serialize those two, or land US1 first).
- **Polish (Phase 7)**: After the desired stories complete.

### User Story Dependencies

- **US1 (P1)**: Independent. MVP.
- **US2 (P2)**: Independent (Dockerfiles only). Note: US1's JS bump and US2's BFF rebuild both flow into the same web E2E — run E2E once after both if doing them together.
- **US3 (P3)**: Independent (workflow + pkg-manager config files).
- **US4 (P4)**: Shares `pnpm-lock.yaml`/`package.json` with US1 — serialize with US1 (do US1 first).

### Within Each User Story

- Bump/edit → verify regression → re-scan → delete allowlist entry (never reorder delete before re-scan).

### Parallel Opportunities

- US1: T009 (JS) and T012 (Rust) run parallel to the Python chain T005–T008.
- US2: T014–T018 (five Dockerfiles) are all [P] — different files.
- US3: T023 (renovate) and T024 (pnpm/npm) are [P]; T022 (SHA pins) is independent of both.
- US4: T028 (JS) and T029 (Rust) are [P] — but T028 serializes after US1's T009 (shared lockfile).

---

## Parallel Example: User Story 2

```bash
# Harden all five Dockerfiles together (different files):
Task: "T014 non-root USER in frontend/mcm-app/Dockerfile"
Task: "T015 non-root USER in agents/movie-assistant/Dockerfile"
Task: "T016 non-root USER in mcp-servers/movie-mcp/Dockerfile"
Task: "T017 non-root USER in mcp-servers/spreadsheet-mcp/Dockerfile"
Task: "T018 non-root USER in mcp-servers/web-api-mcp/Dockerfile"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Phase 1 Setup → Phase 2 Foundational.
2. Phase 3 US1 (runtime dep CVEs) — the highest-value slice.
3. **STOP and VALIDATE**: authoritative scan green, 19 SCA entries deleted, agent/JS/mc-service suites pass.
4. Ship as the security MVP.

### Incremental Delivery

1. Setup + Foundational → baseline fixed.
2. US1 (runtime CVEs) → validate → ship (MVP).
3. US2 (non-root containers) → web + agent E2E → ship.
4. US3 (CI supply-chain) → CI green → ship.
5. US4 (dev-deps) → opportunistic → ship or defer.

### Notes

- [P] = different files, no dependencies.
- Delete an allowlist entry ONLY after the authoritative (CI/Linux) scan confirms the finding absent — never on hope (data-model.md).
- Never touch the FR-010 keep-list.
- Commit after each story's burn-down so the allowlist shrinks monotonically and each slice is independently reviewable.
