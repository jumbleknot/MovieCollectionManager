# Implementation Plan: Expo SDK 55 to 56 Upgrade

**Branch**: `005-expo-sdk-56-upgrade` | **Date**: 2026-05-30 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/005-expo-sdk-56-upgrade/spec.md`

## Summary

Move the `mcm-app` frontend from Expo SDK 55 to Expo SDK 56, bumping React Native 0.83.6 → 0.85 (React stays at the already-installed 19.2.0). The backend `mc-service` (Rust) is unaffected except for interop validation. The work is **documentation-first**: the constitution and `CLAUDE.md` are amended to the new version baseline **before** any code change (FR-001, SC-001), which is itself a constitution amendment requiring human approval (FR-014). Then dependencies are upgraded via `npx expo install`, the codebase is reviewed against SDK 56 deprecations/removals, the full existing test suite (unit, integration, web E2E, mobile E2E) is run and brought green, a before/after performance benchmark confirms ≤10% regression per critical flow, and `/security-review` is run with all High/Critical findings resolved. No new functionality is added.

## Technical Context

**Language/Version**: TypeScript ~5.9.2 on Node.js 24.14.1 LTS; React 19.2.0 (unchanged); target React Native 0.85 (from 0.83.6); target Expo SDK 56 (from ^55.0.0). Backend Rust (mc-service) unchanged.

**Primary Dependencies**: Expo SDK (expo, expo-router ~55→56, expo-auth-session, expo-secure-store, expo-crypto, expo-constants, expo-linking, expo-web-browser, expo-status-bar, @expo/metro-runtime, @expo/server), react-native-web, react-native-screens, react-native-safe-area-context, @react-native-async-storage/async-storage, @react-native-picker/picker, axios, express, ioredis, jsonwebtoken. Tooling: Nx 22.6.3 + @nx/expo, pnpm 10.33.0, jest-expo, babel-preset-expo, @playwright/test, Maestro.

**Storage**: N/A for this feature (no schema/data changes). Existing stores unchanged: Redis (BFF sessions), MongoDB (mc-service), PostgreSQL (Keycloak).

**Testing**: Jest + jest-expo (unit), dedicated `jest.integration.config.js` (BFF integration against real Keycloak/Redis/mc-service), Playwright (web E2E), Maestro (Android mobile E2E), `cargo test` via Nx (mc-service). All invoked through Nx targets.

**Target Platform**: Web (React Native Web) and Android (emulator/device). iOS is NOT a verification target this feature (no `ios/` directory present). `android/` directory IS committed — native config must be regenerated/reconciled for RN 0.85.

**Project Type**: Polyglot Nx monorepo — universal React Native + Expo frontend (`frontend/mcm-app`) with server-side BFF (Expo Router API routes) + Rust/Axum backend (`backend/mc-service`). This feature touches the frontend and shared documentation only.

**Performance Goals**: No critical user flow may regress more than 10% versus a pre-upgrade baseline captured on the current SDK 55 build (FR-007, SC-006). Baseline = timings of critical flows captured before the dependency bump.

**Constraints**: No reduction in functionality (FR-004, FR-012) or performance (FR-007). Security posture ≥ pre-upgrade (FR-010); `/security-review` High/Critical findings block completion (FR-009). Documentation-first ordering is mandatory (FR-001). Dependency conflicts that can't be resolved without losing functionality/performance → halt & escalate to human (FR-013).

**Scale/Scope**: One frontend app (`mcm-app`); ~6 user-story test areas (auth, sessions, collections, movies) already covered by existing suites. No new screens, routes, or endpoints.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

This is an upgrade/maintenance feature. It changes versions and documentation, not architecture. Evaluated against the binding principles:

| Principle | Status | Notes |
|---|---|---|
| **AI Assistant Constraints — No Vibe Coding / Adherence** | PASS | Plan + spec drive the work; deviations documented here. |
| **Technology Agnosticism (spec vs plan)** | PASS | spec.md is version-agnostic in requirements; concrete versions live here and in Assumptions. |
| **Dependency Security (keep deps current, pin versions)** | PASS (advances) | The upgrade directly serves this principle. Versions remain pinned via `npx expo install`. |
| **Frontend Stack — Expo SDK version** | ⚠ AMENDMENT REQUIRED | Constitution §Frontend App Technology Stack pins "Expo SDK 55 (… `default@sdk-55`)". Moving to SDK 56 is a stack change that **requires a constitution amendment with documented justification** (constitution: "Deviations from this stack require constitution amendment"). This is the explicit purpose of the feature (FR-001/FR-014) and is performed documentation-first with human approval. Tracked in Complexity Tracking. |
| **Frontend Stack — Node 24.14.1, Hermes, JSI/New Arch, pnpm, @nx/expo** | PASS (verify) | All retained. SDK 56 keeps New Architecture default + Hermes. Confirm Node 24.14.1 satisfies RN 0.85 engine range during research; if a newer LTS is required, treat as an additional amendment. |
| **TDD (NON-NEGOTIABLE)** | PASS (adapted) | No NEW feature code → no new RED-first tests. The existing suite is the safety net; any test that changes only to reflect equivalent SDK 56 behavior is updated, never weakened (FR-006). tasks.md will still carry the mandated TDD checkpoint/Platform-Parity format for the verification tasks. |
| **Test Type Integrity (no mocking in integration tests)** | PASS (watch) | `axios-mock-adapter` exists in devDeps (unit-test use). Must NOT leak into `tests/integration/`. Upgrade must not introduce mocks into integration suites. |
| **Centralized Access Control / Security (BFF, sessions, JWT)** | PASS | No auth code is rewritten; upgrade must preserve HttpOnly cookies, session invalidation, JWT validation. Verified by existing auth/session E2E + `/security-review`. |
| **Logging & Monitoring** | PASS | No logger changes intended; structured logger + redaction preserved. |
| **Nx-first invocation / pnpm only** | PASS | All build/test/lint/e2e run through Nx targets; pnpm only (no npm/yarn). |
| **RTK active (AI session)** | PASS | RTK required for the implementing session; verified via `rtk gain` after test runs. |

**Gate result: PASS with one tracked amendment** (Expo SDK 55→56 stack version), which is the sanctioned, documentation-first purpose of the feature and requires human approval before code changes (FR-001, FR-014).

## Project Structure

### Documentation (this feature)

```text
specs/005-expo-sdk-56-upgrade/
├── plan.md              # This file (/speckit-plan output)
├── research.md          # Phase 0 output — version targets, breaking-change analysis, conflict policy
├── data-model.md        # Phase 1 output — N/A rationale (no domain entities) + config/version inventory
├── quickstart.md        # Phase 1 output — upgrade runbook + verification gates
├── spec.md              # Feature specification (/speckit-specify)
├── checklists/
│   └── requirements.md  # Spec quality checklist (/speckit-specify)
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

