# Implementation Plan: Clean Up Project Flakiness

**Branch**: `006-clean-flakiness` | **Date**: 2026-05-31 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/006-clean-flakiness/spec.md`

## Summary

Make the existing test and build pipeline trustworthy and tamper-proof, with **no end-user-facing change**. Four independent slices:

1. **Unit isolation (P1)** — eliminate the cross-test state leak that makes `movie-detail-screen.test.tsx` fail only in the full run; fix at the teardown/Jest-config mechanism level so latent siblings are covered too.
2. **E2E stabilization (P2)** — root-cause the environmental web/mobile E2E flakiness (Metro cold-compile, ordering, emulator contention) and keep **at most one** explicit, visible retry as a safety net (Playwright already `retries: 1`; mirror on Maestro). A real regression still fails.
3. **npm hard block (P3)** — a `preinstall` `only-allow pnpm` gate so `npm install` fails fast with a "use pnpm" message (robust mechanism, not the fragile `engines`-string trick). Directly enforces the constitution's pnpm-only mandate.
4. **APK short-path build + CI (P4)** — script + document the existing short-root local recipe, expose the APK build as an **Nx target** (`mcm-app:build-apk`, per the Nx-primary-invocation mandate), and add a thin **GitHub Actions** workflow that runs that target on a Linux runner (which structurally sidesteps the Windows `CMAKE_OBJECT_PATH_MAX` wall) and publishes the APK artifact. CI scope is APK build only. (Nx is the build *invocation*; GitHub Actions is the runner/trigger — they are complementary layers, not substitutes: Nx cannot provision a non-Windows host on its own.)

## Technical Context

**Language/Version**: TypeScript 6.0.3 on Node.js 24.14.1 LTS; Expo SDK 56 / React Native 0.85.3 / React 19.2.3. Rust mc-service unaffected (exercised only for no-regression).

**Primary Dependencies**: Jest + jest-expo 56 (unit), `@testing-library/react-native` (auto-cleanup), Playwright 1.x (web E2E), Maestro (Android E2E), pnpm 10.33.0 workspace, Nx 22.6.3, `only-allow` (run via `npx`/`pnpm dlx` in `preinstall`, not added as a dependency). New: an `mcm-app:build-apk` Nx target (wraps `expo prebuild` + `gradlew`), and GitHub Actions as the CI runner that invokes it (Temurin JDK 17 + Android SDK on the runner).

**Storage**: N/A (no data model change).

**Testing**: Frontend unit (`pnpm nx test mcm-app`, 804 tests, ≥70% coverage), BFF integration (real Keycloak/Redis/mc-service), web E2E (Playwright, 92), mobile E2E (Maestro, 20 flows), mc-service unit+integration (Rust). All via Nx targets per constitution.

**Target Platform**: Web (React Native Web) + Android; plus a Linux CI runner (`ubuntu-latest`) for the APK build.

**Project Type**: Mobile + web frontend app (`frontend/mcm-app`) within an Nx polyglot monorepo, plus repo-root tooling (package-manager guard) and a new CI workflow.

**Performance Goals**: No performance change is in scope (FR-012). Reliability targets replace perf goals: full unit suite 100% green across ≥10 consecutive runs (SC-001); each E2E suite green across ≥3 consecutive runs (SC-003).

**Constraints**: No end-user behavior change (FR-012); no test weakened/skipped/quarantined (FR-003); retries bounded to ≤1 per E2E test and visible (FR-006); Windows `CMAKE_OBJECT_PATH_MAX` (250) is the documented local-build wall the CI runner avoids; RTK active per constitution.

**Scale/Scope**: ~804 unit tests across ~67 suites; 92 Playwright tests; 20 Maestro flows; one root `package.json`, one `.npmrc`, Jest config, `playwright.config.ts`, a Maestro run wrapper, one new GitHub Actions workflow, and doc updates (CLAUDE.md, quickstart).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Relevance | Status |
|---|---|---|
| **Package Manager (pnpm required; npm/yarn prohibited; `packageManager` declared)** | US3 *enforces* this principle at install time; root already declares `pnpm@10.33.0`. | ✅ Strengthens compliance — no amendment needed (implementing an existing mandate). |
| **Monorepo Build Tool (Nx as primary invocation)** | All verification runs through Nx targets; the CI APK build is exposed as an `mcm-app:build-apk` Nx target and invoked via `pnpm nx run …` (not raw `gradlew` in YAML); the `preinstall` guard and CI call pnpm/Nx, never npm. | ✅ |
| **TDD (NON-NEGOTIABLE) + Test Type Integrity** | This feature changes test reliability only; tests must stay equivalent-or-stronger (FR-003); no integration-test mocking introduced. TDD checkpoints captured in tasks.md (e.g., RED = `npm install` currently succeeds / suite flakes; GREEN = install blocked / suite stable ×10). | ✅ |
| **Frontend Quality: Independent State; Stable Selectors; E2E Session Reuse; Test Run Protocol; Platform Parity Table** | "Independent State" is exactly the US1 fix. Existing Playwright `globalSetup` session reuse + tiered protocol preserved; retries stay bounded. tasks.md will carry the Platform Parity Table. | ✅ |
| **Git Management (single root `.gitignore`)** | Any new ignored artifacts (e.g., CI build outputs) go in the root `.gitignore`. | ✅ |
| **CI/CD references (Prettier / `cargo fmt` "enforced in CI/CD")** | Constitution presumes CI exists; this feature adds the first concrete CI workflow (APK build), kept thin and delegating to the Nx `build-apk` target. Consistent with, not contrary to, the constitution. | ✅ |
| **No new end-user functionality** | FR-012; feature is tooling/reliability only. | ✅ |
| **Documentation kept current** | CLAUDE.md + quickstart updated (FR-013). | ✅ |

**Result: PASS.** No principle is diluted; US3 actively reinforces the pnpm mandate. No constitution amendment required. Complexity Tracking below is therefore empty.

## Project Structure

### Documentation (this feature)

```text
specs/006-clean-flakiness/
├── plan.md              # This file
├── research.md          # Phase 0 — decisions on each slice's mechanism
├── data-model.md        # Phase 1 — N/A domain entities; configuration artifacts catalog
├── quickstart.md        # Phase 1 — operator runbook to verify each Success Criterion
├── checklists/
│   └── requirements.md   # Spec quality checklist (from /speckit-specify)
└── tasks.md             # Phase 2 — created by /speckit-tasks (NOT here)
```

### Source Code (repository root)

```text
# Repo root — package-manager guard (US3)
package.json              # ADD "preinstall": "npx --yes only-allow pnpm"; keep "packageManager": "pnpm@10.33.0"
.npmrc                    # OPTIONAL engine-strict + documentation note (guard does not rely on it)

