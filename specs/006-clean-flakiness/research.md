# Phase 0 Research: Clean Up Project Flakiness

The spec has no open `[NEEDS CLARIFICATION]` markers (two scope decisions and two policy decisions were resolved in `/speckit-specify` and `/speckit-clarify`). This document records the mechanism decision for each slice. Format: Decision / Rationale / Alternatives considered.

## R1 — Unit isolation flake (`movie-detail-screen.test.tsx`) — US1

**Decision**: Treat it as **cross-file state contamination**, not an in-file bug (the test passes in isolation and uses `jest.clearAllMocks()` in `beforeEach`). Fix at the mechanism level: (a) reproduce deterministically by running the full suite single-threaded with a fixed seed and bisecting the preceding suite (`pnpm nx test mcm-app -- --runInBand --seed=<n>` / narrowing the file set) to identify the leaking sibling; (b) enforce global hygiene in the Jest config — `clearMocks: true`, `resetMocks: true`, `restoreMocks: true` — and add a global `afterEach` safety net that calls `jest.useRealTimers()` and `@testing-library/react-native` `cleanup()`; (c) repair the actual leak source (an un-restored fake timer, a module-level mutable singleton, or a pending async/animation timer) in whichever file owns it. Assertions in `movie-detail-screen.test.tsx` stay unchanged (FR-003).

**Rationale**: The PRD's "jsdom/timer leak" plus "passes isolated, fails in full run" is the classic signature of leaked timers or a global mock not restored by a *different* file. A config-level guarantee (`restoreMocks`/real-timer reset in `afterEach`) fixes the whole class (FR-004), not just the one symptom, and cannot mask a real failure because it only resets test scaffolding between tests.

**Alternatives considered**: (a) Add `jest.useRealTimers()`/cleanup only inside this one file — rejected: treats the symptom, leaves sibling files able to re-leak. (b) Quarantine or `.skip` the test, or run it in its own project — rejected: forbidden by FR-003 and SC-001 (no skip/quarantine). (c) `--maxWorkers=1` permanently to dodge ordering — rejected: hides the leak and slows the suite.

## R2 — E2E stabilization + bounded retry — US2

**Decision**: Root-cause first, then keep **exactly one** bounded, visible retry per E2E test as an environmental safety net (the clarified policy).

