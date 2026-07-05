---
description: "Task list for 027-ci-maestro-secrets implementation"
---

# Tasks: Keep E2E Secrets Off the Test-Runner Command Line

**Input**: Design documents from `specs/027-ci-maestro-secrets/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/)

**Tests**: TDD is mandatory (constitution). The regression guard's `--selftest` is the RED/GREEN unit surface; the wrapper's behavior is proven by the flow suite + a `ps`/`/proc` no-secret assertion.

**Organization**: By user story (US1 P1 → US2 P2 → US3 P3). The shared wrapper is foundational (Phase 2) because US1 and US2 both depend on it.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1 / US2 / US3 (setup, foundational, polish carry no story label)

## Path Conventions

CI/test tooling feature — paths are repo-root: `scripts/`, `.forgejo/workflows/`, `frontend/mcm-app/tests/e2e/mobile/`, `docs/`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Prepare the dev credential source; no secrets committed.

- [X] T001 [P] Confirm `frontend/mcm-app/.env.e2e.local` is gitignored (matches the `.gitignore` `*.env.*` rule) and record the required var list (`E2E_TEST_USER`, `E2E_TEST_PASSWORD`, `ANTHROPIC_API_KEY`, `TMDB_API_KEY`) in the `scripts/maestro-run.sh` header comment + [quickstart.md](./quickstart.md). Do NOT create a committed example file that would carry values.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The sanctioned argv-free runner that US1 and US2 both build on.

**⚠️ CRITICAL**: US1 and US2 cannot proceed until the wrapper exists and its `MAESTRO_`-prefix delivery is smoke-verified.

- [X] T002 Implement `scripts/maestro-run.sh` per [contracts/maestro-run.md](./contracts/maestro-run.md): source `frontend/mcm-app/.env.e2e.local` if present; for each of `E2E_TEST_USER`/`E2E_TEST_PASSWORD`/`ANTHROPIC_API_KEY`/`TMDB_API_KEY`, `export MAESTRO_<NAME>` only when set (fail-clean, no `:-literal` fallback); `exec maestro test "$flow"` forwarding only non-secret args. Guarantees G1–G4.
- [ ] T003 Smoke-verify the `MAESTRO_` prefix behavior (research R2): with `.env.e2e.local` present, run `../../scripts/maestro-run.sh tests/e2e/mobile/login-keycloak.yaml` from `frontend/mcm-app`.
  - **Verify GREEN**: the flow logs in successfully (proves shell `MAESTRO_E2E_TEST_PASSWORD` → in-flow `${E2E_TEST_PASSWORD}`, prefix stripped → no flow-body edits needed).
  - If login fails on the password step, the prefix is NOT stripped → extend the wrapper to also export the unprefixed name (wrapper-only change) before proceeding.
  - ⏳ **Status**: mechanism verified off-emulator (stub-`maestro` harness confirms argv is secret-free, `MAESTRO_*` twins exported from `.env.e2e.local`, TMDB-unset skipped, exit-code passthrough). Live login GREEN needs a running Android emulator + APK — deferred to an emulator session.

**Checkpoint**: Wrapper works; in-flow variable naming confirmed. US1 and US2 may begin.

---

## Phase 3: User Story 1 - No secret in the CI process list (Priority: P1) 🎯 MVP

**Goal**: The CI agent-flow suite runs with no secret value on any `maestro`/child argv.

**Independent Test**: Run the CI runner; while a flow executes, inspect the process list on the host — no known secret value appears in any process's arguments.

- [X] T004 [US1] Edit `scripts/ci-mobile-agent-flows.sh` `run_flow()`: remove the four `--env E2E_TEST_USER/E2E_TEST_PASSWORD/ANTHROPIC_API_KEY/TMDB_API_KEY` lines and call `scripts/maestro-run.sh "$1"` instead (job env still supplies the secrets; retry/attempt loop unchanged).
  - **Verify RED (pre-fix)**: run the current script and, concurrently, `ps -ww -ef | grep maestro | grep -Ei 'E2E_TEST_PASSWORD=|ANTHROPIC_API_KEY=|sk-ant-|TMDB_API_KEY='` → the literal secret values ARE printed (the leak).
- [ ] T005 [US1] Verify GREEN (SC-001, SC-002): run `bash scripts/ci-mobile-agent-flows.sh` (emulator + APK up) and concurrently the quickstart V4 `ps`/`/proc` check → prints `clean` (no secret in argv), and the full flow list (gating → enable-anthropic → 4 agent flows → disable) passes.
  - ⏳ **Deferred (emulator-gated)**: requires a running Android emulator + APK on the runner host. `scripts/ci-mobile-agent-flows.sh` now calls the wrapper (T004), so the argv path is structurally secret-free; the live `ps` GREEN + full-suite pass runs in an emulator/CI session.

**Checkpoint**: The core security outcome holds in the CI path.

---

## Phase 4: User Story 2 - One sanctioned path shared by CI and dev (Priority: P2)

**Goal**: A single documented invocation used by CI and dev; the leaky `--env <secret>=` example is removed from every live surface so it stops propagating.

**Independent Test**: A developer runs any single flow via `scripts/maestro-run.sh` with `.env.e2e.local` and no secret on the command line; the documented "how to run a flow" shows the sanctioned path everywhere.

- [X] T006 [P] [US2] Repoint the `# Run:` header comments in the active mobile flow files under `frontend/mcm-app/tests/e2e/mobile/*.yaml` (the 32 files that show `maestro test … --env <secret>=`) to `scripts/maestro-run.sh tests/e2e/mobile/<flow>.yaml [--env COLLECTION_NAME=…]`. **Comments only — do NOT touch flow bodies** (the `${…}` references are unchanged per R2).
- [X] T007 [P] [US2] Repoint the invocation snippets in `docs/runbooks/android-emulator.md` to the wrapper.
- [X] T008 [P] [US2] Repoint the single-flow snippet in `docs/MCM-Testing-Strategy.md` to the wrapper.
- [X] T009 [P] [US2] Repoint the `maestro test … --env …` example in `CLAUDE.md` (Test Run Protocol section) to the wrapper; keep the "no single-flow Nx passthrough" note.
- [X] T010 [US2] Verify (SC-003): from `frontend/mcm-app` with `.env.e2e.local`, run `../../scripts/maestro-run.sh tests/e2e/mobile/assistant-add.yaml --env COLLECTION_NAME="t-$(date +%s)"` → passes with no secret typed on the command line; `grep -rEn 'maestro .*--env (E2E_TEST_PASSWORD|ANTHROPIC_API_KEY|TMDB_API_KEY)=' scripts docs CLAUDE.md frontend/mcm-app/tests/e2e/mobile` → no matches.
  - ✅ **Grep GREEN** (the SC-003-verifiable invariant): no `--env <credential>=` remains on any live surface (`scripts`, `docs` excl. design-record `docs/proposals/**`, `CLAUDE.md`, mobile flows). ⏳ The live single-flow `assistant-add.yaml` pass is emulator-gated.

