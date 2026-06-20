# Quickstart: Clean Up Project Flakiness — Verification Runbook

Operator runbook to execute and verify each slice. Commands run from the repo root (PowerShell; a Bash shell is also available). RTK must be active (`rtk gain` > 80% after test runs). No `[NEEDS CLARIFICATION]` remain.

> This feature is **behavior-neutral** for end users. Every check below proves *reliability/guard* behavior — none should change a user-facing flow (FR-012 / SC-007).

## 0. Pre-flight — capture the current (flaky) baseline

```powershell
pnpm nx up-all infrastructure-as-code     # infra for integration/E2E
pnpm nx test mcm-app                       # full unit run — observe the movie-detail-screen flake in full-run context
npm install                                # EXPECTED today: succeeds (proves the guard is absent — the RED for US3)
```

Record: the unit-suite failure signature in the full run, and that `npm install` currently succeeds.

## 1. US1 — Unit isolation (deterministic green ×10)

```powershell
# Reproduce + bisect the leak deterministically
pnpm nx test mcm-app -- --runInBand
# After the fix, prove stability across 10 consecutive full runs:
1..10 | ForEach-Object { pnpm nx test mcm-app --skip-nx-cache }
```

**Pass (SC-001/SC-002)**: 10/10 runs green including `movie-detail-screen.test.tsx`; pass count ≥ baseline; zero `skip`/quarantine added.

## 2. US2 — E2E stabilization (consistent green ×3, ≤1 retry)

```powershell
# Web (fresh Metro; emulator stopped to avoid GPU/SSO contention)
1..3 | ForEach-Object { pnpm nx e2e mcm-app }

# Mobile (emulator ritual first: -no-snapshot-load, adb reverse tcp:8081 tcp:8081, Metro from frontend/mcm-app)
1..3 | ForEach-Object { pnpm nx e2e:mobile mcm-app }
```

**Pass (SC-003/SC-004)**: each suite green across 3 runs; any retry is ≤1 per test, visible in output; no genuine regression masked (inject a deliberate assertion break once → confirm it fails on both attempts → revert).

## 3. US3 — npm hard block

```powershell
npm install                 # EXPECTED: non-zero exit, clear "Use pnpm" message, NO packages written
yarn install                # EXPECTED: also refused
pnpm install                # EXPECTED: succeeds unchanged
```

**Pass (SC-005)**: npm/yarn refused 100% with a pnpm message; pnpm install unaffected; no existing dev/CI/Nx/Expo workflow broken.

## 4. US4 — APK rebuild (local short-path + CI)

```powershell
# Local short-path recipe (documented script). Builds via short root, then reverts layout.
./scripts/<short-path-apk-build>.ps1        # follows the C:\m junction + node-linker=hoisted build-only recipe
# The build itself is invoked through the Nx target (same invocation CI uses):
pnpm nx run mcm-app:build-apk
adb install -r frontend/mcm-app/android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.grumpyrobot.mcmapp/.MainActivity
```

```text
# CI (GitHub Actions) — APK build only
Trigger the "android-apk" workflow (workflow_dispatch) → it runs on ubuntu-latest →
invokes `pnpm nx run mcm-app:build-apk` → download the published app-debug.apk artifact.
```

**Pass (SC-006)**: local recipe and CI both produce an installable APK without manual path-length intervention; the local APK installs and launches and mobile E2E can run against it; CI runs no test suites.

## 5. Documentation sweep (FR-013 / SC-008)

```powershell
# Confirm guard + procedures are documented and nothing describes the old flaky/unguarded state as current
pnpm exec rg -n "npm install|only-allow|CMAKE_OBJECT_PATH_MAX|short[- ]path|retries" CLAUDE.md specs/006-clean-flakiness/quickstart.md .github/workflows
```

## Definition of Done (maps to Success Criteria)

- [ ] Full unit suite 10/10 green in one pass, flaky test included; no skip/quarantine (SC-001, SC-002)
- [ ] Web + mobile E2E green ×3; retries ≤1/test and visible; no masked regression (SC-003, SC-004)
- [ ] `npm`/`yarn install` hard-fail with pnpm message; `pnpm install` unchanged (SC-005)
- [ ] APK builds on short path locally AND via CI artifact; installs + launches (SC-006)
- [ ] Zero end-user behavior change — existing functional tests identical (SC-007)
- [ ] Docs updated; zero stale "current state" instructions (SC-008)
- [ ] `rtk gain` > 80% after test runs (constitution)
- [ ] tasks.md includes the Platform Parity Table + TDD RED/GREEN checkpoints (constitution)
```
