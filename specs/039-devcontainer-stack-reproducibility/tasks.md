---
description: "Task list for feature 039 — Dev-Container Stack Reproducibility"
---

# Tasks: Dev-Container Stack Reproducibility

**Input**: Design documents from `specs/039-devcontainer-stack-reproducibility/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/)

**Tests**: This is an infrastructure/CI-config feature with no application units. The "tests" are executable verification gates (dual-Compose parse + profile-selection invariance, a fresh-volume login verify script, a realm-consistency check with `--selftest`, and the CI required-context behavior on one PR of each kind). They are expressed as Verify-RED / Verify-GREEN checkpoints where ordering allows.

**Organization**: Grouped by user story (US1/US2/US3) for independent implementation and testing. Each maps to one workstream from plan.md.

> **Implementation status (2026-07-14): all three workstreams IMPLEMENTED + locally verified; not yet committed.** Deviations/additions worth noting (plan/tasks kept aligned per constitution): (1) `gen-dev-env.mjs` also syncs **`.env.e2e.local`** (web-E2E creds → seeded realm) — discovered during T029 when that file was hand-stale (`E2E_TEST_USER=testuser`, wrong password), the exact fresh-box rot; (2) `agent-gateway/compose.yaml` was refactored from `extends:` to a **YAML anchor** because `extends` copies `profiles:` and leaked `[agents]` onto the Metro variant; (3) the realm-file mount uses a project-dir-relative source (`../keycloak/dev-realm.json`), verified via `config`, not CI's absolute-path pattern; (4) two legacy standalone Nx targets (`nx deploy mc-service`, bff `deploy`/`docker-up`) gained `--profile` flags to preserve behavior. T029 web E2E: **128 passed / 5 failed**, all 5 failures the assistant-dock suite requiring the agent stack (Ollama+gateway) that was not brought up — orthogonal to this feature; green in CI. Remaining hands-on: commit+forge PR, AC6 (PR-behavior) + AC3 (v2.40.x apt-plugin parse) on CI/dev-container.

> **Implementation order note (important):** value-priority is US1 (P1) > US2 (P2) > US3 (P3), but the **recommended sequencing is US2 → US1 → US3** (PRD §8; spec Assumptions): land the CI required-check fix (US2 / Workstream C) FIRST so this feature's own follow-up PRs merge without an admin-override tax; then the high-impact realm seed (US1 / A); then the mechanical compose portability (US3 / B). The three phases are fully independent — pick any order.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1 / US2 / US3 (Setup/Foundational/Polish carry no story label)

## Path Conventions

Infra/CI change to an existing monorepo — paths are real repo paths under `infrastructure-as-code/`, `.forgejo/workflows/`, `scripts/`, `verify/`, `docs/runbooks/`. Shell examples are cross-shell (`docker`, `node`); PowerShell is the default host shell.

---

## Phase 1: Setup (Shared)

**Purpose**: Confirm the working branch and capture pre-change baselines the verifications compare against.

- [ ] T001 Confirm on branch `039-devcontainer-stack-reproducibility` and that `.specify/feature.json` points at `specs/039-devcontainer-stack-reproducibility`; confirm Docker + `pnpm install` are ready.
- [ ] T002 [P] Capture the pre-change profile-selection baseline (US3 comparison) on the current tree: for each of ``, `--profile app`, `--profile bff-nonsecure`, `--profile bff-secure`, `--profile agents`, `--profile agents-metro`, and `--profile app --profile bff-nonsecure`, run `docker compose -p mcm -f infrastructure-as-code/docker/stacks/mcm.compose.yaml <P> config --services | sort` and save the outputs to `specs/039-devcontainer-stack-reproducibility/contracts/baseline-profile-selection.txt`.
- [ ] T003 [P] Record the installed `docker compose version` and, if available, note access to a v2.40.x apt-plugin environment for the dual-Compose parse check (AC3) — the dev container / an apt-plugin box.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: None blocking. The three user stories are fully independent — no shared foundation must land first. Proceed directly to the user-story phases (recommended order US2 → US1 → US3).

**Checkpoint**: No foundational work; user-story phases may begin.

---

## Phase 3: User Story 1 — Fresh-volume realm seed (Priority: P1) 🎯 MVP

**Goal**: On a fresh `keycloak-store-postgres-data` volume the standard dev auth bring-up seeds the `grumpyrobot` realm + `e2e-test-user` + all app clients automatically, with no manual import and no literal secret in git. (Workstream A; FR-001..006, FR-013, FR-015)

**Independent Test**: Wipe the auth volume → `gen-dev-secrets` → `pnpm nx up-auth` → `node verify/verify-fresh-realm-seed.mjs` reports a successful login. (quickstart Scenario 1)

### Verify RED (before implementation)

- [ ] T004 [US1] Write `verify/verify-fresh-realm-seed.mjs` (wipe+recreate `keycloak-store-postgres-data` → `gen-dev-secrets` → `up-auth --wait` → headless PKCE login assert, reusing the DAST/BFF headless-login helper pattern in `scripts/dast-bff-login.mjs`). **Verify RED**: on `main`'s behavior (no dev import) the script FAILS at the login/realm-present assertion (empty Keycloak). Capture the failing output.

### Implementation for User Story 1

- [ ] T005 [P] [US1] Confirm `dev-realm.json` will be tracked: `git check-ignore infrastructure-as-code/docker/keycloak/dev-realm.json` must report NOT ignored (exit 1); if a `.gitignore` pattern over-matches, add a negation. (research R-G1, contract PC-7)
- [ ] T006 [US1] Create `infrastructure-as-code/docker/keycloak/dev-realm.json`: realm `grumpyrobot`, the same app-client set + `e2e-test-user` as `ci-realm.json`, dev redirect URIs/web-origins (`localhost:8099`/`localhost:8082`), and **only** `${ENV_VAR}` placeholders for every client secret + the test-user password (canonical names from plan Workstream A / data-model INV-1..3).
- [ ] T007 [P] [US1] Extend `infrastructure-as-code/docker/stacks/auth.env.example` with placeholders for `KEYCLOAK_CLIENT_SECRET`, `KEYCLOAK_SERVICE_CLIENT_SECRET`, `AGENT_SUBJECT_TOKEN_CLIENT_SECRET`, `AGENT_GATEWAY_CLIENT_SECRET`, `MC_SERVICE_CLIENT_SECRET`, `E2E_ROPC_CLIENT_SECRET` (`<generate:hex-64>`) and `E2E_TEST_PASSWORD` (`<generate:complex-16>`).
- [ ] T008 [US1] Extend `scripts/gen-dev-secrets.mjs` only if a new generation KIND is required for the above; otherwise confirm the existing `hex-64`/`complex-16` kinds mint them, and that a `gen-dev-secrets` run writes them into `stacks/auth.env`.
- [ ] T009 [US1] Create `infrastructure-as-code/docker/keycloak/compose.dev.yaml` (dev twin of `compose.ci.yaml`): append `--import-realm` to `keycloak-service.command`, mount the realm file read-only to `/opt/keycloak/data/import/grumpyrobot-realm.json` via an **absolute** path (`${DEV_REALM_FILE:?}`) to avoid the relative-source-resolves-to-empty-dir trap (research R-A1), and pass the placeholder secrets through as `${VAR:?}` env.
- [ ] T010 [US1] Wire the dev overlay into the bring-up path: update `up-auth` (and the composite `up`) in `infrastructure-as-code/project.json` to add `-f infrastructure-as-code/docker/keycloak/compose.dev.yaml` and supply `DEV_REALM_FILE` as an absolute path (via a tiny wrapper if the static Nx command cannot compute `$PWD`). Do NOT touch `keycloak/compose.yaml` or `compose.ci.yaml`. (FR-012, data-model INV-6)
- [ ] T011 [US1] Resolve dev BFF secret source-of-truth (research R-A2): confirm which dev BFF/mc-service env the dev loop reads for the client secrets and ensure it derives from / equals `auth.env`, so realm-secret == client-secret after one `gen-dev-secrets` run. Document the wiring.
- [ ] T012 [P] [US1] Create `scripts/check-realm-consistency.mjs` asserting dev-realm ⟷ ci-realm `realm`, app-client-id set, and `e2e-test-user` presence match; add `--selftest` that FAILS on a mutated fixture (missing/extra client, missing user). (FR-013, contract realm-consistency PC-1..4)
- [ ] T013 [US1] Wire `check-realm-consistency.mjs` into `.forgejo/workflows/guardrails.yml` (`--selftest` then real), gating PRs that edit either realm file. (research R-A3)

### Verify GREEN

- [ ] T014 [US1] **Verify GREEN**: run quickstart Scenario 1 (`gen-dev-secrets` → `pnpm nx up-auth` on a freshly wiped volume → `node verify/verify-fresh-realm-seed.mjs`) → login succeeds, realm+user+clients present. Then run `pnpm nx up-auth` a second time on the now-seeded volume → no duplicate-import error, realm unchanged (FR-002 non-destructive). Confirm the stale-password recovery path (wipe → up-auth) re-seeds (SC-007).
- [ ] T015 [US1] **Verify GREEN (secrets gate)**: `node scripts/secret-scan.mjs`, `node scripts/check-no-inline-secrets.mjs`, and `node scripts/check-realm-consistency.mjs` all pass with `dev-realm.json` committed. (AC4, contract PC-5/6)

**Checkpoint**: US1 fully functional — a from-scratch box seeds a working auth realm automatically.

---

## Phase 4: User Story 2 — infra-image-scan always-post required context (Priority: P2)

**Goal**: The branch-protection-required `infra-image-scan / infra-image-scan` context is posted on every PR (success when no infra image ref changed; the real Trivy gate when one did), so non-infra PRs merge with no admin override. (Workstream C; FR-007..009)

**Independent Test**: One docs-only PR shows the context = success and merges via API with no override; one infra-ref PR runs the full scan and blocks on a fixable-Critical. (quickstart Scenario 5)

### Implementation for User Story 2

- [ ] T016 [US2] Refactor `.forgejo/workflows/infra-image-scan.yml` to mirror `app-ci.yml`'s always-post shape: (a) remove the `pull_request:` `paths:` filter (keep `schedule` weekly + `push`); (b) add an always-running `changes` job using `dorny/paths-filter@v3` that outputs `infra` from the current infra-image-ref path list; (c) keep the job named `infra-image-scan` as `needs: [changes]` with **no job-level `if`** (always runs) and gate the Trivy install/scan/gate STEPS on `if: ${{ needs.changes.outputs.infra == 'true' }}`. (data-model INV-9/10, contract ci-required-context; research R-C1 — do NOT job-level-skip.)
- [ ] T017 [P] [US2] Add a provenance comment in the workflow explaining WHY the required-named job is always-run with step-level gating (the PRD Gap-3 subtlety), so it is not "simplified" back into a job-level `if` later.

### Verify GREEN

- [ ] T018 [US2] **Verify GREEN**: open a docs-only / `.devcontainer`-only PR on the forge; confirm the head-SHA commit status lists `infra-image-scan / infra-image-scan = success` and the PR merges via the API with no admin override (no 405). Open a PR that bumps a pinned infra `image:` tag; confirm the `infra-image-scan` job runs Trivy and blocks if a fixable-Critical is present. (AC6, SC-005) Confirm the required-context pattern in `main` branch protection is unchanged (workflow-only fix).

**Checkpoint**: US2 fully functional — non-infra PRs merge without an override; infra PRs stay gated.

---

## Phase 5: User Story 3 — Portable compose profiles (Priority: P3)

**Goal**: The application stacks parse and select identical services on any conformant Compose (v2.40.x apt plugin ↔ v5.x), with no include-override merge dependency. (Workstream B; FR-010, FR-011)

**Independent Test**: `docker compose … --profile <p> config` succeeds under both Compose versions and each profile selects the same services as the T002 baseline. (quickstart Scenario 3, contract profile-selection-invariance)

### Implementation for User Story 3

- [ ] T019 [US3] Audit consumers (FR-011 guard, research R-B1): confirm no `scripts/`, `.forgejo/`, project.json, or doc site runs `docker compose -f infrastructure-as-code/docker/<svc>/compose.yaml` standalone expecting a now-profiled service to start by default; record the result in `contracts/profile-selection-invariance.md`.
- [ ] T020 [P] [US3] Add `profiles: [app]` to `mc-service` in `infrastructure-as-code/docker/mc-service/compose.yaml` (leave `mc-service-store-mongo` + rs-init profile-less).
- [ ] T021 [P] [US3] Add the bff profiles in `infrastructure-as-code/docker/bff/compose.yaml`: `mcm-bff-service-nonsecure`→`[bff-nonsecure]`, `mcm-bff-service-secure`→`[bff-secure]`, `mcm-bff-tls-proxy`→`[bff-secure]` (leave `mcm-bff-cache-redis` + `mcm-bff-store-mongo` profile-less).
- [ ] T022 [P] [US3] Add `profiles: [agents]` / `[agents-metro]` in `infrastructure-as-code/docker/agent-gateway/compose.yaml` (`movie-assistant-gateway`→`[agents]`, `movie-assistant-gateway-metro`→`[agents-metro]`).
- [ ] T023 [P] [US3] Add `profiles: [agents]` in `infrastructure-as-code/docker/movie-mcp/compose.yaml`, `web-api-mcp/compose.yaml`, and `spreadsheet-mcp/compose.yaml` (the 3 MCP services).
- [ ] T024 [P] [US3] Add `profiles: [agents]` to `movie-assistant-store-postgres` in `infrastructure-as-code/docker/agent-db/compose.yaml`.
- [ ] T025 [US3] Delete the top-level `services:` re-declaration block from `infrastructure-as-code/docker/stacks/mcm.compose.yaml` (the profiles now live in the included files); keep the `include:` list and the header comments (update the "Profiles" comment to note profiles are declared in the service files).

### Verify GREEN

- [ ] T026 [US3] **Verify GREEN**: under the current Compose, re-run the T002 selection commands and diff against `baseline-profile-selection.txt` — identical for every profile (contract PC-2). Then run `docker compose -p mcm -f …/mcm.compose.yaml --profile app config` under a **v2.40.x apt plugin** — exits 0 with no `services.<x> conflicts with imported resource` (contract PC-1, AC3).

**Checkpoint**: US3 fully functional — stacks portable across Compose versions, selection unchanged.

---

## Phase 6: Polish & Cross-Cutting

**Purpose**: Docs, end-to-end proof, and handoff.

- [ ] T027 [P] Update `docs/runbooks/local-dev.md` (AC5): document the one-command fresh-volume bring-up (`gen-dev-secrets` → `up-auth` auto-seeds the realm) and update the stale-password recovery note to reflect automatic re-seeding on the next `up-auth`.
- [ ] T028 [P] Update `docs/runbooks/devcontainer.md` (AC5): document the clean-container fresh bring-up path (committed config + `gen-dev-secrets` only, no bespoke realm import).
- [ ] T029 Run quickstart Scenario 2 (clean bring-up → `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app`) — **the web E2E regression is REQUIRED for this feature** even though it is infra-only; rebuild `mcm-app` image first if the BFF container is stale (constitution Final Validation / feedback_e2e_regression_when_done). Confirm green.
- [ ] T030 [P] Run `rtk gain` after the test runs to confirm >80% token compression (constitution prerequisite).
- [ ] T031 Update the SDD artifacts if implementation deviated from plan/tasks (constitution: keep spec/plan/tasks aligned), and update memory `project_mcm_039_devcontainer_reproducibility.md` + `MEMORY.md` to reflect the shipped state.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies; T002 baseline must be captured BEFORE any US3 edit.
- **Foundational (Phase 2)**: none.
- **User Stories (Phase 3/4/5)**: fully independent of each other — implement in any order (recommended US2 → US1 → US3). Each is its own MVP increment.
- **Polish (Phase 6)**: after the user stories intended for this release are done; T029 web E2E is the end-to-end gate.

### Within Each User Story

- US1: Verify-RED (T004) → build realm/overlay/secrets/checks (T005–T013) → Verify-GREEN (T014–T015).
- US2: refactor workflow (T016–T017) → Verify-GREEN on the forge (T018).
- US3: capture baseline (T002, Setup) → audit (T019) → per-file profile moves (T020–T024) → delete merge block (T025) → Verify-GREEN dual-Compose (T026).

### Parallel Opportunities

- Setup: T002, T003 in parallel.
- US1: T005, T007, T012 in parallel (different files); T006 before T012's fixture comparisons; T009→T010 sequential (overlay before wiring).
- US3: T020–T024 all `[P]` (different per-service files); T025 after them; T019 audit first.
- Polish: T027, T028, T030 in parallel; T029 gates.
- Across stories: US1, US2, US3 can be worked by different people simultaneously.

---

## Implementation Strategy

### Recommended path (unblock-first)

1. Phase 1 Setup (capture the US3 baseline now, before edits).
2. **US2 (Workstream C)** — cheapest, removes the admin-override tax so this feature's own PRs (and all future non-infra PRs) merge cleanly. Ship it.
3. **US1 (Workstream A / MVP value)** — highest-impact: from-scratch onboarding + auth works automatically. Ship it.
4. **US3 (Workstream B)** — mechanical portability de-risking. Ship it.
5. Phase 6 Polish: runbooks + the REQUIRED web E2E regression + memory/handoff.

### MVP scope

US1 alone is the headline value (a from-scratch box seeds a working auth realm), but US2 should precede it operationally. Each phase is independently deployable.

---

## Notes

- `[P]` = different files, no dependency.
- No clear-text secret may enter git — `dev-realm.json` is placeholders-only; the secret gates (T015) are the guard.
- Do NOT touch the shared `keycloak/compose.yaml` base or the CI `compose.ci.yaml` / prod realm path (FR-012).
- Do NOT job-level-skip the `infra-image-scan` required job — step-level gate only (research R-C1).
- Retain feature-038's interim Compose-v5 bake as defense-in-depth (spec Assumption).
- The web E2E regression (T029) is mandatory even for this infra-only feature (constitution Final Validation).