- **Web (Playwright)**: keep `retries: 1` (already set), `reporter: 'dot'`, `fullyParallel: false`. Add a Metro warm-up step in `globalSetup` (pre-navigate to `/home` once so the first real test doesn't absorb the 60–70 s cold-compile) and confirm per-test `timeout`/`expect.timeout` headroom. Document the readiness ritual (fresh Metro, emulator stopped to avoid GPU/SSO contention — per project memory). Trace `on-first-retry` already captures the flaky path for triage.
- **Mobile (Maestro)**: Maestro has no built-in per-flow retry in the current invocation, so wrap the Nx `e2e:mobile` run so each flow gets at most **one** re-run on failure, with the retry clearly logged. Re-apply the documented emulator startup ritual (`-no-snapshot-load`, `adb reverse tcp:8081 tcp:8081`, Metro from `frontend/mcm-app`, `-gpu swiftshader_indirect`).

A genuine product regression fails on both the first attempt and the retry, so it still fails the suite (FR-006); the retry only absorbs single transient environmental timeouts.

**Rationale**: Matches the clarification (stabilize + max 1 retry). Reuses existing Playwright machinery and the emulator rituals already captured in CLAUDE.md/project memory; the warm-up pre-navigation directly targets the dominant web failure mode (cold-compile navigation timeouts) observed in features 004/005.

**Alternatives considered**: (a) Zero retries — rejected by the clarification (unachievable on a loaded local emulator). (b) `retries: 2+` / retry-primary — rejected: weakest signal, closest to masking flakiness. (c) A standing CI E2E runner — explicitly out of scope (CI scope is APK build only, per R5).

## R3 — npm hard block (steer to pnpm) — US3

**Decision**: Add a root `package.json` `preinstall` script: `"preinstall": "npx --yes only-allow pnpm"`. Keep the existing `"packageManager": "pnpm@10.33.0"`. Optionally set `engine-strict=true` in `.npmrc` with a documentation-only `engines` note, but the **guard does not depend on it**. `only-allow` inspects `npm_config_user_agent`: a `pnpm install` passes; an `npm install` / `yarn install` aborts with a clear "Use pnpm" message and non-zero exit before any package is written.

**Rationale**: `only-allow` (the `pnpm`-recommended gate) is the robust, well-known mechanism and is invoked through `preinstall`, which runs under whatever package manager the developer used — so it can reliably detect and refuse npm/yarn. Running it via `npx --yes` avoids adding a runtime/dev dependency (consistent with the constitution's "tools-not-deps" stance, like RTK). The `engines.npm = "<sentence>"` trick alone is fragile (depends on npm's semver parsing, bypassable with `--no-engine-strict`/`--force`, and silently inert on other npm versions), and `engine-strict` also gates the `node` range, risking false blocks — so it is documentation, not the guard.

**Alternatives considered**: (a) `engines` + `engine-strict` only — rejected as fragile/bypassable (the user's own question). (b) Add `only-allow` as a devDependency — rejected: `npx --yes` keeps it out of the manifest. (c) A husky/git-hook guard — rejected: doesn't fire on a fresh clone's first install, which is exactly when corruption happens.

**Edge cases**: `only-allow pnpm` also blocks yarn (desired — pnpm is the only sanctioned manager). `preinstall` fires only on installs, not on `npm exec`/`npx <tool>`, so sanctioned tooling that shells out is unaffected. CI uses pnpm, so the gate passes there.

## R4 — Short-path local APK recipe — US4 (local)

**Decision**: Promote the working feature-005 recipe (short build root via `mklink /J C:\m <repo>` + `node-linker=hoisted` build-only install → object path 381→187, then revert) from a `.npmrc` comment into a documented, repeatable `scripts/` helper, with the steps and the mandatory revert kept in CLAUDE.md (FR-010/FR-013). The script must be a no-op-safe wrapper (clear prompts/echo of each step) rather than silently mutating global state.

**Rationale**: The recipe is proven (feature 005 built and installed the APK with it). Capturing it as a script + doc removes the "rediscover it each time" cost without changing the native toolchain. It cannot be fully automated unattended (the junction + hoisted-then-revert touches the whole workspace), so it stays an explicit, documented procedure.

**Alternatives considered**: (a) `virtual-store-dir-max-length` — rejected in 005 (only trimmed 381→293 and broke Metro/jest). (b) Windows `LongPathsEnabled` — rejected: the 250 cap is internal to CMake, unaffected by the OS long-path flag. (c) Do nothing / leave it as tribal knowledge — rejected by FR-010.

## R5 — CI pipeline (APK build only) — US4 (CI)

**Decision**: Two layers — **Nx target** for the build invocation, **GitHub Actions** for the runner/trigger. They are not interchangeable: Nx is a task orchestrator and cannot, on its own, provision a machine, respond to a push/PR, or store artifacts; a CI provider supplies the Linux runner — which is the entire point (it sidesteps the Windows path wall). Nx supplies the *how-to-build*; GitHub Actions supplies the *where/when*.

1. **Nx target (build invocation)**: add an `mcm-app` target — e.g. `build-apk` — that wraps `expo prebuild --platform android` + `gradlew :app:assembleDebug`, so the build is invoked as `pnpm nx run mcm-app:build-apk`. This satisfies the constitution's "all build/test/e2e/build ops execute through Nx targets, never raw tooling" mandate (the same way `eas-build-local` and `docker-build` are already Nx targets). The build logic lives in the target, not in YAML.
2. **GitHub Actions workflow** (`.github/workflows/android-apk.yml`) on **`ubuntu-latest`**, kept thin: checkout → `pnpm/action-setup` (pnpm 10.33.0) → `actions/setup-node` (Node 24.14.1) → `actions/setup-java` (Temurin JDK 17) → Android SDK setup → `pnpm install` → **`pnpm nx run mcm-app:build-apk`** → `actions/upload-artifact` (the APK). Triggered on demand (`workflow_dispatch`) and optionally on pushes touching native config. **Scope is the APK build + artifact only — no test suites run in CI** (clarified).

**Rationale**: A **Linux** runner structurally eliminates the Windows-only `CMAKE_OBJECT_PATH_MAX` (250) wall — non-Windows CMake uses a far higher object-path cap and the runner's working path (`/home/runner/work/<repo>/<repo>`) is short — so the C++ builds (`react-native-worklets`, `react-native-screens`) compile without the junction/hoisted dance. Nx itself cannot escape that wall (running on the Windows dev box hits the same limit); only a non-Windows host can, and that host comes from the CI provider. Wrapping the build in an Nx target keeps the invocation constitution-compliant and lets the *same* target be run locally or from any CI provider. GitHub Actions is the natural provider (the repo already lives on GitHub; PRs are reviewed there).

**Alternatives considered**: (a) **Nx instead of GitHub Actions** — rejected: Nx is a task runner, not a CI host; it has no runner provisioning, event triggers, or artifact storage, and running it on Windows re-hits the path wall. The two are complementary layers, not substitutes. (b) **Nx Cloud** for distributed/remote-cached builds — viable as a later add-on (remote cache + agents) but still must be *triggered from* a CI pipeline, so it does not remove the need for GitHub Actions; out of scope for the artifact-only goal. (c) Raw `gradlew` directly in YAML (the original draft) — rejected: bypasses the Nx-primary-invocation mandate. (d) Windows CI runner — rejected: re-imports the exact path-length wall the feature is escaping. (e) EAS Build (`eas build`) — viable and constitution-named for prod builds, but heavier to wire for a CI artifact-only goal and adds an external service dependency; GitHub Actions + the Nx-wrapped Gradle build is sufficient and self-contained. (f) Run the full test suite in CI too — rejected: out of scope (clarified APK-build-only); E2E in CI would re-introduce the environmental flakiness US2 is fighting.

## Open items requiring human decision

None. All four slices have a concrete, low-risk mechanism and the spec is fully clarified. (CI provider chosen as GitHub Actions here as a HOW detail; flag if a different provider is preferred.)