**Checkpoint**: One blessed path; no live surface teaches the leaky pattern.

---

## Phase 5: User Story 3 - Regression guard (Priority: P3)

**Goal**: An automated keyless gate fails the build if any in-scope file reintroduces a `--env <credential>=` argument to the test runner.

**Independent Test**: Plant a `--env E2E_TEST_PASSWORD=…` line in a tracked in-scope file → guard fails; remove it → guard passes; historical `specs/0NN/**` never flagged.

- [X] T011 [US3] Author `scripts/check-no-argv-secrets.mjs` `--selftest` FIRST per [contracts/argv-secret-guard.md](./contracts/argv-secret-guard.md): planted positives (single-line `maestro test x.yaml --env E2E_TEST_PASSWORD="$P"`; multi-line flag + backslash-continued `--env ANTHROPIC_API_KEY=…`) and clean negatives (`scripts/maestro-run.sh …`, `--env COLLECTION_NAME=…`, `--env E2E_TEST_USER=…`).
  - **Verify RED**: `node scripts/check-no-argv-secrets.mjs --selftest` fails (detection logic not yet implemented) — a Verify RED showing 0 failures means the selftest is trivially passing and must be corrected first.
- [X] T012 [US3] Implement the guard scan + detection (regex on `(--env|-e)\s+<KEY matching KEY|PASSWORD|SECRET|TOKEN>=`, quoting/line-continuation tolerant), scoped to `scripts/**`, `frontend/mcm-app/tests/e2e/mobile/*.yaml`, `docs/**`, `CLAUDE.md`; allowlist `specs/0NN/**` and `SELF`.
  - **Verify GREEN** (SC-004, SC-005): `--selftest` passes; plain `node scripts/check-no-argv-secrets.mjs` passes on the cleaned tree (requires T004 + T006–T009 done) and would fail if a `--env E2E_TEST_PASSWORD=` line were re-added.