# Frontend app — unit isolation (US1) + E2E stabilization (US2)
frontend/mcm-app/
├── jest.config.js | package.json "jest"   # mechanism-level fix: restoreMocks/clearMocks/resetMocks, real-timer guard
├── jest.setup.* (or test setup)           # global afterEach safety net (cleanup + jest.useRealTimers)
├── src/screens/movies/movie-detail-screen.test.tsx   # remove/repair the leaked-state dependency (no weakened assertions)
├── playwright.config.ts                   # already retries:1; document + tune warm-up/timeouts (US2 web)
├── tests/e2e/web/setup/global-setup.ts    # optional Metro warm-up pre-navigation (US2 web)
└── tests/e2e/mobile/                       # Maestro: bounded (≤1) retry wrapper for the Nx e2e:mobile target (US2 mobile)

# Local short-path APK recipe (US4 local)
scripts/                  # ADD a documented short-root build script wrapping the C:\m + hoisted recipe
.npmrc / CLAUDE.md        # existing recipe text, refreshed (FR-010/FR-013)

# CI (US4 CI) — first CI workflow in the repo
frontend/mcm-app/project.json (or package.json nx targets)   # ADD "build-apk" target wrapping expo prebuild + gradlew assembleDebug
.github/workflows/
└── android-apk.yml       # thin: ubuntu-latest → pnpm install → `pnpm nx run mcm-app:build-apk` → upload APK artifact
```

**Structure Decision**: No new application source directories or domain code. Changes are confined to (a) repo-root tooling files (`package.json`, `.npmrc`, `scripts/`), (b) `frontend/mcm-app` test configuration and the one flaky test, (c) E2E config/wrappers, and (d) a new `.github/workflows/` directory. This honors the constitution's directory layout (the frontend app stays under `frontend/mcm-app/`; the root `.gitignore` remains canonical) and adds only the standard `.github/workflows/` location for CI.

## Complexity Tracking

> No Constitution Check violations — section intentionally empty.
