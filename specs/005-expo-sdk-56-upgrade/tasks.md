---
description: "Task list for Expo SDK 55 → 56 upgrade"
---

# Tasks: Expo SDK 55 to 56 Upgrade

**Input**: Design documents from `specs/005-expo-sdk-56-upgrade/`
**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [quickstart.md](quickstart.md)

**Tests**: This feature adds NO new feature code, so it creates NO new RED-first tests. The existing suites (unit, integration, web E2E, mobile E2E, mc-service) are the regression safety net; tasks run and gate against them. Per FR-006, any existing test that changes only to reflect equivalent SDK 56 behavior is updated — never weakened or disabled.

**Organization**: Grouped by user story. Note the deliberate ordering: **US2 (documentation-first) governing-doc tasks are in the Foundational phase and BLOCK all code changes** (FR-001 / SC-001).

## Format: `[ID] [P?] [Story?] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1 (no-regression upgrade), US2 (docs-first), US3 (security), US4 (best-practices)
- All paths are repo-relative from `E:\Programming\VSCode\MovieCollectionManager`

---

## Phase 1: Setup — Baseline Capture (Shared Prerequisite)

**Purpose**: Establish the pre-upgrade green baseline + performance baseline on SDK 55 BEFORE anything changes. These timings are the SC-006 reference and the regression oracle. This phase must run on the **current SDK 55 build** (no code changes yet).

- [X] T001 Confirm RTK active for the session: run `rtk gain` and verify it responds (constitution Token Compression). Record starting state. ✅ rtk 0.40.0 (constitution-pinned) at ~/.cargo/bin + active via rtk-claude-code wrapper (observed intercepting shell output). Gain counter starts at 0; >80% measured after test runs.
- [X] T002 Bring up full local infra on current build. ✅ Infra already running & healthy (verified via `docker ps`): mc-db, mcm-mcm-redis-1, mcm-keycloak-db-1, mcm-keycloak-service-1, mcm-keycloak-mailpit-1 (all "healthy"), mc-service (up). NOTE: the Nx `up-all` target is broken on Compose v2 (it emits `docker compose up -d --profile ...`; profile flags must precede `up`) — use `docker compose --profile app --profile keycloak up -d` instead. No action needed since infra was already up.
- [X] T003 [P] Capture baseline unit + integration on SDK 55: `pnpm nx test mcm-app` and `pnpm nx test:integration mcm-app`. ✅ Baseline (real runs): unit **804 passed / 0 failed** (67 suites). BFF integration initially **44 pass / 1 flaky-fail** — root-caused to a faulty tamper technique in the test (NOT a `validateJwt` defect; see investigation note). After the human-approved test fix: **45 passed / 0 failed** (11 suites). GREEN.
- [X] T004 [P] Capture baseline mc-service green: `pnpm nx test mc-service` and `pnpm nx test:integration mc-service`; record pass counts. ✅ Baseline (real run): unit (lib.rs) **99 passed / 0 failed**; integration binaries **118 passed / 0 failed / 21 ignored** (collections 22, health 4, movies 92; ignored = documented full-stack/E2E-verified cases). Fully green.
- [X] T005 Capture web E2E baseline + per-flow timings on SDK 55: `pnpm nx e2e mcm-app`. ✅ **Clean baseline (after fresh-Metro restart + single worker):** killed all stale node, then `pnpm nx e2e mcm-app --skip-nx-cache -- --workers=1` → **92 passed / 0 failed in 2.5m** (exit 0). This is the SC-006 web aggregate baseline. A prior degraded run (87/1/4 @13m, 4 workers, stale 12h+ Metro) confirmed the failures there were `gotoHome` navigation timeouts (Metro degradation), not functional — superseded by this clean run. (History note: even earlier "39 passed" / "44/29/19" figures were unverified and are discarded.) Post-upgrade T026 must keep the web suite within ~10% of 2.5m / 92-green.
- [X] T006 Capture Android E2E baseline + per-flow timings on SDK 55 (emulator booted, `adb reverse tcp:8081 tcp:8081`, Metro started from `frontend/mcm-app`): `pnpm nx e2e:mobile mcm-app`; record **Maestro flow wall-clock times**. ✅ Baseline (real run): **all 20 Maestro flows passed** (auth-guard, collection-browse/create/delete/edit, email-verification, home-screen, login-invalid/keycloak/screen/verified-banner, logout, movie-add/browse/delete/edit, movie-search-filter, registration-full/navigation/validation) in **~2024s (~33.7m)** total wall-clock, exit 0. Emulator: Pixel_7-35, `-no-snapshot-load -gpu swiftshader_indirect`. Suite-total ~33.7m is the SC-006 Android aggregate baseline for T026. (MANUAL_FLOWS session-timeout excluded as designed.)
- [X] T007 Snapshot the pre-upgrade dependency/security baseline: from `frontend/mcm-app` run `npx expo-doctor` and record output, and capture the current dependency-audit state for the FR-010 security comparison. ✅ Baseline (real run): `npx expo-doctor` → **15/19 passed, 4 FAILED** on SDK 55: (1) "custom metro.config.js does not extend expo/metro-config" — FALSE POSITIVE (no metro.config.js in `frontend/mcm-app`; only babel/jest/playwright configs — likely monorepo-root detection; re-check post-upgrade); (2) legacy global CLI installed locally; (3) required peer dependencies not all installed; (4) packages don't match versions required by installed Expo SDK (`npx expo install --check`). FR-010 baseline = ≤4 failures; expect (3)/(4) resolved by `expo install --fix` post-upgrade (T027/T036 must be ≥ this).