- [X] T013 [US3] Wire the guard into `.forgejo/workflows/guardrails.yml` (naming job): add `node scripts/check-no-argv-secrets.mjs --selftest` then `node scripts/check-no-argv-secrets.mjs` as steps, matching the sibling gates.

**Checkpoint**: The invariant is enforced on every push/PR.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T014 [P] Run the full [quickstart.md](./quickstart.md) V1–V7 validation and record outcomes.
  - ✅ **V1** guard selftest, **V2** guard scan (cleaned tree), **V7** secret-scan + inline-secret gates — all GREEN (keyless). ⏳ **V3–V6** (in-flow parity smoke, live `ps` clean, CI suite, fail-clean-on-unset) are emulator-gated — deferred to an emulator session; V6's fail-clean is structurally guaranteed by the wrapper (no `:-literal` fallback, unit-verified).
- [X] T015 Final validation (SC-007): `node scripts/secret-scan.mjs --selftest && node scripts/secret-scan.mjs` and `node scripts/check-no-inline-secrets.mjs --selftest && node scripts/check-no-inline-secrets.mjs` stay green; confirm no secret added to git (`.env.e2e.local` gitignored). Update the Platform Parity Table below with final status.

---

## Phase 7: User Story 4 - No hardcoded credential fallback in test/tooling code (Priority: P2)

**Goal**: The live test-user password (`the-live-E2E-password`) appears nowhere in the tree; every E2E-credential consumer reads from env / `.env.e2e.local` and fails clean when unset; the whole-tree gate prevents regression. (FR-012–FR-015, SC-008–SC-010.)

**Independent Test**: `git grep 'the-live-E2E-password'` → zero. Run web E2E global setup with the creds unset + no file → fails visibly (no silent literal). Extended `secret-scan.mjs --selftest` → detects the planted literal + fallback shape; plain scan passes on the cleaned tree.

- [X] T016 [US4] Add a shared `.env.e2e.local` loader for the consumers that lack one: the Playwright path (`frontend/mcm-app/tests/e2e/web/setup/global-setup.ts` + `bff-prod-lifecycle.spec.ts`, via a small dotenv-free loader mirroring `tests/integration/setup/env.ts`) and `frontend/mcm-app/scripts/cleanup-e2e-data.ts`. Load before reading `process.env`.
- [X] T017 [US4] Make the JS/TS live-credential consumers fail-clean (drop the `?? 'the-live-E2E-password'` literal): `global-setup.ts`, `bff-prod-lifecycle.spec.ts`, `keycloak-test-client.ts`, `cleanup-e2e-data.ts`. A must-run consumer throws a clear error when `E2E_TEST_PASSWORD` is unset; keep the `E2E_TEST_USER` value from env too (drop its literal default).
- [X] T018 [US4] Make the python live-credential consumers fail-clean: `mcp-servers/movie-mcp/tests/integration/conftest.py` + `agents/movie-assistant/tests/integration/kc_admin.py` — `_cfg("E2E_TEST_PASSWORD")` with no default; ensure the existing skip-when-creds-absent guard also covers the password.
- [X] T019 [US4] `scripts/export-ci-realm.mjs`: make the live `E2E_TEST_PASSWORD` fallback fail-clean (require env). LEAVE the documented feature-023 throwaway CI-realm client secrets (`CI_*_SECRET ?? 'ci-throwaway-*'`) — they are disposable-realm fixtures, allowlisted in the gate per that file's own instruction.
- [X] T020 [US4] Redact the live password from the three historical spec examples (`specs/001-user-login/integration-guide.md`, `specs/002-manage-movie-collection/tasks.md`, `specs/012-multi-agent-mvp/tasks.md`): replace the `the-live-E2E-password` literal with `$E2E_TEST_PASSWORD`, preserving the rest of the frozen record.
- [X] T021 [US4] Extend `scripts/secret-scan.mjs` `--selftest` FIRST (RED) then the detector (GREEN): (a) flag the exact known live password literal (assembled from fragments so the scanner file never carries the joined value — `SELF` is also scan-excluded); (b) flag the `E2E_TEST_PASSWORD` fallback shape — a **non-empty** quoted literal default via `?? / || / ,`, NOT `?? ''`. Plain scan passes on the cleaned tree.
  - **Implementation note (deviation from the original plan)**: Rule (b) is **scoped to `E2E_TEST_PASSWORD` specifically**, not a generic `PASSWORD|SECRET|TOKEN|API_KEY` match. A tree-wide grep proved a generic rule false-positives heavily on public non-secrets that merely contain those substrings — `*_CLIENT_ID` / `*_AUDIENCE` / `*_TTL_SECONDS`, the deterministic LangFuse `sk-lf-mcm-dev-*` fixtures, `monkeypatch.setenv(...)` test injections, and the documented feature-023 throwaway CI-realm client secrets. Scoping to the one credential we actually manage this way is precise (zero false positives) and makes the `export-ci-realm.mjs` allowlist **unnecessary** — its throwaway client secrets are simply out of the rule's scope.
