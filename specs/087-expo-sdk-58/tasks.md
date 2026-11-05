# Tasks: Move the App to Expo SDK 58

**Input**: [spec.md](./spec.md), [plan.md](./plan.md), [research.md](./research.md), [data-model.md](./data-model.md),
[contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: Required. The constitution mandates TDD, so test tasks state a Verify RED and their paired implementation
tasks a Verify GREEN. A step marked **Quote** must put its result in the [Evidence](#evidence) section before it is ticked.

**Organization**: Phases follow the three pull requests, because each PR must land and revert alone (FR-025). The upgrade's
shared work sits in Phase 5, not at the front as the template suggests, because it must follow PR A and PR B.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: The user story served. T012 to T015 are [US2] but ship in PR A, per the plan
- **Test tasks** name the acceptance scenarios or requirements they cover, and a Verify RED

## Working rules

- Work in `/home/coder/worktrees/087`, never in `/workspaces/mcm`. A worktree needs its own
  `CI=true pnpm install --frozen-lockfile` before any `pnpm nx` target. Push before anything risky.
- Each PR's head must be a real branch: `git push origin HEAD:<branch>`, then open it with the `git credential fill` token.
- Jest here needs `--watchman=false`, or it can exit without running anything. A run reporting 0 tests is not a pass.
- `node --test` flags go **before** the path, or the filter is silently ignored and everything runs.
- If a nx result looks stale, re-run with `--skip-nx-cache` before diagnosing it.
- A guard that fails because this feature changed what it protects is updated at the cause, never deleted.
- **Where evidence goes**: a result known before a PR merges goes on that PR's branch. A later one goes on the next PR's branch: T017's on PR B. After PR C merges, a final docs-only PR records T059 to T061.

---

## Phase 1: Setup

**Purpose**: A worktree that can run every tier

- [ ] T001 Install dependencies in `/home/coder/worktrees/087` with `CI=true pnpm install --frozen-lockfile`, then confirm `pnpm nx test mcm-app -- --watchman=false tests/unit/bff-server-trust-proxy.test.ts` reports 4 passed on the current stub, as the starting control
- [ ] T002 Run `pnpm nx bundle-budget mcm-app` and `node --test scripts/__tests__/tamagui-version-lockstep.guard.test.mjs`. In the [Evidence](#evidence) section, record the SDK 57 entry-chunk bytes and the `htmlRoutes`, `notFoundRoutes` and `apiRoutes` counts from `frontend/mcm-app/dist/server/_expo/routes.json` as the pre-change figures

**Checkpoint**: The instruments work before anything changes.

---

## Phase 2: User Story 1 - Identity round trips through the new adapter (PR A, SDK 57)

**Goal**: The supported adapter replaces the outdated one, with the public scheme preserved, while still on SDK 57.

**Independent Test**: Real `server.js` with the real adapter returns the URLs in [contracts/hosting.md](./contracts/hosting.md), and production backup consent is not refused.

- [ ] T003 [US1] Update `scripts/__tests__/prune-bff-runtime-modules.test.mjs` so its fixtures and the root assertion name `expo-server` rather than `@expo/server`, keeping the test that `undici` stays reachable from `openai` alone (FR-001, FR-004)
  - **Verify RED**: `node --test scripts/__tests__/prune-bff-runtime-modules.test.mjs`
  - **Expected RED**: fails on the `expo-server` root, because `STATIC_ROOTS` still names `@expo/server`
- [ ] T004 [US1] Set `STATIC_ROOTS` to `['express', 'expo-server']` in `scripts/prune-bff-runtime-modules.mjs` and update its header comment
  - **Verify GREEN**: same command as T003; 0 failures
- [ ] T005 [US1] In `frontend/mcm-app/package.json`, replace `@expo/server` with a direct `expo-server` dependency at the version `expo-router` resolves (^57.0.3), and refresh `pnpm-lock.yaml` with a minimal install. Confirm the lock diff touches only those packages
- [ ] T006 [US1] Create the fixture in `frontend/mcm-app/tests/unit/fixtures/real-adapter-build/`: `_expo/routes.json` with `htmlRoutes: []`, `notFoundRoutes: []` and one API route, plus a function returning `Response.json({ url: request.url })`. Follow the manifest shape in `expo-server`'s `build/cjs/manifest.d.ts`
- [ ] T007 [US1] In `frontend/mcm-app/server.js`, change the require to `expo-server/adapter/express` and pass `{ build: DIST_SERVER }`, dropping `mode`, **without** the scheme fix yet. Rewrite `frontend/mcm-app/tests/unit/bff-server-trust-proxy.test.ts` to boot real `server.js` against the T006 fixture with no stub, asserting all four rows of [contracts/hosting.md](./contracts/hosting.md) on the URL the route received (US1 scenarios 1, 2, 3, 4; FR-002, FR-003)
  - **Verify RED**: `pnpm nx test mcm-app -- --watchman=false tests/unit/bff-server-trust-proxy.test.ts`
  - **Expected RED**: the `https` rows fail with `Expected: "https://mcm.example.test/..."`, `Received: "http://mcm.example.test/..."`. **This is the item #843 failure, shown through the real adapter**
- [ ] T008 [US1] Add the wrapper from research R1 to the catch-all in `frontend/mcm-app/server.js`, and rewrite the comment block at `server.js:35-43` to explain why the absolute URL is needed
  - **Verify GREEN**: same command as T007; 4 passed. **Quote** the RED and GREEN lines
- [ ] T009 [US1] Update `frontend/mcm-app/tests/unit/fixtures/expo-adapter-stub.cjs` to the new adapter id and remove its `X-Test-Origin` echo. Update `frontend/mcm-app/tests/unit/bff-server-adapter.test.ts` for the absolute URL its handler now receives, keeping every existing behaviour pinned (FR-001; US1 scenario 4)
  - **Verify RED**: `pnpm nx test mcm-app -- --watchman=false tests/unit/bff-server-adapter.test.ts`, before editing either file
  - **Expected RED**: fails, because `server.js` now requires the new adapter and the stub still replaces the old id
  - **Verify GREEN**: same command; 0 failures, with the same test count as before
- [ ] T010 [P] [US1] Update the text that names the old adapter (FR-026): `frontend/mcm-app/README.md:103,158`, `frontend/mcm-app/Dockerfile:112`, `docs/runbooks/e2e-testing.md:109,113,248`, `docs/runbooks/devcontainer-sandbox-lifecycle.md:440`, `scripts/e2e-turn-tally.sh:238`, `frontend/mcm-app/tests/e2e/web/fixtures/client-evidence.ts:8`. Keep the historical lesson at `e2e-testing.md:248`, stating which adapter it was measured on
- [ ] T011 [US1] Confirm the image contains the adapter (FR-001, FR-004): `pnpm nx docker-build mcm-app` passes with `--check-bundle` clean, and `grep -rn '@expo/server/adapter\|"@expo/server"' frontend/mcm-app/server.js frontend/mcm-app/package.json scripts/prune-bff-runtime-modules.mjs frontend/mcm-app/tests/unit` has no matches
**Checkpoint**: The hosting code is ready. The healthcheck tasks below ship in the same PR, and the production check follows.

---

## Phase 3: User Story 2, healthcheck part (PR A, SDK 57)

**Goal**: The container reports unhealthy when pages fail while API routes answer. It changes runtime behaviour, so it ships in PR A.

**Independent Test**: A `dist` copy with `htmlRoutes` emptied turns the real container unhealthy.

- [ ] T012 [US2] Create `scripts/__tests__/bff-healthcheck-pages.guard.test.mjs`, parsing `infrastructure-as-code/docker/bff/compose.yaml` and `compose.prod.yaml`, requiring a page path and a `/bff-api/` path in every BFF service's healthcheck, failing if it finds no such services, and proving a synthetic API-only compose document fails (US2 scenarios 4, 6; FR-010)
  - **Verify RED**: `node --test scripts/__tests__/bff-healthcheck-pages.guard.test.mjs`
  - **Expected RED**: 3 services named, each lacking a page path
- [ ] T013 [US2] Set the healthcheck from research R4 on all three sites in `infrastructure-as-code/docker/bff/compose.yaml` (lines 37, 76) and `compose.prod.yaml` (line 106)
  - **Verify GREEN**: same command as T012; 0 failures
- [ ] T014 [US2] Update any healthcheck text in `frontend/mcm-app/README.md` and `docs/runbooks/` to say the probe covers pages and API routes (FR-026)
- [ ] T015 [US2] Prove the healthcheck can fail (FR-005, SC-005 defect 4): run the real image on a `dist` copy with `htmlRoutes` emptied, using `docker create`, `docker cp` and `docker start` because bind mounts can arrive empty in this sandbox. Expect `/login` 404, API 200, and `docker inspect` reporting `unhealthy`. **Quote** it
- [ ] T016 [US1] Open PR A from `087-expo-sdk-58` with this feature's docs and rollback steps (FR-025). Before pushing, run `pnpm nx preflight infrastructure-as-code`. In CI, confirm web E2E on the dev container and `app-image-scan` pass with zero unexpected skips, and compare the `Cannot pipe to a closed or destroyed stream` count against a recent `main` run (research R2). **Quote** run numbers
- [ ] T017 [US1] After PR A deploys, **operator**: on production, complete backup consent, then start account deletion and stop at the identity provider's sign-in (US1 scenario 5, SC-001). **Quote** both results, including that no `Invalid parameter: redirect_uri` appeared and that consent returned to the app. PR C must not start until this passes

**Checkpoint**: PR A merged and deployed, and T017 passed.

---

## Phase 4: User Story 2 - Failures that look healthy are caught (PR B, SDK 57)

**Goal**: Each defect that looked healthy in the spike fails a gate with a message naming the cause.

**Independent Test**: The deliberate defects in [quickstart.md](./quickstart.md) each fail on the first run, then pass when reverted.

### One instance of the styling library

- [ ] T018 [P] [US2] Add `tamaguiInstances(lockText)` and its tests to `scripts/__tests__/tamagui-version-lockstep.guard.test.mjs`, per [contracts/web-gates.md](./contracts/web-gates.md): a synthetic lock with two peer contexts must give two keys, the repo's lock exactly one per package, and zero must fail (US2 scenarios 1, 6; FR-006, FR-010)
  - **Verify RED**: `node --test scripts/__tests__/tamagui-version-lockstep.guard.test.mjs`
  - **Expected RED**: the synthetic case fails while `tamaguiInstances` is a stub returning one key
- [ ] T019 [US2] Implement the snapshot-key count in the same file, naming both keys and `pnpm dedupe` in its failure message
  - **Verify GREEN**: same command as T018; 0 failures. Also confirm a real lock copy with a second `@tamagui/web` peer context fails. **Quote** it (SC-005 defect 1)

### Cold-load budget and inline-script allowlist

- [ ] T020 [P] [US2] Add failing cases to `scripts/__tests__/check-web-bundle-budget.test.mjs` for each row of [contracts/web-gates.md](./contracts/web-gates.md): no HTML; a page with no scripts; a referenced script missing; two chunks that fit apart but not together; an unlisted inline script reported with its page and hash (US2 scenarios 2, 3; FR-007, FR-008)
  - **Verify RED**: `node --test scripts/__tests__/check-web-bundle-budget.test.mjs`
  - **Expected RED**: the new cases fail, because the gate measures only `entry-*` and never reads HTML
- [ ] T021 [US2] Export `INLINE_SCRIPT_HASHES` from `frontend/mcm-app/web-security-headers.js` and build `script-src` from it, with `frontend/mcm-app/web-security-headers.test.js` asserting the export contains today's hash and the header is unchanged byte for byte (FR-007, FR-014)
  - **Verify RED**: `pnpm nx test mcm-app -- --watchman=false web-security-headers.test.js`, with the test added first
  - **Expected RED**: fails with `INLINE_SCRIPT_HASHES` undefined
  - **Verify GREEN**: same command; 0 failures
- [ ] T022 [US2] Implement the cold-load total and the allowlist in `scripts/check-web-bundle-budget.mjs`, reading the allowlist through `createRequire`, adding the report fields from [data-model.md](./data-model.md), and extending `--selftest` to prove each new failure (FR-010). Point its failure text at `specs/087-expo-sdk-58/contracts/web-gates.md`
  - **Verify GREEN**: same command as T020, then `node scripts/check-web-bundle-budget.mjs --selftest`; 0 failures, selftest ok
- [ ] T023 [US2] Add `"inputs": ["default", "{workspaceRoot}/scripts/check-web-bundle-budget.mjs"]` to `bundle-budget` in `frontend/mcm-app/project.json`. Prove it: touch only the script and confirm `pnpm nx bundle-budget mcm-app` does not report a local cache hit for that target
- [ ] T024 [US2] Run `pnpm nx bundle-budget mcm-app` on the real export and confirm it passes with one inline script. Then, on the exported output, add an unlisted inline script and separately pad a referenced script past the budget, and run `node scripts/check-web-bundle-budget.mjs --dist frontend/mcm-app/dist --require-maps` each time. **Quote** the two failures (SC-005 defects 2 and 3) and the cold-load figure (M3)

### Browser walk

- [ ] T025 [US2] Create `frontend/mcm-app/tests/e2e/web/fixtures/security-policy-watch.ts`, per research R8: records `securitypolicyviolation` through an init script and `pageerror`, asserts the right server, and proves it can see a violation with an injected inline script. Exceptions are passed at the call site, and the default allows none
- [ ] T026 [US2] Create `frontend/mcm-app/tests/e2e/web/page-security-policy-walk.spec.ts`, tagged `@gate`, covering each row in [contracts/web-gates.md](./contracts/web-gates.md), with a throwaway identity as `admin-registration.spec.ts` mints, `test.use` opting out of the shared session, and BFF teardown in `afterEach` (US2 scenario 5; US3 scenario 5; FR-009). Add it to `testMatch` and `testIgnore` in `frontend/mcm-app/playwright.config.ts`, and to the list in `scripts/__tests__/e2e-worker-session.test.mjs` if that guard requires it
  - **Verify RED**: the negative control in [contracts/web-gates.md](./contracts/web-gates.md), running through the official Playwright image with `tests/e2e/web/page-security-policy-walk.spec.ts --project=lifecycle --no-deps` and `E2E_BFF_TARGET=dev-container`. Without `--no-deps` this runs all 210 tests
  - **Expected RED**: fails listing a `script-src` violation for the hydrate script, the same negative control the spike measured
  - **Verify GREEN**: same command with the file restored and the container recreated; 2 or more passed with 0 skipped. **Quote** both
- [ ] T027 [US2] Add the watch to the `navigate → the assistant opens the named collection screen` test in `frontend/mcm-app/tests/e2e/web/assistant-navigate.spec.ts`, declaring the one `eval` exception there (US3 scenario 3, SC-004)
  - **Verify RED**: add a temporary second inline script after the watch's own check, and run the test in the official Playwright image with `E2E_AGENT_PRODUCTION=1 E2E_REQUIRE_AGENT_STACK=1`
  - **Expected RED**: fails listing that violation, which proves the exception is narrow
  - **Verify GREEN**: remove the temporary script; passes. **Record** whether the `eval` line fired. If it never fires, remove the exception and say so in `research.md`

### Android launch check

- [ ] T028 [P] [US2] Create `scripts/android-launch-smoke.sh` per [contracts/android.md](./contracts/android.md), with the log classifier as a separate function (US4 scenarios 1, 2; US2 scenario 6)
  - **Verify RED**: write `--selftest` first, with a classifier that returns clean for everything
  - **Expected RED**: selftest fails on each of `FATAL EXCEPTION`, `ClassNotFoundException`, `NoSuchMethodException`
  - **Verify GREEN**: `bash scripts/android-launch-smoke.sh --selftest` passes; the same run rejects an unrecognised argument with exit 2
- [ ] T029 [P] [US2] Create `scripts/publish-android-launch.mjs` and `scripts/__tests__/publish-android-launch.test.mjs`, modelled on `scripts/publish-sweep-verdict.mjs`, with its mapping mutation-tested, each row of the status table in [data-model.md](./data-model.md) covered, and the shared rejecting argument parser (US4 scenario 7)
  - **Verify RED**: `node --test scripts/__tests__/publish-android-launch.test.mjs` fails before the mapping exists
  - **Verify GREEN**: same command; 0 failures
- [ ] T030 [US2] Wire both into `.forgejo/workflows/app-ci.yml`: the launch check line after `adb install`, wrapped in `scripts/ci-log-step.sh`, with the status step as `continue-on-error` and `if: ${{ always() && <the emulator step's own gate> }}`, so a PR that skips the emulator posts nothing. Add `scripts/android-launch-smoke.sh` to **both** path filters beside `scripts/maestro-run.sh`. Calibrate or record the wrapped step as #338n requires
  - **Verify GREEN**: `node --test scripts/__tests__/ci-log-step.test.mjs scripts/__tests__/app-ci-mobile-full.guard.test.mjs`; 0 failures

### Land it

- [ ] T031 [US2] Add each new script's selftest to `.forgejo/workflows/guardrails.yml` where it isn't already covered by `scripts/__tests__/`, and update `frontend/mcm-app/README.md` and `docs/runbooks/e2e-testing.md` to describe the gates (FR-026)
- [ ] T032 [US2] Open PR B from a new branch off `main` with the label `mobile-e2e` and its rollback steps. Confirm the walk ran, and read `app-ci / android-launch` on the head commit. Expect `launch=ok login-screen=visible fatal=0`. **Quote** this as the SDK 57 control. A failure here is an instrument failure or a real SDK 57 defect; settle which before moving on

**Checkpoint**: PR B merged. SC-005 has 4 of 4 defects quoted, and the launch check works on SDK 57.

---

## Phase 5: Upgrade foundation (PR C, SDK 58; blocks US3 and US4)

**Purpose**: The bump itself. Nothing in US3 or US4 can start until the workspace installs with one instance and exports.

- [ ] T033 Run the [quiet-lock protocol](../081-major-dependency-upgrades/plan.md) and paste its output into the PR body: no open `renovate/` PR, outside the Friday window, lock on `main` is the last maintenance result
- [ ] T034 Take M0 to M3 from [research.md](./research.md), including M1 through `specs/087-expo-sdk-58/tools/measure-page-latency.mjs` on `main`. **Quote** the figures; M1 replaces the spec's SC-002 baselines
- [ ] T035 Create PR C's branch from `main`. Run `CI=1 pnpm expo install expo@^58.0.0 --fix` in `frontend/mcm-app`, choosing a version that passes the release-age policy (M2)
- [ ] T036 Align the workspace (FR-011; research R11): `react`, `react-dom` in `frontend/mcm-app/package.json` and `packages/design-system/package.json`, and the `react-dom` override and `@expo/dom-webview` override in `pnpm-workspace.yaml`; `react-native`, `jest`, `jest-expo`, `@types/jest`, `@types/react`, `eslint-config-expo`, `test-renderer` in `packages/design-system/package.json`; `test-renderer` in `frontend/mcm-app/package.json`
- [ ] T037 Run `CI=true pnpm dedupe`, then `CI=true pnpm install --frozen-lockfile`
  - **Verify GREEN**: `node --test scripts/__tests__/tamagui-version-lockstep.guard.test.mjs`; 0 failures, one instance. If it fails, it has caught the spike's blank-page cause; do not proceed
- [ ] T038 Record the "upgrade RED": `pnpm nx typecheck mcm-app`, `pnpm nx test mcm-app -- --watchman=false`, `pnpm nx lint mcm-app`, `pnpm exec tsc --noEmit -p packages/design-system`, `pnpm nx test design-system`, `pnpm nx lint design-system`. **Quote** the failure counts. The spike found 6 type errors and 2 failing suites; a much larger number means something differs from the spike. `mcm-app` lint warnings must not exceed `main`'s 49 (item #939)
- [ ] T039 Add a non-blocking `expo-doctor` step to the `affected` job in `.forgejo/workflows/app-ci.yml`, per research R15, run only when the app is affected and wrapped in `scripts/ci-log-step.sh`, with the step calibration #338n requires
  - **Verify GREEN**: `node --test scripts/__tests__/ci-log-step.test.mjs`; 0 failures

**Checkpoint**: One instance, and the failures to fix are known.

---

## Phase 6: User Story 3 - Web members notice nothing (PR C, SDK 58)

**Goal**: Web runs on SDK 58 with prerendered pages and API routes in one process.

**Independent Test**: The full web suite and the assistant's gate tier pass, within the performance tolerance.

- [ ] T040 [US3] In `frontend/mcm-app/app.json`, set `web.output` to `static` and the `expo-router` plugin to `{ "apiRoutes": true, "asyncRoutes": { "web": false } }` (FR-012, FR-013)
  - **Verify GREEN**: `pnpm nx export-server mcm-app --skip-nx-cache` succeeds, and `jq '{html: (.htmlRoutes|length), notFound: (.notFoundRoutes|length), api: (.apiRoutes|length)}' frontend/mcm-app/dist/server/_expo/routes.json` matches the T002 baseline, with 38 API routes and every one of the 16 page files in `frontend/mcm-app/src/app` accounted for. **Quote** it (US3 scenario 1)
- [ ] T041 [US3] Prove a render error fails the build (US3 scenario 2): add a throw to one page, confirm `pnpm nx export-server mcm-app --skip-nx-cache` fails, then revert. **Quote** the failure. This has so far only been read from source
- [ ] T042 [P] [US3] Fix the type errors from T038 in `frontend/mcm-app/src/components/no-autofill-input.tsx`, `packages/design-system/components/assistant/AssistantPanel.tsx`, `packages/design-system/components/inputs/SearchBar.tsx`, `packages/design-system/components/inputs/TextField.tsx`, `packages/design-system/components/navigation/AppBar.tsx`, without `any` or suppressions (FR-016)
  - **Verify GREEN**: `pnpm nx typecheck mcm-app` and `pnpm exec tsc --noEmit -p packages/design-system` report 0 errors, and `pnpm nx test design-system` passes
- [ ] T043 [US3] Diagnose and fix the Jest 30 failure in `frontend/mcm-app/tests/unit/bff-server-adapter.test.ts` and `bff-server-trust-proxy.test.ts` (the research "Open item"; FR-016, US1 scenario 4). Neither may be skipped. Record the cause in `research.md`
  - **Verify RED**: `pnpm nx test mcm-app -- --watchman=false tests/unit/bff-server-adapter.test.ts tests/unit/bff-server-trust-proxy.test.ts`
  - **Expected RED**: `You are trying to require a file outside of the scope of the test code`
  - **Verify GREEN**: same command; all tests pass, the suites report passed, and the scheme-fix mutation from T007 still fails
- [ ] T044 [P] [US3] Lift the holds in `renovate.json` (FR-017; research R12): first update the assertions in `scripts/__tests__/renovate-workflow.guard.test.mjs` at the cause, so they state the holds are gone
  - **Verify RED**: `node --test scripts/__tests__/renovate-workflow.guard.test.mjs`
  - **Expected RED**: fails naming the `test-renderer` and held-jest rules, which still exist
  - Then delete both rules from `renovate.json`, and record one-line re-check results for JDK, Babel 8 and `async-storage`
  - **Verify GREEN**: same command; 0 failures
- [ ] T045 [P] [US3] Delete the `decode-uri-component` entry from `security/sast/allowlist.yaml` (FR-018). Confirm `grep -c decode-uri-component pnpm-lock.yaml` gives 0 and the SAST gate passes without it. **Quote** it
- [ ] T046 [US3] Confirm the policy (FR-014, US3 scenario 3): `script-src` in `frontend/mcm-app/web-security-headers.js` has no `'unsafe-inline'` or `'unsafe-eval'`, and `pnpm nx bundle-budget mcm-app` passes with the one allow-listed inline script. If the budget fails, raising it is a deliberate change quoting before and after (SC-003)
- [ ] T047 [US3] Measure SC-002 with `specs/087-expo-sdk-58/tools/measure-page-latency.mjs --url <server>/login --pid <server pid>` on the same machine as T034. **Quote** response time and memory against M1. Outside 25% is a stop-and-ask, not a threshold to edit
- [ ] T048 [US3] Amend `.specify/memory/constitution.md` to 2.8.0 per section 7 of the [proposal](../../docs/proposals/MCM-Expo-SDK-58-Approach.md): the SDK line, the BFF output line and the version history (FR-024). **Operator approval required before merge**; record it here
- [ ] T049 [P] [US3] Update the docs for the new output mode (FR-026): `frontend/mcm-app/README.md`, `docs/runbooks/e2e-testing.md`, the `web.output` wording in `security/sast/allowlist.yaml`'s other comments if they rely on it, the SDK comment in `.devcontainer/devcontainer.json:235`. Fix sources only; never hand-edit a generated `openwiki/` page

**Checkpoint**: Web is ready for CI. US3 scenario 4 and SC-004, SC-007 are proven by T057.

---

## Phase 7: User Story 4 - The Android app launches on a real release build (PR C, SDK 58)

**Goal**: A CI-built release APK launches, signs in and runs the assistant flows, with the results quoted.

**Independent Test**: The launch check and Maestro flows pass on the PR's APK.

- [ ] T050 [US4] Create `scripts/__tests__/android-release-shrinking.guard.test.mjs` per [contracts/android.md](./contracts/android.md), with synthetic inputs proving that absent and `true` both fail (US4 scenario 6; US2 scenario 6; FR-010, FR-020)
  - **Verify RED**: `node --test scripts/__tests__/android-release-shrinking.guard.test.mjs`
  - **Expected RED**: fails with `expo-build-properties` absent from `app.json`
- [ ] T051 [US4] Add `expo-build-properties` with `CI=1 pnpm expo install expo-build-properties`, and set `{ "android": { "enableMinifyInReleaseBuilds": false } }` in `frontend/mcm-app/app.json`
  - **Verify GREEN**: same command as T050; 0 failures. Then repeat `CI=true pnpm install --frozen-lockfile` and `node --test scripts/__tests__/tamagui-version-lockstep.guard.test.mjs`, because this changed the lock again; still one instance
- [ ] T052 [US4] Run `CI=1 npx expo prebuild --platform android --no-install --clean` in `frontend/mcm-app`, then confirm `android/gradle.properties` has `android.enableMinifyInReleaseBuilds=false`, and the generated network security config permits cleartext only for `localhost`, `127.0.0.1` and `10.0.2.2` (FR-023). **Quote** both, then delete the generated `android/`
- [ ] T053 [US4] Extend `scripts/__tests__/prod-apk-gradle-heap.guard.test.mjs` to require the heap and fail-fast flag in both the `prod-apk` and `app-e2e` build steps (US4 scenario 5; FR-019)
  - **Verify RED**: `node --test scripts/__tests__/prod-apk-gradle-heap.guard.test.mjs`
  - **Expected RED**: fails on `app-e2e`, whose build step sets no `org.gradle.jvmargs`
- [ ] T054 [US4] Add the #933 user-level `gradle.properties` block to the `build-apk` step in `.forgejo/workflows/app-ci.yml`
  - **Verify GREEN**: same command as T053; 0 failures
- [ ] T055 [P] [US4] Move `GRADLE_VERSION` to 9.4.1 in `.devcontainer/toolchain.Dockerfile`, and the `gradle-9.3.1` paths in `docs/runbooks/android-emulator.md:118,138,140`. Document in that runbook that the launch check now runs in `app-e2e`. **Operator**, after merge: rebuild the toolchain image with `node scripts/build-devcontainer-image.mjs`, or pull the CI-published one. This does not block merge (FR-019, FR-026)
- [ ] T056 [US4] **Required, and may not be left open at merge (FR-021).** On PR C's CI run, read `app-ci / android-launch` and the Maestro results for `login-keycloak` and the agent flows (US4 scenarios 1 to 4; FR-022; SC-006). Fill in the [launch evidence](#launch-evidence-fr-021) table. If the app fails to launch, stop: PR C does not merge

**Checkpoint**: Launch evidence is quoted for SDK 58.

---

## Phase 8: Polish and release (PR C, then after merge)

- [ ] T057 Open PR C with the label `mobile-e2e-full` applied **before** the push that should run it, with web and APK rollback steps in the body (FR-025). Confirm every context, with `E2E_REQUIRE_AGENT_STACK=1` in force: web gate tier including the walk, assistant gate tier with a streamed turn (US3 scenario 4), the `expo-doctor` step's result, `pnpm nx test design-system` and `pnpm nx lint design-system`, and zero unexpected skips (SC-004, SC-007, FR-016). Confirm nothing changed for members (FR-015): `security-headers.spec.ts` and `session-timeout.spec.ts` pass unedited, and the only session cookie is still `mcm_session_id`, `HttpOnly`, `SameSite=Strict`. **Quote** counts and run numbers
- [ ] T058 Run the [completion checklist](#completion-checklist) up to merge, then merge with operator approval of T048
- [ ] T059 After merge, confirm `cd-deploy` `prod-apk` succeeded with the raised heap on the real path (FR-019). **Quote** the run
- [ ] T060 After deploy, **operator**: install the published APK on a device and sign in, as the first run of the production-URL build. Also confirm a web rollback path exists: the previous digest is known and no migration ran (US3 scenario 6, SC-009). **Quote** it
- [ ] T061 After 7 days, confirm no production rollback and no behaviour-change release note (SC-008)
- [ ] T062 Close items only after their criteria are verified: item #792 once T044 is on `main`. Then items #937 (R8) and #938 (async routes) become startable; add a comment to each saying so

---

## Dependencies and Execution Order

```text
Setup (T001-T002)
  └─ PR A: US1 + US2 healthcheck (T003-T016) ── deploy ── T017 passes
       └─ PR B: US2 gates (T018-T032)
            └─ PR C: Foundation (T033-T039)
                 ├─ US3 (T040-T049)
                 └─ US4 (T050-T056)
                      └─ Release (T057-T062)
```

- **Story dependencies**: US3 and US4 need US1 and US2 merged. PR B needs only PR A's merge in order to rebase cleanly; its gates don't use the new adapter, so it could swap order with PR A if PR A stalls.
- **Within a story**: test first, then its paired implementation.
- **T017 blocks T033**: the SDK move does not start until the adapter is proven in production.
- **T056 and T048 block merge of PR C.**
- **2026-12-01**: if T058 has not happened by this date, renew the `decode-uri-component` entry first, so CI stays green.

### Parallel opportunities

```text
PR A:  T010 alongside T003-T009 (docs only)
PR B:  T018, T020, T028, T029 (different files, one per gate)
PR C:  T042, T044, T045, T049 after T038;  T055 alongside US4
```

The sandbox has limited memory shared between sessions. Run at most one background agent, and don't run heavy tiers together.

## Implementation Strategy

- **Smallest useful release**: PR A. It retires an unmaintained dependency and protects a production security flow, even if SDK 58 never happens. PR A and PR B are both worth keeping on their own.
- **Stopping points**: after each PR. "Stay on 57" remains a valid position until React Native 0.86 leaves support.
- **Not this feature**: R8 on (item #937), async routes on (item #938), the BFF split.

## Platform Parity Table

| Scenario | Web (Playwright) | Mobile (Maestro) | Status |
|---|---|---|---|
| US1-AC1 to AC4: scheme through the real adapter | N/A — server test, no client (`bff-server-trust-proxy.test.ts`) | N/A — server test, no client | N/A |
| US1-AC5: backup consent, deletion reach sign-in | Operator check, T017 | N/A — a one-time production check by the operator, not a repeatable flow | N/A |
| US2-AC1 to AC4, AC6: keyless gates, healthcheck | N/A — tooling | N/A — tooling | N/A |
| US2-AC5: no policy violation, no page error | `page-security-policy-walk.spec.ts` | N/A — a native app has no browser security policy | N/A |
| US3-AC1, AC2, AC3, AC5, AC6: web build and hosting | `page-security-policy-walk.spec.ts`, full web suite | N/A — web output only | N/A |
| US3-AC4: streamed assistant reply | `assistant-navigate.spec.ts` | `assistant-navigate.yaml` | ✅ |
| US4-AC1, AC2: release APK launches, clean device log | N/A — Android release binary | `scripts/android-launch-smoke.sh` | N/A |
| US4-AC3: login through the system browser | `auth.spec.ts` | `login-keycloak.yaml` | ✅ |
| US4-AC4: assistant flows | Agent specs, gate tier | `scripts/ci-mobile-agent-flows.sh` | ✅ |

## Evidence

Results go here as they arrive, with run numbers. A failed result stays recorded, with what happened next.

### Baselines

| Item | Value | Source |
|---|---|---|
| SDK 57 entry chunk (T002) | | |
| SDK 57 `htmlRoutes`, `notFoundRoutes`, `apiRoutes` counts (T002) | | |
| SDK 57 cold load, M3 (T024) | | |
| Page response time and memory, M1 (T034) | | |

### PR A

| Item | Result | Run |
|---|---|---|
| Scheme fix RED and GREEN (T008) | | |
| Unhealthy on page failure (T015) | | |
| Closed-stream count against `main` (T016) | | |
| Backup consent completed (T017) | | |
| Account deletion reached sign-in (T017) | | |

### PR B

| Item | Result | Run |
|---|---|---|
| Defect 1: second instance (T019) | | |
| Defect 2: unlisted inline script (T024) | | |
| Defect 3: over-budget split bundle (T024) | | |
| Walk negative control and pass (T026) | | |
| `eval` residual fired on the assistant path? (T027) | | |
| SDK 57 launch control (T032) | | |

### PR C

| Item | Result | Run |
|---|---|---|
| Upgrade RED counts (T038) | | |
| `expo-doctor` result (T057) | | |
| Routes manifest (T040) | | |
| Render error failed the build (T041) | | |
| `decode-uri-component` gone (T045) | | |
| Response time and memory against M1 (T047) | | |
| Constitution approval (T048) | | |
| Prebuild: R8 off, cleartext limited (T052) | | |
| CI counts and skip counts (T057) | | |
| `prod-apk` on the real path (T059) | | |
| Production-URL APK signed in (T060) | | |
| 7-day watch (T061) | | |

### Launch evidence (FR-021)

No SDK 58 APK has been launched yet. Only the last row can tick T056.

| Stage | Run | Commit | SDK | Launch | Login screen | Fatal lines | Login flow | Assistant flows |
|---|---|---|---|---|---|---|---|---|
| Control, SDK 57 (T032) | | | | | | | N/A: `mobile-e2e` runs agent flows only | |
| **SDK 58 (T056)** | | | | | | | | |

## Completion Checklist

Before marking `087-expo-sdk-58` complete, verify all success criteria from [spec.md](./spec.md):

- [ ] **SC-001**: Backup consent completes and account deletion reaches sign-in in production, with zero callback refusals
- [ ] **SC-002**: Response time and memory within 25% of the re-measured baseline
- [ ] **SC-003**: First-page download is at most 2,000,000 bytes, counting every script
- [ ] **SC-004**: Zero policy violations and zero uncaught page errors across the walk
- [ ] **SC-005**: Each deliberate defect failed its gate on the first run, 4 of 4
- [ ] **SC-006**: Android release app launches with zero fatal errors, with 100% of login and assistant flows passing, quoted
- [ ] **SC-007**: Full web suite and assistant gate tier pass, with zero unexpected skips
- [ ] **SC-008**: No behaviour-change release note, and no rollback within 7 days
- [ ] **SC-009**: A bad web release can be rolled back with no data migration
- [ ] Platform parity table complete, with no ❌ gaps
- [ ] All test tasks confirmed Verify RED before implementation
- [ ] `pnpm nx typecheck mcm-app`: 0 errors
- [ ] `pnpm nx test mcm-app`: 0 failures, 0 skips, at least 70% line coverage
- [ ] `pnpm nx test:integration mcm-app`: passes
- [ ] `pnpm nx lint mcm-app`: no lint errors, and warnings at or below `main`'s 49 (item #939)
- [ ] `pnpm exec tsc --noEmit -p packages/design-system`, `pnpm nx test design-system`, `pnpm nx lint design-system`: pass
- [ ] `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app`: web E2E passes
- [ ] `node scripts/agent-stack.mjs`, then `node scripts/agent-e2e.mjs` with `E2E_REQUIRE_AGENT_STACK=1`: agent specs pass
- [ ] `pnpm nx e2e:mobile mcm-app`: through CI's `mobile-e2e-full` run, since the sandbox has no KVM
- [ ] `pnpm nx preflight infrastructure-as-code`: passes
- [ ] `pnpm nx okf-lint infrastructure-as-code` and `pnpm nx okf-governance infrastructure-as-code`: pass after the source docs change
- [ ] `rtk gain`: compression confirmed (run last)
