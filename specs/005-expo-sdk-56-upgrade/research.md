# Phase 0 Research: Expo SDK 55 → 56 Upgrade

All Technical Context unknowns are resolved below. Each item: Decision / Rationale / Alternatives considered.

## R1 — Exact version targets

**Decision**: Expo SDK `56` (from `^55.0.0`), React Native `0.85` (from `0.83.6`), React `19.2.0` (already installed — unchanged), `react-dom` override stays `19.2.0`. Let `npx expo install expo@latest` + `npx expo install --fix` pin the exact compatible point releases for all `expo-*` and React Native ecosystem packages (expo-router, expo-auth-session, expo-secure-store, expo-crypto, expo-constants, expo-linking, expo-web-browser, expo-status-bar, @expo/metro-runtime, @expo/server, react-native-web, react-native-screens, react-native-safe-area-context, @react-native-async-storage/async-storage, @react-native-picker/picker).

**Rationale**: React is already at the SDK 56 target (19.2.0), so the React 19 migration (useContext→use, Context.Provider→Context, forwardRef removal) was effectively absorbed under SDK 55 and is NOT part of this upgrade. The only runtime version moves are Expo 55→56 and RN 0.83.6→0.85. `expo install --fix` is the canonical way to align peer versions to the SDK; hand-pinning risks incompatible combinations.

**Alternatives considered**: (a) Pinning every dependency by hand — rejected: error-prone, contradicts Expo's supported-version manifest. (b) Jumping React forward — rejected: not required and out of scope.

## R2 — SDK 56 breaking changes applicable to this codebase

Scan results against the SDK 56 (and accumulated 53–56) breaking-change checklist:

| Breaking change | Applies here? | Action |
|---|---|---|
| `@react-navigation/*` → `expo-router/*` import move (SDK 56) | **No** | Source scan found zero `@react-navigation/*` imports. `expo-router` `Stack` usage in route files is correct and stays. |
| `expo-av` → `expo-audio`/`expo-video` (SDK 55) | **No** | No `expo-av` usage. |
| `@expo/vector-icons` → `expo-symbols` | **No** | Not used. |
| React 19 (useContext→use, Context.Provider→Context, forwardRef) | **No (already on 19.2)** | `use-auth.tsx` uses `Context.Provider`/`useContext` — still valid in React 19; already running on 19.2.0, so no migration triggered by this upgrade. Optional modernization is out of scope (no functional change). |
| react-native-reanimated needs react-native-worklets (SDK 54+) | **No** | reanimated not a dependency. |
| New Architecture default; `newArchEnabled` redundant | **Verify** | Confirm `app.json` has no stale `newArchEnabled`; it does not. New Arch already default. |
| Native tabs API change (SDK 55) | **No** | Native tabs not used. |
| Picker on Android new-arch crash | **Known prior issue** | `@react-native-picker/picker` previously crashed on Android new arch; the app already replaced it with radio buttons in `movie-form.tsx` (see project memory). The package still appears in `package.json` + a unit `__mocks__`. Research note: verify whether it is still imported anywhere; if not, removal is optional cleanup (not required by this feature). |

**Decision**: The only mechanical migrations required are dependency version bumps + housekeeping; no API codemods apply.

**Rationale**: Direct source scans (`grep` over `src/`) returned no usages of any deprecated/moved API except the React Context pattern, which is React-19-valid and already in production.

**Alternatives considered**: Running `npx expo-codemod sdk-56-expo-router-react-navigation-replace` defensively — rejected as a no-op (no matching imports) but may be run as a zero-risk confirmation during implementation.

## R3 — Native Android reconciliation (RN 0.85)

**Decision**: The `frontend/mcm-app/android/` directory is committed (no `ios/`). After the dependency bump, regenerate native config with `npx expo prebuild --platform android --clean` (or reconcile gradle files manually if local customizations exist) so the Android project matches RN 0.85 / SDK 56. Then clear Gradle caches (`./gradlew clean`) before the Maestro mobile E2E run.

**Rationale**: RN minor bumps routinely change gradle plugin wiring, Hermes compiler resolution, and codegen. The committed `app/build.gradle` already uses the `expo`/`com.facebook.react` plugin resolution model, so `prebuild --clean` is low-risk; the `android/build.gradle` is minimal (no pinned versions) and regenerates cleanly. iOS reconciliation is skipped (no target, no `ios/`).

**Alternatives considered**: (a) Treating the app as pure CNG and deleting `android/` — rejected: the directory is intentionally committed and the Android emulator workflow (adb reverse, etc.) depends on a stable native project. (b) Manual gradle edits only — kept as fallback if `prebuild` would clobber intentional native customizations; diff must be reviewed before commit.

## R4 — Node runtime compatibility

