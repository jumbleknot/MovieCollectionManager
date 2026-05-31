# Quickstart: Expo SDK 55 → 56 Upgrade Runbook

This is the operator runbook for executing and verifying the upgrade. All commands run from the repo root unless noted. Shell is PowerShell; a Bash shell is also available. RTK must be active for the session (`rtk gain` > 80% after test runs).

> **Hard ordering rule (FR-001 / SC-001): documentation-first.** Do NOT touch `package.json` or source until the constitution and `CLAUDE.md` are amended, committed, and the constitution amendment is human-approved.

## 0. Pre-flight — capture baselines (before any change)

```powershell
# Bring up infra and confirm the app is green on SDK 55 FIRST (this is the regression + perf baseline)
pnpm nx up-all infrastructure-as-code
pnpm nx test mcm-app
pnpm nx test:integration mcm-app
pnpm nx e2e mcm-app                  # web E2E — record per-flow timings as the perf baseline
pnpm nx e2e:mobile mcm-app          # Android E2E — record per-flow timings as the perf baseline
pnpm nx test mc-service
pnpm nx test:integration mc-service
```

Save the critical-flow timings (login, browse collections, browse/search movies, add/edit/delete movie, logout) for web and Android — these are the SC-006 baseline (≤10% regression allowed post-upgrade).

## 1. Documentation-first (governing docs)

1. Amend `.specify/memory/constitution.md`: Expo SDK 55 → 56, replace the `default@sdk-55` create command, update React Native / React / Node version statements, add a version-history entry with rationale. **Obtain human approval (FR-014) before proceeding.**
2. Update `CLAUDE.md` version references.
3. Commit these as the first commits on the branch (ordering must be visible in git history — SC-001).

## 2. Upgrade dependencies (frontend/mcm-app)

```powershell
cd frontend/mcm-app
npx expo install expo@latest        # moves Expo to SDK 56
npx expo install --fix              # aligns all expo-* + RN ecosystem peers to SDK 56
cd ../..
pnpm install                        # regenerate root lockfile across the workspace
```

If `expo install --fix` reports an irreconcilable conflict that would lose functionality/performance → **HALT and escalate** (FR-013). Do not force-resolve.

## 3. Diagnostics + housekeeping

```powershell
cd frontend/mcm-app
npx expo-doctor
```

- Delete `babel.config.js` (only contains `babel-preset-expo`).
- Remove confirmed-implicit deps from `package.json` (verify each: keep `expo-constants` if imported at runtime).
- Confirm `app.json` has no stale `sdkVersion` / `newArchEnabled`.
- (Optional, zero-risk confirmation) `npx expo-codemod sdk-56-expo-router-react-navigation-replace src` — expected no-op (no `@react-navigation` imports).

## 4. Reconcile native Android (RN 0.85)

```powershell
cd frontend/mcm-app
npx expo prebuild --platform android --clean   # regenerate android/ for RN 0.85 (review the diff before commit)
cd android; ./gradlew clean; cd ..
```

Review the `android/` diff for any intentional local customizations before committing. No `ios/` reconciliation (not a target).

## 5. Type-check, lint, fix deprecations

```powershell
cd frontend/mcm-app; pnpm exec tsc --noEmit; cd ../..
pnpm nx lint mcm-app
```

Address any SDK 56 deprecation/removal surfaced by the type-checker or lint (FR-008). Fix genuine regressions in the app, never by weakening tests (FR-006).

## 6. Verify — tiered test protocol (constitution Test Run Protocol)

```powershell
# 1) isolated failing tests first (as they surface), then:
pnpm nx test mcm-app                 # unit (≥70% coverage)
pnpm nx test:integration mcm-app     # BFF integration vs real Keycloak/Redis/mc-service
pnpm nx e2e mcm-app                  # web E2E (Playwright)
pnpm nx e2e:mobile mcm-app          # Android E2E (Maestro)
pnpm nx test mc-service              # backend unaffected — must still pass
pnpm nx test:integration mc-service
```

Mobile E2E prerequisites (per CLAUDE.md): emulator booted, `adb reverse tcp:8081 tcp:8081`, Metro started from `frontend/mcm-app`.

## 7. Performance gate (SC-006)

Re-capture the Step 0 critical-flow timings on the upgraded build (web + Android). **Fail if any flow regresses > 10%** vs its pre-upgrade baseline. Investigate and remediate before completion (no perf reduction allowed — FR-007).

## 8. Security gate (FR-009 / SC-007)

Run the project security review over the branch; resolve all **High/Critical** findings; triage + document **Medium/Low** (resolve or accept with rationale). Re-run the full suite after any remediation. Confirm posture ≥ pre-upgrade (auth, cookies, session invalidation, JWT validation, dependency audit) — FR-010.

## 9. Finish documentation (FR-011 / SC-002 / SC-003)

Search all project docs for superseded version references and update them:

```powershell
# (RTK-friendly) sweep for stale references across docs
pnpm exec rg -n "SDK 55|sdk-55|0\.83|react-native.*0\.83" --glob "**/*.md"
```

Update READMEs, `docs/**`, and any historical `specs/**` "current version" statements. **Zero** remaining references to Expo SDK 55 / RN 0.83.x as the current baseline.

## Definition of Done (maps to Success Criteria)

- [ ] Constitution + `CLAUDE.md` amended and committed BEFORE first code commit; amendment human-approved (SC-001, FR-001/FR-014)
- [ ] Expo SDK 56, RN 0.85, React 19.2 pinned; lockfile regenerated (FR-002/FR-003)
- [ ] `npx expo-doctor` clean; housekeeping applied (FR-008)
- [ ] Android native reconciled; app builds + runs on emulator (FR-004)
- [ ] 100% existing tests pass: unit, integration, web E2E, mobile E2E, mc-service (SC-004)
- [ ] 0 functional regressions on web + Android critical flows (SC-005)
- [ ] No critical flow regresses > 10% (SC-006)
- [ ] Security review: 0 unresolved High/Critical; Medium/Low documented; suite green post-remediation (SC-007)
- [ ] 0 new end-user features (SC-008)
- [ ] 0 stale version references in documentation (SC-002/SC-003)
- [ ] `rtk gain` > 80% after test runs