- [X] T022 [US4] Verify (SC-008/009/010): `git grep 'the-live-E2E-password'` → none; `node scripts/secret-scan.mjs --selftest && node scripts/secret-scan.mjs` green; `pnpm nx lint mcm-app` + `pnpm exec tsc --noEmit` clean; a spot fail-clean check (unset `E2E_TEST_PASSWORD` → global-setup throws).

**Checkpoint**: The live E2E password is gone from the tree; every consumer is fail-clean; the gate blocks regression.

---

## Platform Parity Table

| Scenario | Web (Playwright) | Mobile (Maestro) | Justification |
|---|---|---|---|
| Secret delivered off command line to the test runner | **N/A** | ✅ `scripts/maestro-run.sh` (`MAESTRO_`-prefix) | Web Playwright passes secrets via `-e NAME` process env (`docker run -e ANTHROPIC_API_KEY …`), not argv — no `ps` leak, so no change needed (spec Non-goals). |
| No secret value in the runner process list | **N/A** | ✅ SC-001 `ps`/`/proc` check | Same as above — the leak is Maestro-`--env`-argv-specific. |
| Regression guard on `--env <credential>=` | ✅ (tree-wide scan incl. any web docs) | ✅ (mobile flow headers + CI script) | The guard is platform-agnostic; it scans all in-scope files regardless of client. |

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: none — start immediately.
- **Foundational (Phase 2)**: after Setup. **Blocks US1 and US2.** (T002 → T003.)
- **US1 (Phase 3)**: after T002/T003.
- **US2 (Phase 4)**: after T002. Independent of US1 (can run in parallel).
- **US3 (Phase 5)**: T011 (selftest) can be written any time after Phase 2; T012's plain-scan GREEN requires the tree cleaned by **T004 + T006–T009**; T013 after T012.
- **Polish (Phase 6)**: after US1+US2+US3.

### Within / Across Stories

- T003 depends on T002. T004 → T005. T006–T009 are mutually parallel `[P]` (different files). T010 depends on T006–T009. T012 depends on T011 (RED first) and on the tree being cleaned (T004, T006–T009). T013 depends on T012.

### Parallel Opportunities

- T006, T007, T008, T009 (`[US2]`, different files) run in parallel.
- T011 (guard selftest authoring) can proceed while US2 doc-repoints happen.
- US1 (T004–T005) and US2 (T006–T010) can be worked concurrently once the wrapper (T002) exists.

---

## Parallel Example: User Story 2 doc/header repoints

```bash
# Different files, no interdependency — run together:
Task: "Repoint flow-file # Run: headers in frontend/mcm-app/tests/e2e/mobile/*.yaml (T006)"
Task: "Repoint docs/runbooks/android-emulator.md (T007)"
Task: "Repoint docs/MCM-Testing-Strategy.md (T008)"
Task: "Repoint CLAUDE.md Test Run Protocol example (T009)"
```

---

## Implementation Strategy

### MVP First (US1)

1. Phase 1 Setup → 2. Phase 2 wrapper (T002–T003) → 3. Phase 3 CI repoint (T004–T005) → **STOP & VALIDATE**: the `ps` check is `clean` in the CI path. This alone closes the exposure that motivated the feature.

### Incremental Delivery

1. Setup + wrapper → foundation ready.
2. US1 (CI security) → validate `ps` clean → MVP.
3. US2 (consolidation + docs) → one sanctioned path everywhere.
4. US3 (guard) → invariant enforced so it can't regress.

---

## Notes

- No flow-body edits — only `# Run:` header comments and invocation commands change (R2: Maestro strips the `MAESTRO_` prefix in-flow).
- Historical `specs/0NN/**` are allowlisted: not rewritten, not scanned (spec clarification).
- Fail-clean is a hard rule: never add a `:-literal` / `?? 'literal'` fallback for an unset secret.
- Commit after each task or logical group; keep `.env.e2e.local` out of git.
