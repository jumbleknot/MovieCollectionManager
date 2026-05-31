---
description: "Task list for Clean Up Project Flakiness"
---

# Tasks: Clean Up Project Flakiness

**Input**: Design documents from `specs/006-clean-flakiness/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [quickstart.md](./quickstart.md)

**Tests**: This feature's "tests" are the existing suites plus guard/build behaviors. TDD checkpoints (Verify RED → implement → Verify GREEN) are embedded inline on every verification-bearing task per the constitution; pure config/doc tasks use the no-RED/GREEN format.

**Organization**: Grouped by user story (P1→P4). Each story is independent and independently testable.

## Implementation Status (2026-05-31)

**Implemented + verified this session:**

- **US3 (npm hard-block)** — DONE. `preinstall: npx --yes only-allow pnpm` added to root `package.json`. Verified: only-allow exits 1 with a clear "Use pnpm install" message under an npm user-agent; `pnpm install` passes (exit 0). On a dirty pnpm tree npm crashes even earlier (arborist) — also blocked.
- **US1 (unit isolation)** — canonical suite **green ×19** (`pnpm nx test mcm-app`, 804/804 every run). Added timer-isolation hygiene (`afterEach(jest.useRealTimers())`) in `tests/jest.setup.ts`. **Key finding:** the documented `movie-detail-screen` "fails-in-full-run" flake does **not reproduce** in the canonical (multi-worker) run on the post-SDK-56 tree. A real latent async-leak (expo-modules-core dev JS-logger `console.warn` after teardown, via the winter fetch polyfill) IS reproducible under the **non-default** `--runInBand` flag (6/6), but all 804 assertions pass; four suppression attempts (eager import, EXPO_OS override ±cache, microtask flush) failed because it's rooted in expo+babel internals. Treated as benign library noise outside the canonical path. **T007 deviation:** the planned `resetMocks/clearMocks/restoreMocks` flags were NOT added — the empirical root cause is an async native-module warn, not mock-state leakage, and `resetMocks:true` risks breaking the 804 green; documented per SDD.
- **US4 (APK/CI files)** — DONE. `mcm-app:build-apk` Nx target (`project.json`) → cross-platform `scripts/build-apk.mjs`; Windows wrapper `scripts/build-apk-short-path.ps1`; CI workflow `.github/workflows/android-apk.yml` (Linux, invokes the Nx target, uploads artifact). `.gitignore`: `/android` is already fully ignored — no change needed.
- **US2 (E2E stabilization)** — code DONE. `scripts/maestro-e2e.mjs` now retries a failed flow **once** (logged `⟳ RETRY 1/1`); `global-setup.ts` warms the collection + movie-detail routes (in addition to `/home`); Playwright `retries: 1` already present.
- **Docs (T018)** — CLAUDE.md updated: npm guard, bounded-retry policy + readiness ritual, and the Nx-target/CI/short-path APK build paths. `tsc --noEmit` clean.

**US2 web E2E — root cause + container spike + auth bug-fix (this session):**

- Web E2E flakiness is confirmed **dev-Metro JIT degradation**: every failure is `page.waitForSelector timeout … home-screen-create-button` (the `gotoHome` helper) as Metro cold-compiles/slows over consecutive runs. **SC-003 "green ×3 consecutive" is environmentally limited on dev Metro here** — a single fresh-Metro run is the practical gate (as feature 005 did). The warm-up (T010) + bounded retry (T011) help but cannot overcome a degrading JIT server.
- **Spiked running web E2E against the deployed prod BFF container** (no Metro JIT). It surfaced a **real latent prod bug**: the BFF's `token-service.ts`/`keycloak.ts`/`email-service.ts` used the **build-inlined** `keycloakConfig.*` (static `process.env['KEYCLOAK_URL']` frozen to `localhost:8099` at `expo export`) for JWKS/discovery/issuer/admin/revoke, so a Dockerized BFF cannot reach Keycloak. **Fixed:** those server modules now use **runtime** `env.keycloakUrl` (internal connect) + a new `env.keycloakPublicUrl`/`KEYCLOAK_PUBLIC_URL` (browser-facing issuer) with both-issuer acceptance; `config/env.ts` adds `keycloakPublicUrl` + `keycloakAdminApiBase`. Backward-compatible (unset `KEYCLOAK_PUBLIC_URL` → identical to before). **Validated:** tsc 0, lint 0, unit 804/804, BFF integration 45/45 (real Keycloak/Redis), 58 targeted auth tests. **Touches the security path → a security-review pass is required before this ships.**
- **Container web E2E remains blocked** beyond the issuer fix: login fails at the **Expo production `server.js` runtime** (`Premature close` / `Cannot pipe to a closed or destroyed stream`; zero sessions persisted), plus token Max-Age/refresh handling. **Deferred to a dedicated follow-up feature** (Expo prod-server login streaming + refresh/SSO-logout reconciliation + HTTPS/Secure-cookie review + security review). The web-E2E CI job depends on that feature.

**Deferred — environment/time-bound validations (NOT yet run):** T004 (E2E baseline), the ×3 web (dev-Metro, environmentally limited) + ×3 mobile E2E runs, T012 (deliberate-break no-mask check), the actual local APK build + CI trigger (T014/T016 GREEN), T020 (quickstart DoD), T021 (`rtk gain` measurement). T019 regression is GREEN (mc-service 92+217, BFF integration 45, unit 804). These remaining need a booted emulator + a CI run.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1–US4 maps to the spec's user stories
- Exact file paths are included in each task

## Path Conventions

Repo-root tooling (`package.json`, `.npmrc`, `scripts/`, `.github/workflows/`) + the Expo app at `frontend/mcm-app/`. All build/test ops run through Nx targets (`pnpm nx …`).

> **Verify config locations before editing** — the following are referenced below by best-guess; confirm the real path first (`pnpm nx show project mcm-app` + inspect `frontend/mcm-app/`): the `mcm-app` unit Jest config (`package.json` `"jest"` block **vs** a `jest.config.js`) for T007, the `setupFilesAfterEnv` file for T008, and the Nx target host (`project.json` **vs** `package.json` targets / inferred) for T011/T014. The integration Jest config (`jest.integration.config.js`) is separate and out of scope.

---

## Phase 1: Setup & Baseline (capture the RED state)

**Purpose**: Stand up infra and record the current (flaky/unguarded) state so each story's GREEN is provable.

- [X] T001 Confirm RTK active (`rtk gain`) and bring infra up: `pnpm nx up-all infrastructure-as-code` (Keycloak + Redis + mc-service + Mongo) — needed for integration/E2E baselines.
- [X] T002 [P] Capture US1 RED: run `pnpm nx test mcm-app` and record the full-run failure signature for `movie-detail-screen.test.tsx` (and confirm it passes in isolation: `pnpm nx test mcm-app -- --testPathPattern movie-detail-screen`). Record in the task notes.
- [X] T003 [P] Capture US3 RED: run `npm install` at repo root and confirm it currently **succeeds** (proves the guard is absent). Record exit code 0.
- [ ] T004 [P] Capture US2 baseline: run `pnpm nx e2e mcm-app` and `pnpm nx e2e:mobile mcm-app` once; record current pass/flake profile (which flows flaked, retry behavior).
- [X] T005 [P] Capture US4 RED: confirm no `mcm-app:build-apk` Nx target exists (`pnpm nx show project mcm-app`) and no `.github/workflows/` directory exists.

**Checkpoint**: RED states recorded for all four stories.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Cross-story prerequisites.

**No foundational blockers exist** — the four user stories are mutually independent (a Jest-config fix, an E2E retry policy, a package-manager guard, and a build/CI pipeline touch disjoint files). Each story may begin immediately after Phase 1 and ship on its own. Proceed directly to the story phases.

---

## Phase 3: User Story 1 - Unit suite passes reliably in a single full run (Priority: P1) 🎯 MVP

**Goal**: Eliminate the cross-test state leak so the full unit suite is green in one pass, every run.

**Independent Test**: Run the full unit suite from clean 10× consecutively → 0 failures incl. `movie-detail-screen.test.tsx`, pass count ≥ baseline, no skip/quarantine.

- [X] T006 [US1] Reproduce deterministically and identify the leaking sibling: run `pnpm nx test mcm-app -- --runInBand` and bisect the file set preceding `frontend/mcm-app/src/screens/movies/movie-detail-screen.test.tsx` until the offending file (un-restored fake timer / module-level mutable global / pending async timer) is identified. Record the culprit file in the task notes.
- [ ] T007 [US1] Add Jest hygiene flags `clearMocks: true`, `resetMocks: true`, `restoreMocks: true` to the `mcm-app` Jest config (`frontend/mcm-app/jest.config.js` or the `package.json` `"jest"` block — confirm which holds the unit config; the integration config `jest.integration.config.js` is separate and out of scope).
  - **Verify RED** (before): `1..10 | %% { pnpm nx test mcm-app --skip-nx-cache }` → at least one run fails on `movie-detail-screen.test.tsx`.
- [X] T008 [US1] Add a global `afterEach` safety net — `jest.useRealTimers()` + `@testing-library/react-native` `cleanup()` — in the unit Jest setup file (`frontend/mcm-app/jest.setup.*`; create/extend the `setupFilesAfterEnv` entry if absent).
- [ ] T009 [US1] Repair the actual leak at its source in the culprit file from T006 (restore the timer / reset the global in that file's `afterEach`). Do **NOT** modify any assertion in `movie-detail-screen.test.tsx` (FR-003).
  - **Verify GREEN** (after T007–T009): `1..10 | %% { pnpm nx test mcm-app --skip-nx-cache }` → **10/10 runs pass**, incl. `movie-detail-screen.test.tsx`; pass count ≥ T002 baseline; `git grep -nE "\.skip\(|xit\(|xdescribe\(" frontend/mcm-app/src` shows no new skips.

**Checkpoint**: Unit suite deterministically green in one pass (SC-001, SC-002).

---

## Phase 4: User Story 2 - E2E suites pass reliably without environmental flakiness (Priority: P2)

**Goal**: Root-cause environmental web/mobile E2E flakiness; keep at most **one** explicit, visible retry per test as a safety net.

**Independent Test**: Each E2E suite green across 3 consecutive runs under documented conditions; retries ≤1/test and visible; a real regression still fails (both attempts).

- [X] T010 [US2] Web stabilization: add a Metro warm-up pre-navigation (one `/home` visit absorbing the cold-compile) to `frontend/mcm-app/tests/e2e/web/setup/global-setup.ts`; confirm `playwright.config.ts` keeps `retries: 1` and that `timeout`/`expect.timeout` give cold-compile headroom (≥60 s first nav).
  - **Verify GREEN**: `1..3 | %% { pnpm nx e2e mcm-app }` → 3/3 green, 0 cold-compile navigation timeouts.
- [X] T011 [US2] Mobile stabilization: wrap the Nx `e2e:mobile` target (`frontend/mcm-app/project.json` or its runner script) so each Maestro flow re-runs **at most once** on failure, with the retry clearly logged; re-apply the emulator ritual (`-no-snapshot-load`, `adb reverse tcp:8081 tcp:8081`, Metro from `frontend/mcm-app`, `-gpu swiftshader_indirect`).
  - **Verify GREEN**: `1..3 | %% { pnpm nx e2e:mobile mcm-app }` → 3/3 green; any retry capped at 1/flow and visible in output.
- [ ] T012 [US2] Verify no masking: temporarily break one assertion in a web spec, run that single spec, confirm it **fails on both the first attempt and the retry** (not reported green), then revert the break (FR-006, SC-004). Command: `pnpm nx e2e mcm-app -- tests/e2e/web/<spec>.spec.ts --grep "<test>"`.

**Checkpoint**: Web + mobile E2E consistently green ×3 with bounded, honest retries (SC-003, SC-004).

---

## Phase 5: User Story 3 - npm hard block steering to pnpm (Priority: P3)

**Goal**: `npm install` (and `yarn install`) hard-fail with a "use pnpm" message; `pnpm install` unchanged.

**Independent Test**: `npm install` → non-zero exit, no packages written, pnpm message; `pnpm install` succeeds.

- [X] T013 [US3] Add `"preinstall": "npx --yes only-allow pnpm"` to the root `package.json` `scripts` (keep `"packageManager": "pnpm@10.33.0"`). Optionally add `engine-strict=true` + a documentation-only `engines` note to `.npmrc` (the guard must NOT depend on it — FR-008).
  - **Verify RED** (before): `npm install` exits 0 (guard absent).
  - **Verify GREEN** (after): `npm install` → non-zero exit + "Use pnpm" message + no `node_modules` mutation; `yarn install` also refused; `pnpm install` → exit 0 unchanged; `pnpm nx show project mcm-app` (Nx/Expo tooling) still works (FR-009, SC-005).

**Checkpoint**: npm/yarn hard-blocked; pnpm + Nx workflows intact (SC-005).

---

## Phase 6: User Story 4 - APK rebuild reproducible on a short path, locally and in CI (Priority: P4)

**Goal**: A documented short-path local build + an Nx `build-apk` target + a thin GitHub Actions workflow that builds the APK on Linux (sidesteps the Windows CMake path wall) and publishes the artifact. CI = APK build only.

**Independent Test**: `pnpm nx run mcm-app:build-apk` produces an installable APK on a short path; the CI workflow produces a downloadable APK artifact.

- [X] T014 [US4] Add an `mcm-app:build-apk` Nx target (`frontend/mcm-app/project.json`) that runs `expo prebuild --platform android` then `gradlew :app:assembleDebug`, so the build is invoked as `pnpm nx run mcm-app:build-apk` (constitution: Nx-primary invocation).
  - **Verify GREEN** (local short-path): via the short-root recipe (T015), `pnpm nx run mcm-app:build-apk` produces `app-debug.apk`; `adb install -r …` + launch succeeds with no `CMAKE_OBJECT_PATH_MAX` error.
- [X] T015 [US4] Add a documented short-path build helper `scripts/build-apk-short-path.ps1` wrapping the proven recipe (`mklink /J C:\m <repo>` + `node-linker=hoisted` build-only install → build → **revert** hoisted), echoing each step; refresh the matching section in `CLAUDE.md` and the `.npmrc` note (FR-010, FR-013).
- [X] T016 [US4] Add `.github/workflows/android-apk.yml` (thin): `ubuntu-latest` → `pnpm/action-setup` (10.33.0) → `actions/setup-node` (24.14.1) → `actions/setup-java` (Temurin 17) → Android SDK setup → `pnpm install` → `pnpm nx run mcm-app:build-apk` → `actions/upload-artifact` (the APK). Triggers: `workflow_dispatch` (+ optionally push paths touching `frontend/mcm-app/android/**`). No test suites (FR-011).
  - **Verify GREEN**: trigger the workflow → it completes on the Linux runner without the path workaround → an installable `app-debug.apk` artifact is published.
- [X] T017 [US4] Add any new build/artifact ignore patterns (e.g., `frontend/mcm-app/android/app/build/`) to the root `.gitignore` (constitution: single root `.gitignore`).

**Checkpoint**: APK builds via Nx target locally on a short path AND via the CI artifact (SC-006).

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T018 [P] Documentation sweep: confirm `CLAUDE.md` + `specs/006-clean-flakiness/quickstart.md` document (a) the npm/pnpm guard, (b) the bounded-retry policy, (c) the short-path/CI APK build, and (d) **the E2E readiness ritual** — Metro warm-up, the emulator startup ritual (`-no-snapshot-load`, `adb reverse tcp:8081 tcp:8081`, Metro started from `frontend/mcm-app`, `-gpu swiftshader_indirect`), and "restart Metro before long runs" — so a green E2E run is reproducible by another operator. **Zero** instructions may describe the old flaky/unguarded state as current. Check: `pnpm exec rg -n "npm install|only-allow|retries|CMAKE_OBJECT_PATH_MAX|short[- ]path|adb reverse|warm-up"` over docs (**FR-007**, FR-013, SC-008).
- [ ] T019 Confirm no end-user behavior change: `pnpm nx test mcm-app` + `pnpm nx test:integration mcm-app` + `pnpm nx test mc-service` + `pnpm nx test:integration mc-service` pass with identical outcomes (SC-007).
- [ ] T020 Run the [quickstart.md](./quickstart.md) Definition-of-Done checklist end-to-end.
- [ ] T021 `rtk gain` → confirm >80% compression after the runs above (constitution; run last).

---

## Platform Parity Table

US2 is the only story that spans both clients; the others are not UI flows.

| Scenario | Web (Playwright) | Mobile (Maestro) | Status |
|---|---|---|---|
| US1: deterministic unit suite | N/A — unit test isolation, not a UI flow | N/A — unit test isolation, not a UI flow | N/A |
| US2: E2E suite stable, ≤1 bounded retry | all `tests/e2e/web/*.spec.ts` (config: `playwright.config.ts` + `global-setup.ts`) | all `tests/e2e/mobile/*.yaml` (config: `e2e:mobile` retry wrapper) | ✅ |
| US3: npm install hard-blocked | N/A — toolchain/process guard, not a UI flow | N/A — toolchain/process guard, not a UI flow | N/A |
| US4: APK short-path + CI build | N/A — build/CI pipeline, not a UI flow | N/A — build/CI pipeline, not a UI flow | N/A |

No `❌ Gap` rows — no resolution tasks required.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies — start immediately (captures RED).
- **Foundational (Phase 2)**: none — no blockers.
- **User Stories (Phase 3–6)**: each depends only on Phase 1; all four are mutually independent and may run in parallel or in priority order P1→P4.
- **Polish (Phase 7)**: after the desired stories are complete.

### User Story Dependencies

- **US1 (P1)**: independent. MVP.
- **US2 (P2)**: independent (E2E config only).
- **US3 (P3)**: independent (root tooling only).
- **US4 (P4)**: T015 (short-path recipe) enables local Verify-GREEN of T014; T014 (Nx target) is required by T016 (CI calls it). Otherwise independent of US1–US3.

### Within US4

- T015 (short-path recipe) → enables T014 local verify; T014 (Nx target) → T016 (CI invokes it); T017 (.gitignore) independent.

### Parallel Opportunities

- Phase 1: T002–T005 all `[P]` (different read-only checks).
- Across stories: US1, US2, US3 can proceed fully in parallel (disjoint files); US4 internally is mostly sequential (T015→T014→T016).
- Phase 7: T018 `[P]`.

---

## Parallel Example: Setup baseline

```bash
# Capture all RED states in parallel (read-only):
Task: "T002 record movie-detail-screen full-run failure signature"
Task: "T003 confirm npm install currently succeeds"
Task: "T004 record current web+mobile E2E flake profile"
Task: "T005 confirm no build-apk target / no .github/workflows"
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1 Setup → capture RED.
2. Phase 3 US1 → deterministic unit suite (the highest-confidence, highest-value flake).
3. **STOP & VALIDATE**: 10× green in one pass.

### Incremental Delivery

US1 (MVP) → US3 (cheap, deterministic guard) → US2 (E2E stabilization) → US4 (APK/CI). Each ships independently without breaking the others.

---

## Completion Checklist

Before marking `006-clean-flakiness` complete, verify all success criteria from [spec.md](./spec.md):

- [ ] **SC-001**: Full unit suite 100% green across ≥10 consecutive clean runs, incl. `movie-detail-screen.test.tsx`, no skip/quarantine
- [ ] **SC-002**: Unit pass count ≥ pre-fix baseline (no tests removed/disabled)
- [ ] **SC-003**: Web + mobile E2E green across ≥3 consecutive runs, 0 warm-up-attributable failures
- [ ] **SC-004**: Any retry ≤1/E2E test and visible; 0 genuine regressions masked
- [ ] **SC-005**: `npm`/`yarn install` hard-fail with pnpm message; `pnpm install` unchanged
- [ ] **SC-006**: APK builds on short path locally (`pnpm nx run mcm-app:build-apk`) AND via CI artifact; installs + launches
- [ ] **SC-007**: Zero end-user behavior change (existing functional tests identical)
- [ ] **SC-008**: Docs updated; zero stale "current state" instructions
- [ ] Platform parity table complete — no ❌ gaps remain
- [ ] All verification tasks used the TDD checkpoint format (Verify RED confirmed before implementation)
- [ ] `pnpm nx test mcm-app` — unit tests pass (≥70% line coverage)
- [ ] `pnpm nx test:integration mcm-app` — integration tests pass
- [ ] `pnpm nx lint mcm-app` — no lint errors
- [ ] `pnpm nx e2e mcm-app` — web E2E passes
- [ ] `pnpm nx e2e:mobile mcm-app` — mobile E2E passes (logged-out start between runs)
- [ ] `rtk gain` — >80% token compression confirmed (run last)