> No `contracts/` directory: this feature changes no external interface (no BFF route, no mc-service API, no event contract). The API surface is identical before and after — preservation of existing contracts is a verification concern, captured in quickstart.md, not a new contract artifact.

### Source Code (repository root)

```text
frontend/mcm-app/                 # PRIMARY surface of this feature
├── package.json                  # Expo/RN/React dep version bumps; remove now-implicit deps
├── app.json                      # SDK 56 cleanup (drop redundant fields; consider expo-build-properties)
├── babel.config.js               # expo-default-only → candidate for deletion (SDK 56 housekeeping)
├── eas.json                      # verify CLI version range for SDK 56 builds
├── android/                      # committed native project — reconcile/regenerate for RN 0.85
│   ├── build.gradle
│   └── app/build.gradle
├── src/
│   ├── app/                      # routes + bff-api (Expo Router); verify routing under SDK 56
│   ├── bff-server/               # BFF utilities (auth, sessions, keycloak) — preserve behavior
│   ├── components/               # incl. no-autofill-input, movie-form (picker)
│   ├── hooks/                    # use-auth.tsx (Context API — already React 19), use-login, etc.
│   └── utils/
└── tests/
    ├── app/                      # App-layer unit tests
    ├── integration/              # BFF real-dependency integration suite
    └── e2e/{web,mobile}/         # Playwright + Maestro suites (regression + perf baseline source)

backend/mc-service/               # Rust — unchanged; interop only (JWT/HTTP contract must still hold)

# Documentation to update (FR-011) — constitution & CLAUDE.md FIRST (FR-001):
.specify/memory/constitution.md   # Expo SDK 55→56, RN/React/Node version refs, sdk-55 template cmd
CLAUDE.md                         # project overview + commands version references
README.md / docs/**               # any setup/version references
specs/**                          # historical version references (informational; update where stated as current)
```

**Structure Decision**: Existing polyglot Nx monorepo retained unchanged. The feature is confined to `frontend/mcm-app` (dependency + config + any deprecation fixes), shared documentation (constitution, CLAUDE.md, READMEs), and the committed `frontend/mcm-app/android/` native project (reconciled for RN 0.85). `backend/mc-service` is untouched apart from interop verification. No directories are added, moved, or removed.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Constitution stack amendment: Expo SDK 55 → 56 (and any required Node/RN baseline bumps) | The entire feature exists to advance the framework baseline per the PRD; the constitution's Dependency Security principle mandates keeping dependencies current, which conflicts with the hard-pinned "Expo SDK 55" stack line until amended. | Not amending and "just upgrading code" would leave the constitution contradicting the codebase, violating the No-Vibe-Coding/Adherence principle. A documented amendment with human approval (FR-014) is the constitution's own prescribed mechanism — there is no lighter compliant path. |