> **⚠️ BASELINE INVESTIGATION (T003 pre-existing failure — root cause, NOT a security defect):**
> Test: `token-service.integration.test.ts › rejects a tampered JWT (bad signature) (US1-AC3)`.
> **Root cause = faulty test tampering technique (flaky test), NOT a flaw in `validateJwt`.** The test tampers by flipping the **last** base64url char of the RSA signature: `s.slice(0,-1) + (s.endsWith('A')?'B':'A')`. A 2048-bit (256-byte) RSA signature base64url-encodes to **342 chars whose final char carries only 2 significant bits** (256 mod 3 = 1 leftover byte → last char's low 4 bits are discarded on decode). `'A'(0)→'B'(1)` differs only in those discarded bits, so the **decoded signature buffer is byte-identical** → `createVerify().verify()` correctly returns valid → `validateJwt` resolves → test fails. Empirically confirmed: `decoded buffers EQUAL after flip? true`. The test is **flaky** — it only fails when the signature's last char is `A` (~25% of tokens, since valid terminal chars are A/Q/g/w and only `A→B` is a no-op); Q/g/w→A would change the 2 bits and pass. **Production `validateJwt` is sound** — it verifies signatures correctly; this run happened to draw a token ending in `A`.
> **Implication**: pre-existing test-integrity defect (US1-AC3 not reliably verified), independent of the SDK upgrade. **RESOLVED** (human chose "fix test + harden assertion"): `token-service.integration.test.ts` now tampers at the byte level (decode sig → `buf[0]^=0xff` → re-encode) and asserts `{ code: UNAUTHORIZED, message: /signature/i }`. Re-run → **45/45 green**, deterministic every run. This is a test-only correctness fix (no application/`validateJwt` change); it is the sole non-doc change committed before T013 and is justified under FR-006 (fix tests to be correct, never weaken them).

**Checkpoint**: SDK 55 baselines — unit/integration GREEN (mcm-app unit 804, BFF integration 45; mc-service 99 unit + 118 integration). Pre-existing flaky tampered-JWT test fixed (committed). ✅ ALL SDK 55 baselines GREEN before T013: mcm-app unit 804/0, BFF integration 45/0, mc-service 99 unit + 118 integration, web E2E **92/0 @2.5m**, Android E2E **20/20 flows @~33.7m**. expo-doctor (T007) = 15/19 (4 known failures, FR-010 baseline). The flaky tampered-JWT test was fixed pre-baseline. Ready for the dependency upgrade.

---

## Phase 2: Foundational — Documentation-First (BLOCKING, US2 governing docs)

**Purpose**: FR-001 / SC-001 mandate that the governing documents are amended and committed **before any application code change**, and the SDK stack-line change requires a constitution amendment with human approval (FR-014, see Complexity Tracking in [plan.md](plan.md)). **No task in Phase 3+ may begin until this phase is committed and the amendment is approved.**

- [X] T008 [US2] Amend `.specify/memory/constitution.md` Frontend App Technology Stack: change `Expo SDK 55` → `Expo SDK 56`, replace the `pnpm create expo-app --template default@sdk-55` command with the SDK 56 equivalent, and update any React Native / React / Node version statements that name the old baseline (line ~327; verify lines 323, 332 for Node). Add a new VERSION HISTORY entry (MINOR bump) with documented rationale referencing this feature. ✅ Done: SDK line updated to 56 (+ RN 0.85 / React 19.2 note); v1.4.0 history entry added; Node line 323/332 confirmed unaffected (Node 24.14.1 retained pending R4 verification).
  - **Scenarios**: US2-AS1
- [X] T009 [US2] Update the constitution footer `**Version**` / `**Last Amended**` line to the new version + 2026-05-30, consistent with the new history entry from T008. ✅ Done: footer now `**Version**: 1.4.0 | ... | **Last Amended**: 2026-05-30`.
  - **Scenarios**: US2-AS1
- [X] T010 [US2] 🚦 **HUMAN APPROVAL GATE (FR-014)**: Present the constitution amendment (T008–T009) for human approval. Do NOT proceed to any code change until approved. Record approval. ✅ APPROVED by Steven Watson 2026-05-30 via /speckit-implement gate (chose "Approve, commit, run baselines").
  - **Scenarios**: US2-AS1
- [X] T011 [P] [US2] Update `CLAUDE.md` version references to the new baseline (Expo SDK 56, React Native 0.85; React 19.2 already current) anywhere the old versions are stated in the project overview/commands; the SPECKIT plan pointer already targets this feature's plan. ✅ Done (no-op): grep confirmed CLAUDE.md states no Expo/RN/React versions; SPECKIT plan pointer already updated to this feature's plan during planning.
  - **Scenarios**: US2-AS1
- [X] T012 [US2] Commit the governing-document changes (T008, T009, T011) as the FIRST commit(s) on the branch so the documentation-first ordering is visible in git history (SC-001). No `package.json`/source file may be in this commit. ✅ Done: commit 419dd35 (constitution + tasks only, zero source files) — lands before any code change.
  - **Scenarios**: US2-AS1

**Checkpoint**: Governing docs amended + approved + committed before any code change. SC-001 satisfied. Code upgrade (US1) may now begin.

---

## Phase 3: User Story 1 — Application runs on the upgraded framework with no regressions (Priority: P1) 🎯 MVP

**Goal**: Move Expo 55→56 and RN 0.83.6→0.85 (React stays 19.2.0) and bring the entire existing test suite green on both web and Android with zero functional regressions.

**Independent Test**: Run the complete existing automated suite (unit, integration, web E2E, mobile E2E) on the upgraded build; every test passes and every critical flow behaves identically to the Phase 1 baseline.

### Dependency upgrade

- [ ] T013 [US1] In `frontend/mcm-app`, move Expo to SDK 56: `npx expo install expo@latest`, then align all peers: `npx expo install --fix`. If an irreconcilable conflict that would lose functionality/performance appears → **HALT and escalate to human (FR-013)**; do not force-resolve.
  - **Node engine check (plan R4)**: ✅ RN 0.85.3 requires `node ^20.19.4 || ^22.13.0 || ^24.3.0 || >=25`. Node **24.14.1** satisfies `^24.3.0` — no Node bump, no second amendment. expo 56.0.8 declares no `engines` constraint. (Note: the `ERR_PNPM_EPERM`/detox rename failure during the first `--fix` was a Windows file-lock from a running Metro, NOT a dependency conflict — cleared by killing node + re-running; not an FR-013 halt. TypeScript 5.9→6.0.3 was a recommended (non-peer) bump; human-approved to take it.)
- [X] T014 [US1] Confirm resulting pins in `frontend/mcm-app/package.json`: Expo 56.x, react-native 0.85.x, react 19.2.0 retained, react-dom override 19.2.0 (app + root `package.json`). Adjust the root `package.json` pnpm `overrides` only if `expo install` requires it. ✅ Pins: expo ^56.0.8, react-native 0.85.3, **react 19.2.3** (expo --fix chose the 19.2.x patch; within spec "React 19.2"), expo-* all ~56.x, @react-native-async-storage/async-storage ^2.2.0 (was ^3.1.0 — SDK 56 expects 2.2.0), RN-web 0.21 retained. devDeps: babel-preset-expo 56.0.14, jest-expo 56.0.4, eslint-config-expo 56.0.4, **typescript ~6.0.3** (human-approved scope bump). **react-dom override aligned 19.2.0 → 19.2.3** in BOTH app + root `package.json` to match react (they must match).
- [X] T015 [US1] Regenerate the workspace lockfile: `pnpm install` from repo root; confirm no peer-dependency errors. ✅ `pnpm install` exit 0; lockfile regenerated. Peer-dep WARNINGS remain but are pre-existing/non-fatal (detox↔expect, @monodon/rust↔nx) — unrelated to this upgrade; no errors.

### Native Android reconciliation (RN 0.85)

- [ ] T016 [US1] Regenerate the committed Android project for RN 0.85: from `frontend/mcm-app` run `npx expo prebuild --platform android --clean`, then review the `frontend/mcm-app/android/` diff for any intentional local customizations before staging. (No `ios/` — not a target.)
- [ ] T017 [US1] Clear Android build caches: from `frontend/mcm-app/android` run `./gradlew clean`.

### Type-check, build, fix regressions

- [ ] T018 [US1] Type-check: from `frontend/mcm-app` run `pnpm exec tsc --noEmit`. Fix any SDK 56 type breakage in app source (not by loosening types). 
  - **Verify GREEN**: `pnpm exec tsc --noEmit` → 0 errors
- [ ] T019 [US1] Lint: `pnpm nx lint mcm-app` (ensure `eslint-config-expo` bumped to the SDK 56 line by T013).
  - **Verify GREEN**: `pnpm nx lint mcm-app` → no errors
- [X] T020 [US1] Build the BFF image to confirm server bundle compiles under SDK 56: `pnpm nx build mcm-app`. ✅ Docker image `mcm-bff:latest` built successfully under SDK 56 / RN 0.85 (server bundle exports + image packs cleanly in the production Docker context). Exit 0.
  - **Verify GREEN**: build succeeds ✅

### Run existing suites green (FR-005, SC-004) — tiered protocol

- [X] T021 [US1] Unit suite green on SDK 56: `pnpm nx test mcm-app` (≥70% line coverage retained). Investigate any failure; fix genuine regressions in app code; update a test ONLY if it reflects equivalent SDK 56 behavior (FR-006). ✅ **804 passed / 0 failed (67 suites)** — matches the pre-upgrade baseline exactly. One transient regression during iteration: the T019 lint fix deferred `home-screen` `setIsFr009Checked` to a microtask, breaking 13 synchronous-render assertions; reverted to synchronous setState + scoped eslint-disable (committed 9c… home-screen fix). Coverage gate (≥70%) passed.
  - **Scenarios**: US1-AS3
  - **Verify GREEN**: `pnpm nx test mcm-app` → all pass, coverage ≥70% ✅
- [X] T022 [US1] BFF integration suite green against REAL Keycloak/Redis/mc-service: `pnpm nx test:integration mcm-app`. Do NOT introduce any mock into `tests/integration/` (constitution Test Type Integrity). ✅ **45 passed / 0 failed (11 suites)** — matches baseline. (Prerequisite learned: the HTTP-level suites require a running BFF on :8081 — `CI=1 pnpm exec expo start --web --port 8081`; an initial run with the BFF down produced 27 AggregateError failures that were purely "server not running", not regressions. No mocks added.)
  - **Scenarios**: US1-AS3
  - **Verify GREEN**: `pnpm nx test:integration mcm-app` → all pass ✅
- [X] T023 [US1] Web E2E green on SDK 56: `pnpm nx e2e mcm-app`. Confirm login, browse collections, browse/search movies, add/edit/delete movie, logout behave identically to baseline. ✅ **92/92 pass, 0 hard failures** (verified across runs: 90 passed + 2 flaky-but-passed on one run; clean PASS(92)/FAIL(0) on a fresh-Metro single-worker run). All critical flows behave identically to baseline. Timing: see T026.
  - **Scenarios**: US1-AS1, US1-AS3
  - **Verify GREEN**: `pnpm nx e2e mcm-app` → all pass ✅
- [BLOCKED] T024 [US1] Android E2E green on SDK 56 (emulator booted, `adb reverse tcp:8081 tcp:8081`, Metro from `frontend/mcm-app`, app reinstalled): `pnpm nx e2e:mobile mcm-app`. Confirm the same critical flows. ⚠️ **BLOCKED on a native APK build issue — NOT a JS/app regression.**
  - **First run (stale APK)**: all 20 flows failed at `login-screen visible`; root-caused via screenshot+logcat to a RedBox `ReferenceError: Property 'MessageQueue' doesn't exist` at RN's `setUpBatchedBridge`. Cause: the **installed APK is the old SDK-55 native binary** (`lastUpdateTime 2026-05-24`) — `prebuild --clean` + `gradlew clean` (T016/T017) regenerated/cleaned native source but **no APK was rebuilt/reinstalled**, so RN 0.85's bridgeless JS bundle ran against the RN 0.83 native bridge → MessageQueue mismatch. (Ruled out: Metro cache — persisted after `--reset-cache`; `@expo/dom-webview@55` stale dep — override didn't change it and was reverted.) **GAP IN PLAN**: T016/T017 omitted an APK build+install step before T024.
  - **APK rebuild attempt**: `./gradlew :app:assembleDebug`, `-PreactNativeArchitectures=x86_64`, and `npx expo run:android` all **FAIL** on `react-native-screens@4.25.2` + `react-native-worklets@0.9.1` CMake with `ninja: error: manifest 'build.ninja' still dirty after 100 tries` — survives `.cxx`/`build` deep-clean, no clock skew. **ROOT CAUSE CONFIRMED (web-researched, authoritative): CMake object-path exceeds `CMAKE_OBJECT_PATH_MAX` (250 chars)** — a known Windows + deep-pnpm-monorepo-path issue (expo#22444, expo#25771, reanimated#5339, vision-camera#1941). Measured: a representative object path is already ~233 chars with placeholders (the hashed pnpm android dir alone is 123 chars), tipping past 250 for these two C++ modules. `react-native-worklets` is newly pulled by SDK 56 (reanimated 4 dep), so the long-path build is new to this upgrade. **Environmental, not a code defect** — documented fixes are: build from a much shorter root path, or build via Android Studio / CI (non-Windows or short-path). **Escalated to human.** Web E2E (T023) 92/92 proves the JS upgrade is sound; only the Android *native device build* is blocked. **UPDATE**: confirmed the exact CMake message — "object file directory has 221 characters; max full path 250 (CMAKE_OBJECT_PATH_MAX)". Windows `LongPathsEnabled` is ALREADY `=1` (and `git core.longpaths` now set) — neither helps, because the 250 cap is CMake-internal, not an OS limit. The fixed repo root `E:\Programming\VSCode\MovieCollectionManager` (38 chars) + pnpm hashed module `.cxx` dirs (193+ chars) overflow. Viable fixes (all environmental, none a code change): (a) build from a very short root (e.g. `C:\m`); (b) point CMake `.cxx`/object dir to a short path; (c) build in CI / non-Windows. **OPTION (b) ATTEMPTED & REJECTED**: installed `expo-build-properties` and set pnpm `virtual-store-dir-max-length=40` (shortens `node_modules/.pnpm/<pkg>@<ver>_<hash>` dir names in place). RESULT: object DIR dropped 221→201, but **CMake replicates the FULL absolute source path under the object dir** (`worklets.dir/E_/Programming/.../node_modules/.pnpm/.../react-native-worklets/Common/cpp/worklets/RunLoop/AsyncQueueImpl.cpp.o`) → worst object path measured **381 chars**, still >250; build still failed. Worse, the shortened store names **broke jest/Metro module resolution (all 67 unit suites failed to load)** — same class of breakage the pre-existing `.npmrc` note warned about for relocating the store. **REVERTED** (`.npmrc` restored, node_modules reinstalled, unit suite back to 804/804). Because the repo-root prefix appears ~twice in the object path, only a SHORT BUILD ROOT (option a) or CI (option c) can clear 250. `expo-build-properties` (added during the option-b attempt) was **removed** from package.json + app.json plugins and node_modules reinstalled clean (store names back to default, `.npmrc` has no active store setting, unit suite 804/804). **Net working-tree state for T024 = unchanged from before the option-b attempt.** Awaiting human choice between (a) short-root build and (c) CI/non-Windows.
  - **Scenarios**: US1-AS2, US1-AS3
  - **Verify GREEN**: `pnpm nx e2e:mobile mcm-app` → all pass (PENDING APK rebuild)
- [X] T025 [P] [US1] Confirm backend unaffected (interop): `pnpm nx test mc-service` and `pnpm nx test:integration mc-service` still pass against the upgraded client's contract. ✅ **99 unit + 118 integration pass / 0 failed** — identical to baseline. Backend Rust service is untouched by the client SDK upgrade; the BFF→mc-service JWT/HTTP contract still holds (verified live in T022).
  - **Scenarios**: US1-AS3
  - **Verify GREEN**: both mc-service suites pass ✅
- [ ] T026 [US1] Performance gate (SC-006 / FR-007): re-capture web + Android per-flow timings on the upgraded build using the **same instrument as T005/T006** — Playwright per-test duration (from the HTML/JSON reporter) for web flows, and Maestro flow wall-clock time for Android flows. Compare each flow to its recorded baseline; assert no critical flow regresses > 10%. Remediate any regression before proceeding.

**Checkpoint**: App fully upgraded to SDK 56 / RN 0.85, all existing suites green on web + Android + backend, 0 functional regressions, ≤10% perf delta. This is the MVP.

---

## Phase 4: User Story 4 — Code aligned with new framework standards & best practices (Priority: P3)

**Goal**: Apply SDK 56 deprecation/removal fixes and behavior-neutral housekeeping so the codebase matches the new baseline's conventions (FR-008), without changing functionality.

**Independent Test**: Review code against SDK 56 release notes; deprecated/removed usages are gone and the suite still passes.

- [ ] T027 [US4] Run `npx expo-doctor` from `frontend/mcm-app`; resolve every reported issue (config, version mismatches, deprecated settings).
  - **Scenarios**: US4-AS1
  - **Verify GREEN**: `npx expo-doctor` → no issues
- [ ] T028 [P] [US4] Housekeeping — delete `frontend/mcm-app/babel.config.js` (contains only `babel-preset-expo`, auto-applied by SDK 56). Re-run `pnpm nx test mcm-app` to confirm the preset still applies.
  - **Scenarios**: US4-AS2
- [ ] T029 [P] [US4] Housekeeping — remove now-implicit deps from `frontend/mcm-app/package.json` ONLY if verified implicit/unused (`@babel/core`, `babel-preset-expo`). Keep `expo-constants` (direct runtime dependency). Re-run `pnpm install`.
  - **Scenarios**: US4-AS2
- [ ] T030 [P] [US4] Confirm `frontend/mcm-app/app.json` has no stale `sdkVersion`/`newArchEnabled` (none currently) and `eas.json` CLI version range supports SDK 56 builds; adjust `eas.json` if required.
  - **Scenarios**: US4-AS1
- [ ] T031 [US4] Zero-risk confirmation codemod (expected no-op — no `@react-navigation` imports): from `frontend/mcm-app` run `npx expo-codemod sdk-56-expo-router-react-navigation-replace src`; confirm it produces no changes. If it unexpectedly changes files, review against [research.md](research.md) R2.
  - **Scenarios**: US4-AS1
- [ ] T032 [US4] Check `frontend/mcm-app/patches/` and any `expo.install.exclude` in `package.json` for stale workarounds no longer needed after SDK 56; remove if obsolete (none expected). 
  - **Scenarios**: US4-AS1
- [ ] T033 [US4] Re-run the affected suites after housekeeping: `pnpm nx lint mcm-app`, `pnpm nx test mcm-app`, `pnpm exec tsc --noEmit` (in `frontend/mcm-app`).
  - **Scenarios**: US4-AS2
  - **Verify GREEN**: lint clean, unit pass, 0 type errors

**Checkpoint**: Codebase aligned with SDK 56 best practices; no deprecations remain; suite still green.

---

## Phase 5: User Story 3 — Security posture verified no weaker than before (Priority: P2)

**Goal**: After the app is functionally upgraded and stable, prove security is ≥ the pre-upgrade baseline (FR-009, FR-010).

**Independent Test**: Run the security review; all High/Critical resolved, Medium/Low documented; full suite green after remediation.

- [ ] T034 [US3] Run the project security review over the branch (`/security-review`). Categorize findings by severity.
  - **Scenarios**: US3-AS1
- [ ] T035 [US3] Resolve ALL High/Critical findings (FR-009). Triage Medium/Low: resolve or explicitly accept with documented rationale recorded in this tasks file or a linked note (SC-007).
  - **Scenarios**: US3-AS2
- [ ] T036 [US3] Dependency-vulnerability comparison vs T007 baseline: re-run `npx expo-doctor` + dependency audit on the upgraded build; confirm no new unresolved vulnerabilities (FR-010).
  - **Scenarios**: US3-AS3
- [ ] T037 [US3] Confirm security invariants preserved (compare to baseline behavior): Authorization-Code+PKCE via BFF, HttpOnly/SameSite=Strict cookie, opaque session ID only client-side, logout terminates BFF + Keycloak SSO session, refresh-token rotation, JWT validation on mc-service. Verified via the auth/session E2E + integration suites.
  - **Scenarios**: US3-AS3
- [ ] T038 [US3] Re-run the FULL suite after any security remediation (FR-009): `pnpm nx test mcm-app`, `pnpm nx test:integration mcm-app`, `pnpm nx e2e mcm-app`, `pnpm nx e2e:mobile mcm-app`, `pnpm nx test mc-service`, `pnpm nx test:integration mc-service`.
  - **Scenarios**: US3-AS2
  - **Verify GREEN**: all suites pass

**Checkpoint**: 0 unresolved High/Critical; Medium/Low documented; posture ≥ baseline; suite green post-remediation.

---

## Phase 6: Polish & Cross-Cutting — Remaining Documentation + Final Validation

**Purpose**: Complete the documentation sweep (FR-011, the non-governing docs deferred from US2) and run final validation.

- [ ] T039 [P] [US2] Sweep all remaining docs for stale version references: `pnpm exec rg -n "SDK 55|sdk-55|0\.83|react-native.*0\.83" --glob "**/*.md"`. Update `README.md`, `docs/**`, and any historical `specs/**` statements asserting SDK 55 / RN 0.83.x as the *current* baseline. Leave purely historical records (e.g., `specs/001-user-login/tasks.md` T-176, the PRD) as-is where they describe past state.
  - **Scenarios**: US2-AS2, US2-AS3
- [ ] T040 [US2] Verify zero stale "current baseline" references remain (SC-002, SC-003): re-run the sweep from T039 and confirm only intentional historical mentions remain.
  - **Scenarios**: US2-AS2, US2-AS3
- [ ] T041 Final validation checklist (CLAUDE.md): run the full suite once more end-to-end and confirm `rtk gain` > 80% (constitution + SC measurement): `pnpm nx test mc-service`, `pnpm nx test:integration mc-service`, `pnpm nx lint mcm-app`, `pnpm nx test mcm-app`, `pnpm nx test:integration mcm-app`, `pnpm nx e2e mcm-app`, `pnpm nx e2e:mobile mcm-app`, then `rtk gain`.
- [ ] T042 Confirm SC-008 (no new functionality): review the branch diff to verify no new end-user feature, screen, route, or endpoint was introduced — only version bumps, config, deprecation fixes, and docs.

---

## Platform Parity Table

This feature adds no new E2E scenarios; it re-runs the existing suites on the upgraded baseline. Parity is "scenario passes on SDK 56" per platform.

| Scenario | Web (Playwright) | Mobile (Maestro) | Notes |
|----------|------------------|------------------|-------|
| Login (critical flow) | ✅ re-validated (T023) | ✅ re-validated (T024) | |
| Logout | ✅ re-validated (T023) | ✅ re-validated (T024) | |
| Browse collections | ✅ re-validated (T023) | ✅ re-validated (T024) | |
| Manage collections (create/edit/delete) | ✅ re-validated (T023) | ✅ re-validated (T024) | |
| Browse / search / filter movies | ✅ re-validated (T023) | ✅ re-validated (T024) | |
| Manage movies (add/edit/delete) | ✅ re-validated (T023) | ✅ re-validated (T024) | |
| Default collection routing | ✅ re-validated (T023) | ⚠️ N/A | Web routing behavior only (per CLAUDE.md test scope 002-US3) |
| Column visibility toggle | ✅ re-validated (T023) | ⚠️ N/A | Native layout has no column toggle (per CLAUDE.md test scope 002-US4) |
| Session timeout (idle + absolute) | ✅ re-validated (T023) | N/A — manual flow | Mobile session-timeout flows are MANUAL_FLOWS requiring the special Metro env override; excluded from the standard `e2e:mobile` run. Run `pnpm nx e2e:mobile:session-timeout mcm-app` only if session/timeout code is touched (untouched by this upgrade). |
| Performance per-flow (≤10% regression) | ✅ measured (T026) | ✅ measured (T026) | SC-006 gate; Playwright durations (web) / Maestro wall-clock (mobile) |

---

## Dependencies & Execution Order

- **Phase 1 (Setup/baseline)** — must run on the SDK 55 build, before any change. T003/T004 parallel; T005/T006 sequential (shared emulator/host resources for mobile).
- **Phase 2 (Foundational, docs-first)** — BLOCKS everything in Phase 3+. T008→T009→T010 (approval gate)→T012. T011 parallel with T008–T009 but must be in the T012 commit.
- **Phase 3 (US1)** — depends on Phase 2 commit + approval. Strict internal order: T013→T014→T015→T016→T017→T018→T019→T020→T021→T022→T023→T024; T025 parallel with T021–T024; T026 last (needs upgraded build).
- **Phase 4 (US4)** — depends on US1 green (T026). T028/T029/T030 parallel; T027/T031/T032 then T033.
- **Phase 5 (US3)** — depends on US1 (and ideally US4) complete and green. T034→T035→T036/T037→T038.
- **Phase 6 (Polish)** — last. T039→T040; T041→T042 final.

### Story dependency rationale

US2-governing-docs (Phase 2) is a hard prerequisite (FR-001). US1 is the functional core. US4 (best-practices) and US3 (security) both build on a working upgraded app (US1). US2-remaining-docs trails in Polish because FR-001 only requires *governing* docs first.

## Parallel Execution Examples

- Phase 1: run T003 and T004 together (frontend vs backend test runs, different projects).
- Phase 2: draft T011 (CLAUDE.md) while editing T008–T009 (constitution); commit together at T012.
- Phase 4: T028, T029, T030 touch different files (babel.config.js, package.json, app.json/eas.json) — parallelizable, then converge at T033.

## Implementation Strategy

**MVP = Phases 1–3** (baseline + docs-first + functional upgrade green on web/Android/backend with ≤10% perf delta). That alone delivers the PRD's core: framework moved forward, everything still works, governed by correct docs. Phases 4 (best-practices polish) and 5 (security verification) harden and finalize; Phase 6 completes the doc sweep and final validation. Deliver incrementally; halt-and-escalate on any irreconcilable dependency conflict (FR-013) or unapproved constitution amendment (FR-014).

**Total tasks**: 42.

---

## Completion Checklist

Before marking `005-expo-sdk-56-upgrade` complete, verify all success criteria from [spec.md](spec.md):

- [ ] **SC-001**: Governing docs updated to new versions and committed BEFORE the first application code commit (visible in git history)
- [ ] **SC-002**: Zero documentation references to Expo SDK 55 as the current baseline; all framework refs state SDK 56
- [ ] **SC-003**: Documentation shows React Native 0.85 / React 19.2 as current; zero stale RN 0.83.x baseline refs
- [ ] **SC-004**: 100% of existing tests pass (unit, integration, web E2E, mobile E2E, mc-service)
- [ ] **SC-005**: 0 functional regressions on web + Android critical flows
- [ ] **SC-006**: No critical user flow regresses > 10% vs the pre-upgrade baseline
- [ ] **SC-007**: 0 unresolved High/Critical security findings; Medium/Low documented; suite green post-remediation
- [ ] **SC-008**: 0 new end-user features introduced
- [ ] Platform parity table complete — no ❌ gaps remain
- [ ] Constitution amendment human-approved (FR-014) before any code change
- [ ] `pnpm nx test mcm-app` — unit tests pass (≥70% line coverage)
- [ ] `pnpm nx test:integration mcm-app` — integration tests pass
- [ ] `pnpm nx lint mcm-app` — no lint errors
- [ ] `pnpm nx e2e mcm-app` — web E2E passes
- [ ] `pnpm nx e2e:mobile mcm-app` — mobile E2E passes (mobile flows require a logged-out start between runs)
- [ ] `pnpm nx test mc-service` / `pnpm nx test:integration mc-service` — backend unaffected
- [ ] `rtk gain` — >80% token compression confirmed (run last; measures the runs above)