**Decision**: Keep Node.js 24.14.1 LTS (constitution baseline, also the BFF Docker base `node:24.14.1-alpine3.23`). During implementation, confirm RN 0.85 / SDK 56 support Node 24 LTS; if the SDK requires a newer LTS, that is a second constitution amendment (escalate per FR-013/FR-014) — do not silently change Node.

**Rationale**: SDK 56 targets current Node LTS lines; Node 24 LTS is expected to be supported. Pinning avoids drift in the BFF container image and Hermes/Metro tooling.

**Alternatives considered**: Proactively bumping Node — rejected: out of scope and would touch the Docker base image + constitution without evidence it is required.

## R5 — Housekeeping enabled by SDK 56

**Decision**: Apply the SDK 56 housekeeping items that are safe and behavior-neutral: (a) `babel.config.js` contains only `babel-preset-expo` → delete it (SDK auto-applies the preset); (b) remove now-implicit deps from `package.json` if present (`@babel/core`, `babel-preset-expo`, `expo-constants` are managed by Expo) — verify each is truly implicit before removing; (c) ensure no redundant Metro/PostCSS config (none present); (d) ensure `app.json` has no stale `sdkVersion`/`newArchEnabled` (none present). Hermes v1 opt-in (`useHermesV1`) is **out of scope** (performance opt-in, not required; risks perf-gate noise).

**Rationale**: These reduce config drift and are recommended by the official upgrade guide. Each is verified individually so nothing the app actually relies on is removed (e.g., `expo-constants` is a direct dependency used at runtime — keep it).

**Alternatives considered**: Skipping all housekeeping — rejected: leaves dead config and contradicts "align to new best practices" (FR-008). Enabling Hermes v1 — deferred: optional, could perturb the ≤10% perf gate.

## R6 — Documentation-first ordering (FR-001 / SC-001)

**Decision**: Before ANY change to `package.json`/source, (1) amend `.specify/memory/constitution.md` (Expo SDK 55→56, the `default@sdk-55` create command, and any RN/React/Node version statements) with a new version-history entry and documented rationale, obtain human approval (FR-014), then (2) update `CLAUDE.md` version references. These two governing-document commits must precede the first code commit, and that ordering must be visible in git history (SC-001). Remaining docs (READMEs, `docs/**`, historical `specs/**` "current version" statements) are updated during/after the code upgrade (FR-011, SC-002/SC-003).

**Rationale**: The PRD makes this an explicit success criterion and ordering constraint; the constitution's amendment process is the sanctioned path for the SDK stack-line change.

**Alternatives considered**: Updating docs after code — rejected: violates FR-001 and SC-001.

## R7 — Performance baseline method (clarified)

**Decision**: Capture a before/after benchmark of the critical user flows using the existing E2E suites' timing as the instrument. On the current SDK 55 build, record per-flow timings for the critical flows (login, browse collections, browse/search movies, add/edit/delete movie, logout) on web (Playwright) and Android (Maestro). After the upgrade, re-capture the same flows. Gate: no flow regresses > 10% vs its own pre-upgrade baseline (FR-007, SC-006).

**Rationale**: Matches the clarification (before/after benchmark, ≤10%). Reuses existing instrumentation rather than introducing a new perf harness; keeps the gate testable and avoids new tooling.

**Alternatives considered**: A dedicated benchmarking framework — rejected: heavier than needed and the clarification chose a before/after comparison, not a new standing target.

## R8 — Security verification method (clarified)

**Decision**: After the app is functionally upgraded and green, run the project `/security-review` over the branch. Resolve all High/Critical findings before completion; triage and document Medium/Low (resolved or explicitly accepted with rationale). Re-run the full suite after any remediation (FR-009, SC-007). Compare posture to pre-upgrade baseline (FR-010) — auth flow, HttpOnly cookies, session invalidation, JWT validation, dependency vulnerabilities (`npx expo-doctor`, dependency audit) must be no weaker.

**Rationale**: Matches the clarification; uses the existing security-review process; keeps a meaningful but non-noise-blocking gate.

**Alternatives considered**: Resolve-every-finding or only-upgrade-introduced — both rejected per the clarification decision.

## R9 — Dependency-conflict resolution policy (clarified)

**Decision**: If a current dependency has no SDK 56 / RN 0.85-compatible version and the conflict cannot be resolved without losing functionality or performance, HALT and escalate to a human for a documented decision per governance (FR-013). Do not drop functionality, weaken performance, or merge a partial upgrade unilaterally.

**Rationale**: Matches the clarification and the no-reduction constraint.

**Alternatives considered**: Silent replacement / partial upgrade — rejected per clarification.

## Open items requiring human decision (escalation candidates)

1. **Constitution amendment approval** (Expo SDK 55→56; possibly Node baseline) — required before code changes (FR-001/FR-014).
2. **Any irreconcilable dependency conflict surfaced by `expo install --fix`** — halt & escalate (FR-013).
