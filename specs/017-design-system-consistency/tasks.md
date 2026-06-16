---
description: "Task list — Design-System Consistency Remediation (017)"
---

# Tasks: Design-System Consistency Remediation

**Input**: Design documents from `specs/017-design-system-consistency/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/)

**Tests**: TDD is mandatory (constitution). The **static DS-compliance scan** (`tests/unit/design-system-compliance.test.ts`, rules R1–R5 from [contracts/compliance-rules.md](contracts/compliance-rules.md)) is the primary RED→GREEN driver — each rule is its own `it()`, so a user story turns its rule(s) GREEN. Paired with the DS success-token contrast test and the existing Playwright a11y/contrast audits.

**Gate path**: unit/DS/scan on Jest; web E2E only via the **dev-container** (Metro web bundler OOMs — see [quickstart.md](quickstart.md)). Mobile (Maestro) is **not** a gate for 017 (issue #16).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no incomplete-task dependency)
- **[Story]**: US1–US4 (user-story phases only)

---

## Phase 1: Setup

- [ ] T001 Confirm branch `017-design-system-consistency` is checked out and the dev-container backend stack is reachable (`docker compose --profile bff-dev up -d`); confirm the merged audit specs exist (`frontend/mcm-app/tests/e2e/web/{a11y,responsive,font-fallback,perf}.spec.ts`) and the DS unit suite runs (`pnpm nx test design-system`).
- [ ] T002 Re-baseline the stable-selector snapshot: regenerate the testID inventory from current `frontend/mcm-app/src` and confirm it matches the committed selector baseline (the 194-selector guard) — record the count to diff against at completion (FR-013/SC-006).

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ CRITICAL**: the success token, the font faces, and the compliance scan unblock all user stories.

### T003 — Write the static DS-compliance scan (RED driver)

**Type**: New file | **Time**: 1.5 hr | **Risk**: Low

**Spec reference**: spec.md (SC-001/002/003); [contracts/compliance-rules.md](contracts/compliance-rules.md)

**File(s)**: `frontend/mcm-app/tests/unit/design-system-compliance.test.ts`

Author the scan over `frontend/mcm-app/src/**` (exclude `bff-server`/`bff-api`/`tests`/`__mocks__`) with one `it()` per rule: **R1** no hardcoded colour (hex/`rgb`/`rgba`/`hsl`) outside the allowlist, **R2** every `fontSize` ∈ the scale set, **R3** text styles declare Outfit/Inter, **R4** no bespoke button outside the sanctioned allowlist, **R5** no duplicated agent pill-style block. The allowlist constant is derived from [contracts/sanctioned-deviations.md](contracts/sanctioned-deviations.md). Each failing `it()` prints `file:line — rule — snippet`.

**Verify RED**:
```bash
pnpm nx test mcm-app --skip-nx-cache -- --testPathPattern design-system-compliance
```
**Expected RED**: R1, R2, R3, R4, R5 all failing with the per-violation lists (the app is not yet compliant). R5 lists the 3 duplicated agent pill blocks.

> If any rule shows 0 violations now, its detection is too weak — fix the scan before migrating.

- [ ] T004 [P] Write the DS success-token contrast test in `packages/design-system/components/__tests__/success-token.test.tsx` (or colocated `theme.test.tsx`): assert `success`/`onSuccess`/`successContainer`/`onSuccessContainer` exist in `lightColors` + `darkColors`, resolve via `TamaguiProvider` under both themes, and meet AA (`success`-on-surface, `onSuccess`-on-success, `onSuccessContainer`-on-successContainer ≥ 4.5:1) in both themes — per [contracts/success-token.md](contracts/success-token.md). **Verify RED**: `pnpm nx test design-system --skip-nx-cache` → fails (roles absent).
- [ ] T005 Add the `success` green tonal ramp to `packages/design-system/tokens/palette.ts` and the four success roles to `lightColors`/`darkColors` in `packages/design-system/tokens/colors.ts` (light 40/100/90/10, dark 80/20/30/90), wire them into `lightTheme`/`darkTheme` in `packages/design-system/theme.ts` and the `colorTokens` map in `packages/design-system/tamagui.config.ts` (so `$success` resolves). **Verify GREEN**: T004 passes (tune tones if a contrast assertion fails).
- [ ] T006 [P] Add Inter SemiBold (600) + Inter Bold (700) faces to `packages/design-system/fonts/index.ts` (`interFont` `face` map) and to the app `useFonts` map in `frontend/mcm-app/src/app/_layout.tsx`, so declared Inter 600/700 weights render real faces (research D2). **Done when**: fonts load without warning and DS unit + app unit stay green.
- [ ] T007 [P] Export the success roles' types/usage note from the DS barrel if needed and update `packages/design-system` README token list to include `success`. **Done when**: `pnpm exec tsc --noEmit -p packages/design-system/tsconfig.json` is clean.

**Checkpoint**: success token live + AA-verified; Inter faces loaded; the scan is RED and itemised — user stories can begin.

---

## Phase 3: User Story 1 — Theme-faithful colour + success token (Priority: P1) 🎯 MVP

**Goal**: every screen renders theme colours in dark+light; positive/verified states use the new `success` role; no hardcoded colour literals remain.

**Independent Test**: toggle dark↔light across auth/home/collections/movie-detail/forms/loading; no white/wrong-colour flashes; verified + "Yes" states show the success colour; axe `color-contrast` = 0 violations both themes; scan **R1** GREEN.

### T008 — Extend the a11y audit to assert the success-state colour (RED)

**Type**: Test refactor | **Time**: 30 min | **Risk**: Low

**Spec reference**: spec.md#user-story-1 (US1-AC3); FR-002/SC-004

**File(s)**: `frontend/mcm-app/tests/e2e/web/a11y.spec.ts`

Add an assertion that the movie-detail Owned/Ripped "Yes" element resolves the success colour (the theme's `success` value) in both themes, and that the contrast scan remains 0 violations (already covered) — proving the literal was replaced by the token.

**Verify RED**:
```bash
E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app -- tests/e2e/web/a11y.spec.ts --grep "success"
```
**Expected RED**: 1 failing — the "Yes" colour is still the `#1b5e20`/`#68d391` literal, not `theme.success`.

- [ ] T009 [US1] Replace the movie-detail Owned/Ripped "Yes" literal greens (the `isLightSurface(...)` branch) with `theme.success?.val` in `frontend/mcm-app/src/components/movie-detail.tsx`; remove the now-dead `isLightSurface` helper. **Verify GREEN**: T008 passes.
- [ ] T010 [P] [US1] Replace the verified/success literals (`#68d391` + `rgba(56,161,105,…)`) with `theme.success?.val` (text) and `theme.successContainer?.val`/`onSuccessContainer` (banner) in `frontend/mcm-app/src/screens/auth/email-verification-screen.tsx` and `frontend/mcm-app/src/screens/auth/login-screen.tsx`.
- [ ] T011 [P] [US1] Theme the live escapes (add `useTheme()` where missing): `frontend/mcm-app/src/app/(auth)/login.tsx` + `register.tsx` container `#fff` → `theme.background?.val`; `frontend/mcm-app/src/screens/movies/new-movie-screen.tsx` `#fff` → `theme.background?.val`.
- [ ] T012 [P] [US1] Theme `frontend/mcm-app/src/components/loading-indicator.tsx`: spinner `#3182ce` → `theme.primary?.val`, message `#4a5568` → `theme.onSurfaceVariant?.val` (+ add `fontFamily:'Inter'`); theme `frontend/mcm-app/src/app/(auth)/native-auth-callback.tsx` (`#c00` → `theme.error?.val`, container bg + ActivityIndicator tint) and `frontend/mcm-app/src/app/auth-callback.tsx` (container bg + tint).
- [ ] T013 [P] [US1] Strip dead shadowed hex literals (keep the inline theme overrides) in `frontend/mcm-app/src/screens/home/home-screen.tsx`, `frontend/mcm-app/src/screens/collections/collection-screen.tsx`, `frontend/mcm-app/src/screens/movies/movie-detail-screen.tsx`, and `frontend/mcm-app/src/app/(app)/_layout.tsx` (research D6).
- [ ] T014 [US1] Re-point any unit test that now renders a `useTheme()` component to `@/test-support/render`; run `pnpm nx test mcm-app --skip-nx-cache` and fix any "must be used within TamaguiProvider".

### T015 — Make scan rule R1 GREEN (no hardcoded colour)

**Type**: Implementation (verification) | **Time**: 30 min | **Risk**: Low

**Prerequisite**: T009–T013 complete.

Run the scan; resolve any remaining R1 violation by tokenizing it or adding a justified entry to the allowlist ([contracts/sanctioned-deviations.md](contracts/sanctioned-deviations.md) § colour-utility) with a site comment.

**Verify GREEN**:
```bash
pnpm nx test mcm-app --skip-nx-cache -- --testPathPattern design-system-compliance -t "R1"
```
**Expected GREEN**: R1 `0 violations`.

- [ ] T016 [US1] Rebuild the dev-container image and run the US1 web-E2E regression: `pnpm nx docker-build mcm-app` → `docker compose --profile bff-dev up -d --force-recreate mcm-bff-dev` → `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app -- tests/e2e/web/a11y.spec.ts tests/e2e/web/auth.spec.ts tests/e2e/web/movies.spec.ts tests/e2e/web/theme.spec.ts`. **Expected**: green, axe contrast 0 violations both themes.

**Checkpoint**: US1 done — colour is theme-faithful + success-tokenised; R1 GREEN; MVP shippable.

---

## Phase 4: User Story 2 — Consistent typography (Priority: P2)

**Goal**: every font size on the MD3 scale; Outfit/Inter everywhere; weights map to loaded faces.

**Independent Test**: scan **R2** + **R3** GREEN; font-fallback audit still green; same-role text matches across screens.

- [ ] T017 [P] [US2] Snap off-scale sizes: `collection-card.tsx` title 17→16; `collection-screen.tsx` name 20→22; `collection-list.tsx` + `collection-list.native.tsx` empty heading 20→22; `home-screen.tsx` modal titles 20→22; `screens/auth/profile-display.tsx` heading 26→24; `agent/render-collection-summary.tsx` + `agent/render-movie-card.tsx` micro-label 10→11 (research D3).
- [ ] T018 [P] [US2] Add the missing `fontFamily`: `collection-screen.tsx` name → `'Outfit-Bold'`; `screens/movies/movie-detail-screen.tsx` backText → `'Inter-Medium'`; `collection-form.tsx` label + errorText → `'Inter'` (match `movie-form.tsx`). (loading-indicator message handled in T012.)
- [ ] T019 [P] [US2] Change the nav wordmark `fontWeight 800 → 700` in `frontend/mcm-app/src/components/navigation-bar.tsx` (Outfit-Bold is loaded; research D2).
- [ ] T020 [US2] Unify the section/column-header label treatment to Inter · 12 · weight 500 · `theme.primary?.val` · letterSpacing 0.5 across `frontend/mcm-app/src/components/movie-list.tsx` (web header) and `movie-list.native.tsx` (native header) (research D4, FR-012).

### T021 — Make scan rules R2 + R3 GREEN (typography)

**Type**: Implementation (verification) | **Time**: 20 min | **Risk**: Low

**Prerequisite**: T017–T020 complete.

**Verify GREEN**:
```bash
pnpm nx test mcm-app --skip-nx-cache -- --testPathPattern design-system-compliance -t "R2|R3"
```
**Expected GREEN**: R2 + R3 `0 violations`.

- [ ] T022 [US2] Rebuild image + run the font-fallback + a representative screen E2E: `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app -- tests/e2e/web/font-fallback.spec.ts tests/e2e/web/collections.spec.ts`. **Expected**: green.

**Checkpoint**: US2 done — typography on-scale + Outfit/Inter; R2/R3 GREEN.

---

## Phase 5: User Story 3 — Consistent design-system controls (Priority: P3)

**Goal**: every action is a DS component; one style per semantic action; agent pill de-duplicated; testIDs preserved.

**Independent Test**: scan **R4** + **R5** GREEN; selector baseline shows zero removed testIDs; primary/destructive/option controls identical across screens; web E2E green.

- [ ] T023 [P] [US3] Auth buttons → DS `Button` (preserve testIDs via `...rest`): `screens/auth/login-screen.tsx` login (`variant="filled"`) + create-account (`variant="outlined"`); `screens/auth/email-verification-screen.tsx` resend (`variant="outlined"`); `screens/auth/profile-display.tsx` logout (`variant="filled" danger`). Keep the `login-loading` ActivityIndicator behaviour (use Button `loading` or retain the spinner testID).
- [ ] T024 [P] [US3] `frontend/mcm-app/src/components/movie-detail.tsx`: Edit → DS `Button variant="outlined"`, Delete → DS `Button variant="filled" danger`; remove the bespoke `editButton`/`deleteButton` styles; preserve testIDs.
- [ ] T025 [US3] Agent action surfaces → DS `Button` and **de-duplicate the triplicated pill style**: `agent/approval-request.tsx` (Approve/Reject — evaluate DS `ApprovalBubble`; if testIDs can't be carried, use DS `Button` filled/outlined), `agent/import-preview.tsx` (Approve/Cancel), `agent/request-import-file.tsx` (Choose/Cancel via Button `loading` for "Uploading…"), `agent/render-movie-card.tsx` ("Add to collection"), `agent/assistant-dock.tsx` Send. Remove the shared private `button/approve/reject` style blocks. Keep all testIDs; keep the dock bottom-LEFT.
- [ ] T026 [P] [US3] `frontend/mcm-app/src/components/movie-form.tsx`: Add/Add-External-ID `TouchableOpacity` → DS `Button variant="filledTonal"`; owned-media + rip-quality multi-select chips → DS `Chip type="filter" selectedScheme="primary"`. (Radio selectors + removable list chips stay — sanctioned.)
- [ ] T027 [P] [US3] `frontend/mcm-app/src/components/movie-sort-control.tsx` dir ▲/▼ toggle → DS `IconButton`; `frontend/mcm-app/src/components/movie-filter-panel.tsx` "Clear Filters" → DS `Button variant="text"` (or `filledTonal`). Preserve testIDs.

### T028 — Make scan rules R4 + R5 GREEN (controls)

**Type**: Implementation (verification) | **Time**: 30 min | **Risk**: Medium

**Prerequisite**: T023–T027 complete.

Run the scan; any remaining bespoke pressable must either become a DS component or be added to the sanctioned-deviation allowlist with a rationale + site comment.

**Verify GREEN**:
```bash
pnpm nx test mcm-app --skip-nx-cache -- --testPathPattern design-system-compliance -t "R4|R5"
```
**Expected GREEN**: R4 + R5 `0 violations`.

- [ ] T029 [US3] Verify the selector baseline: regenerate the testID inventory and confirm **zero removed** vs T002 (FR-013/SC-006). Fix any dropped testID by forwarding it through the DS component.
- [ ] T030 [US3] Rebuild image + run the control-heavy web E2E: `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app -- tests/e2e/web/auth.spec.ts tests/e2e/web/movies.spec.ts tests/e2e/web/collections.spec.ts` and the agent specs if running with `E2E_AGENT_PRODUCTION=1`. **Expected**: green; no Save-button interception regressions.

**Checkpoint**: US3 done — all actions are DS components; R4/R5 GREEN; selectors intact.

---

## Phase 6: User Story 4 — Codify sanctioned deviations (Priority: P4)

**Goal**: the deliberate deviations are documented and preserved; the scan allowlist matches the catalogue.

**Independent Test**: a reviewer maps each preserved deviation to a rationale; the deviations are unchanged.

- [ ] T031 [P] [US4] Finalise [contracts/sanctioned-deviations.md](contracts/sanctioned-deviations.md) as the authoritative catalogue and ensure the scan's allowlist constant is generated from / kept in sync with it (single source). **Done when**: every allowlist entry has a catalogue rationale and vice-versa.
- [ ] T032 [P] [US4] Add a "Design-system compliance & sanctioned deviations" section to `frontend/mcm-app/README.md` summarising the rules (R1–R5), the success token, and the deviation catalogue with rationales. **Done when**: the section links the contracts and the compliance test.
- [ ] T033 [US4] Confirm SC-008: each sanctioned deviation (NoAutoFillInput, radios, mismatch orange, dock placement, web/native density, card/row wrappers, removable chips) is verifiably unchanged by this feature (diff review). **Done when**: a checklist in the PR description ticks each as unchanged.

**Checkpoint**: deviations codified + preserved.

---

## Phase 7: Polish & Final Validation

- [ ] T034 [P] Run the full static scan (all rules) `pnpm nx test mcm-app --skip-nx-cache -- --testPathPattern design-system-compliance` → **all GREEN** (SC-001/002/003).
- [ ] T035 [P] `pnpm exec tsc --noEmit` (app + DS), `pnpm nx lint mcm-app`, `pnpm nx lint design-system` → 0 errors; `pnpm nx test design-system` + `pnpm nx test mcm-app` → green (incl. success-token contrast).
- [ ] T036 Final dev-container web-E2E regression: rebuild image, `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app` → full suite green incl. a11y/responsive/font-fallback; axe contrast 0 violations both themes (SC-005/SC-007).
- [ ] T037 [P] `rtk gain` — confirm >80% test-command compression (run last).
- [ ] T038 Update the project memory + `specs/017-design-system-consistency/` status; reset the dev environment to Metro-only if desired.

---

## Platform Parity Table

Mobile (Maestro) is **not a gate** for 017 — the mobile-E2E CI harness is blocked on Keycloak provisioning (issue #16); all 017 verification is web (Playwright) + Jest scans. The changes are universal (web + native render the same restyled components), so native parity is covered structurally by the unit/scan gates, not a separate Maestro run.

| Scenario | Web (Playwright) | Mobile (Maestro) | Status |
|---|---|---|---|
| US1-AC1/AC2: theme-faithful colour (auth/loading) in dark+light | `a11y.spec.ts`, `auth.spec.ts`, `theme.spec.ts` | N/A — mobile-E2E CI blocked (issue #16); shared components, scan-covered | N/A |
| US1-AC3: verified/"Yes" uses success colour | `a11y.spec.ts` | N/A — issue #16 | N/A |
| US1-AC4 / SC-001: no hardcoded colour | `design-system-compliance.test.ts` (R1) | N/A — static scan, platform-agnostic | N/A |
| US2 / SC-002: on-scale fonts + Outfit/Inter | `design-system-compliance.test.ts` (R2/R3), `font-fallback.spec.ts` | N/A — static scan, platform-agnostic | N/A |
| US3 / SC-003: all actions DS components | `design-system-compliance.test.ts` (R4/R5), `auth.spec.ts`, `movies.spec.ts` | N/A — issue #16; shared components, scan-covered | N/A |
| SC-005: contrast AA dark+light | `a11y.spec.ts` (axe) | N/A — web-only axe tooling | N/A |
| SC-006: selectors preserved | selector-baseline guard | N/A — shared testIDs, web-asserted | N/A |

> Every mobile cell is N/A with a written justification (issue #16 + the changes being shared universal components verified by platform-agnostic scans). No `❌ Gap` rows → no resolution task required.

---

## Completion Checklist

Before marking `017-design-system-consistency` complete, verify all success criteria from [spec.md](spec.md):

- [ ] **SC-001**: zero hardcoded colour literals outside the allowlist (scan R1 GREEN)
- [ ] **SC-002**: zero off-scale fonts; 100% text declares Outfit/Inter (scan R2/R3 GREEN)
- [ ] **SC-003**: 100% actions are DS components; no duplicated bespoke control (scan R4/R5 GREEN)
- [ ] **SC-004**: success role is the sole positive-state colour, AA both themes (DS token test)
- [ ] **SC-005**: axe contrast 0 violations on every restyled screen, dark+light (`a11y.spec.ts`)
- [ ] **SC-006**: zero removed testIDs vs the selector baseline
- [ ] **SC-007**: DS unit + app unit + full web E2E pass unchanged
- [ ] **SC-008**: sanctioned-deviation catalogue published; each deviation verifiably unchanged
- [ ] Platform parity table complete — no ❌ gaps (all mobile cells justified N/A per issue #16)
- [ ] All test tasks used the TDD checkpoint format (Verify RED confirmed before implementation)
- [ ] `pnpm nx test design-system` + `pnpm nx test mcm-app` — green (≥70% coverage)
- [ ] `pnpm nx lint mcm-app` + `pnpm nx lint design-system` — no errors
- [ ] `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app` — web E2E passes
- [ ] `pnpm exec tsc --noEmit` (app + DS) — types clean
- [ ] `rtk gain` — >80% compression confirmed (run last)

---

## Dependencies & Execution Order

- **Setup (T001–T002)** → no deps.
- **Foundational (T003–T007)** → BLOCKS all stories (success token + faces + scan). T003 (scan RED) and T004→T005 (token RED→GREEN) first; T006/T007 [P].
- **US1 (T008–T016, P1)** → after Foundational. The MVP.
- **US2 (T017–T022, P2)** → after Foundational; independent of US1 (different style attributes/files), parallelizable with US1 if staffed.
- **US3 (T023–T030, P3)** → after Foundational; the largest; mostly [P] across files but T028/T029/T030 serialize the verification.
- **US4 (T031–T033, P4)** → after US3 (allowlist reflects the final control set).
- **Polish (T034–T038)** → after all desired stories.

### Parallel opportunities

- Foundational: T006, T007 [P] after T005.
- US1: T010, T011, T012, T013 [P] (different files); T009 gated by T008.
- US2: T017, T018, T019 [P]; T020 then verify.
- US3: T023, T024, T026, T027 [P]; T025 (agent cluster) is one larger task; then T028→T029→T030.

## Implementation Strategy

**MVP = US1** (P1 colour + success token): the only user-visible bugs. Complete Setup + Foundational + US1, validate dark/light + contrast, and it's shippable on its own. Then US2 (typography), US3 (controls), US4 (codify) incrementally — each turns its scan rule(s) GREEN without regressing the prior.
