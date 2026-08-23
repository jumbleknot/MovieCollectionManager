# Phase 0 Research: Settings destination with sub-navigation

**Feature**: `062-settings-split` | **Date**: 2026-08-23

Every decision below is grounded in a file that was read, not recalled. Where the backlog item
stated an expectation that the code contradicts, the measurement is recorded rather than the
expectation.

---

## R1 — The old addresses are removed, not redirected

**Decision**: Delete `src/app/(app)/profile.tsx` and `src/app/(app)/admin/settings.tsx`. Both
paths fall through to Expo Router's built-in unmatched-route handling.

**Rationale**: Operator decision, 2026-08-23, taken against the measured context that
`app/(app)/admin/settings.tsx` had no in-app affordance at all until `admin-settings-card.tsx` was
added as a follow-on to feature 040 — so realistic bookmarks to it are close to zero. The app is
not publicly linked. Two redirect stubs would be permanent dead code guarding a hypothetical.

**Accepted consequence**: an existing bookmark to either address breaks with no forwarding.

**Alternatives rejected**:
- *Redirect both* — the safe default, and the one recommended when the question was put. Rejected
  by the operator on the reach argument above.
- *Redirect `/profile` only* — splits the rule in two for no measured benefit.

**Follow-on noted, not taken**: `src/app/` has no `+not-found.tsx`, so an unmatched route renders
Expo Router's default unmatched screen rather than a branded one. That is pre-existing and applies
to every mistyped URL, not just these two; adding a branded not-found screen is a separate concern
and belongs in the backlog, not in a navigation refactor.

---

## R2 — Four distinct screen labels, and the BFF owns the vocabulary

**Decision**: Each sub-page reports its own label — `settings`, `settings-assistant`,
`settings-backups`, `settings-admin`. All four are added to `ALLOWED_SCREENS` in
`frontend/mcm-app/src/bff-server/ui-state-sanitizer.ts`; `profile` and the never-allowlisted
`admin-settings` are retired.

**Rationale**: Operator decision, 2026-08-23. Distinct labels let the assistant later tailor help
per settings area at no cost now.

**Measured correction to the backlog item.** Item #235 warns that "gateway-side names must be
updated in lockstep, or the resolution tests will say so." Searching
`agents/movie-assistant/src/` for screen names returns exactly one consumer:
`nodes/organizer.py:1120`, `_COLLECTION_SCREENS = frozenset({"collection", "movie-detail"})`, plus
the `movie-detail` check at line 1167. The string `profile` appears nowhere in gateway source. So:

- The gateway needs **no source change**. `test_current_screen_contract.py` and
  `test_context_resolution.py` exercise only `collection` and `movie-detail`.
- The real contract owner is the **BFF sanitizer allowlist**, which is where the change lands.
- The gateway's Python unit tier is still run — as evidence for that claim, not as a formality.

**Two pieces of pre-existing drift this closes.** `app/(app)/profile.tsx` calls
`useReportUiState` not at all, so the pre-split settings destination reported nothing. And
`app/(app)/admin/settings.tsx` reports `admin-settings`, which is **not** in `ALLOWED_SCREENS` and
is therefore silently reduced to `unknown` on every visit. Both are corrected here.

**Alternatives rejected**:
- *One shared `settings` label* — smaller diff, but the assistant could not distinguish the
  configuration page from the backups page, which is precisely the distinction the split creates.
- *Report nothing, fix only the allowlist drift* — leaves the assistant blind on the destination
  the user visits to configure the assistant.

---

## R3 — The sub-navigation extends the design system's `Tabs`, and closes its `testID` gap there

**Decision**: `components/settings/settings-nav.tsx` composes `Tabs` from `@mcm/design-system`.
`Tabs` gains an optional `testID` on `TabItem`, rendered on a React Native host node.

**Rationale**: The constitution requires all UI to be composed from the design system, and that new
components extend it rather than bypass it. But `Tabs.tsx` renders each tab as a Tamagui `View`
carrying `onPress` — and a Tamagui component does **not** forward `testID` to `data-testid` on
React Native Web. This is the identical limitation that `admin-settings-card.tsx` documents for the
design system's `Card`, and it is why that card wraps its `Card` in a plain RN `Pressable` that
carries the `testID` and the `onPress`. Playwright resolves `data-testid`
(`playwright.config.ts: testIdAttribute`), so without a host node there is no selector for a tab.

Fixing it inside `Tabs` — rather than hand-rolling a tab row in app code — is what "extend, don't
bypass" means. `Tabs` has **no consumer in the app today** (searched: only its own
`navigation.test.tsx`), so this feature is its first, and the change is additive and low-blast-radius.

**Alternatives rejected**:
- *A bespoke tab row in app code using `StyleSheet`* — an explicit constitution violation
  (ad-hoc styling bypassing the design system) and it would duplicate the indicator animation.
- *Wrap each `Tabs` tab in a `Pressable` from the app side* — impossible; `Tabs` owns the mapping
  over `tabs` internally.
- *Select tabs by accessible role/name instead of testID* — `accessibilityRole="tab"` is already
  present and will work for Playwright, but Maestro's selector story is weaker and the
  constitution names `data-testid` first. Both remain available; the testID is the contract.

---

## R4 — Route group with a nested `Stack`, not a tab navigator

**Decision**: `src/app/(app)/settings/_layout.tsx` renders `SettingsNav` above
`<Stack screenOptions={{ headerShown: false }} />`, mirroring the shape of `(app)/_layout.tsx`
one level down. Navigation between areas is `router.navigate` from the sub-navigation.

**Rationale**: It matches the structure already in the codebase, keeps each area a real route with
its own address (the whole point of the feature), and needs no new dependency. The nested `Stack`
must be wrapped in a `flex: 1` `View` for the same reason `(app)/_layout.tsx` documents: React
Native Web's absolutely-positioned screen containers collapse to zero height without an explicit
parent height, clipping all content.

**Alternatives rejected**:
- *Expo Router `Tabs` navigator* — renders a bottom tab bar, which collides visually with the
  assistant dock overlay and reads as a second primary navigation next to the top app bar.
- *One route with client-side section state* — fails FR-002 outright: no distinct addresses,
  no deep linking, and the follow-on backups feature could not be linked to.

---

### AMENDED during implementation — `Slot`, not a nested `Stack`

**Superseded**: `settings/_layout.tsx` renders `<Slot />`, not `<Stack />`. The directory route,
the group layout, and `SettingsNav` above the routed area are all unchanged.

> **CORRECTION (run 2043).** An earlier version of this note claimed the nested `Stack` was the
> CAUSE of a native failure. **That was wrong, and the claim is withdrawn.** Replacing it with a
> `Slot` did not fix the failure: run 2043 failed the same flow 3/3, now on `settings-nav` —
> the sub-navigation itself, which sits ABOVE the routed area and cannot be starved of height by
> whatever renders the child. The two runs together say the whole settings subtree fails to mount
> on native, and neither the navigator nor the layout height is why.
>
> The change is kept on its own merits (below), not as a fix. The real cause is still open, and is
> being pursued with device-side evidence rather than a third hypothesis — see the diagnostics note
> at the end of this section.

**Why it looked like the suspect.** A nested `Stack` made `settings/` the **first nested navigator
in the app** — `collections/[collectionId]/` is a directory route with **no** `_layout.tsx`, so its
children flatten into the `(app)` Stack. R4 introduced a structure with no working native precedent
here, and the failure was native-only, structural and 100% reproducible. That reasoning was
plausible and it was still a guess; it cost a CI cycle and did not hold.

**A `Slot` is also the better primitive, not merely the fix.** The settings areas are a tab row
navigated with `router.replace` — they deliberately keep no history of their own. A stack
navigator exists to provide push/pop history and native screen transitions, and this row wants
neither. R4's own rationale ("it matches the structure already in the codebase") was the weakest
of its arguments; the load-bearing ones — a directory route with a group layout, each area a real
address — are untouched.

**Verified after the change**: the full web gate tier still passes (165 tests, 0 failed, 0
skipped), including the cold deep-load of a sub-page address — so the swap costs nothing on web. `Slot` could have silently broken
the per-area `useFocusEffect` that reports each screen label, and nothing asserted that, so
`settings.spec.ts` gained a case that intercepts `/bff-api/agent/ui-state` and asserts `settings`,
`settings-backups` and `settings-assistant` each reach the wire.

**Alternative rejected**: reverting to the nested `Stack` once it was clear the swap fixed nothing.
Rejected because the navigator earns nothing here — its history and transitions are both unwanted —
so restoring it would re-add an unnecessary component for symmetry with a superseded plan.

---

### What is ruled OUT so far, and how

Recorded so the next reader does not re-walk these:

| Hypothesis | Ruled out by |
| --- | --- |
| The settings routes are missing from the commit | `git ls-files` — all 5 route files, the component and the 3 screens are tracked |
| The APK is stale / built from an older commit | Build log names `…-release-f3014ab.apk`, and `nav-settings` (this branch only) is tappable on the device |
| A stale Metro cache omitted the new route directory | The build clears `metro-cache` + `metro-file-map` and runs `expo prebuild --clean` |
| The routes are not bundled for native | `expo export --platform android` locally: the Hermes bundle contains `settings-nav`, `settings-profile-screen`, `settings-assistant-screen`, `settings-backups-screen`, `nav-settings` and 5 occurrences of `(app)/settings` |
| `SettingsNav`/`Tabs` throw under the React Native renderer | `settings-nav.test.tsx` renders both under jest-expo (the RN renderer, not RNW) — 9 tests pass |
| The routed area is starved of height by the sub-navigation | Run 2043: `settings-nav` ITSELF is not visible, and it is the parent of nothing |
| It only affects the web build | CI's own web tier ran all 165 tests green on the same commit |

**Still open**: why the subtree does not mount on the device. The remaining channels — Maestro's
view hierarchy and the emulator's `adb logcat` — were both unreachable from a session, so
`scripts/ci-mobile-agent-flows.sh` now captures them into `mobile-diagnostics/`, which the
workflow folds into the `container-logs` failure bundle that
`node scripts/ci-status.mjs failure --run <id> --full` can retrieve. That gap is why two cycles
produced hypotheses instead of an answer.

---

## R5 — Directory-based routing, because of a trap already documented in this repo

**Decision**: `settings/` is a directory route with a `_layout.tsx`, never a `settings.tsx` file
route.

**Rationale**: `openwiki/gotchas/expo-router-collection-routing.md` records the same trap for
`collections/[collectionId]/`: a file route cannot host nested children, so children beneath it do
not inherit the parent layout. A `settings.tsx` file route would make the sub-navigation
impossible to render above the children.

---

## R6 — Admin visibility is presentation; the route guard is the enforcement

**Decision**: `SettingsNav` filters the admin entry with `isAdmin(user)` from
`utils/role-checker`. `settings/admin.tsx` independently wraps its screen in
`ProtectedRoute requiredRole="mc-admin"`. Both are tested, separately.

**Rationale**: `openwiki/gotchas/role-enforcement-is-a-layer.md` and the constitution's
Centralized Access Control principle. `ProtectedRoute` is a thin wrapper over `AuthGuard`, so the
guard is the same layer every other protected surface uses — not a per-screen `if`. The test that
matters is the direct-URL one: a non-admin who never saw the entry must still be refused.

**Rejected**: relying on the hidden entry alone. That is security by absence of a link, and the
deleted `admin-settings-card.tsx` is the standing proof that a link's absence is not access
control — the screen was fully reachable by URL for an entire feature cycle before the card existed.

---

## R7 — `AssistantConfigProvider` does not move

**Decision**: It stays in `src/app/(app)/_layout.tsx`.

**Rationale**: The provider deliberately wraps **both** the `Stack` (which now renders the
assistant configuration form two levels down) and `AuthedAssistant` (the dock gate), so that saving
the form refreshes the dock's availability in the same session with no reload. Moving it into
`settings/_layout.tsx` would put the form inside the provider and the dock outside it, silently
breaking that in-session refresh — a regression that no unit test would catch and only the
`assistant-config-*` E2E flows would surface.

---

## R8 — E2E scope, measured

**Decision**: All 20 affected spec files are updated in this change; none is skipped or weakened.

**Measured**: searching for `nav-profile`, `profile-screen`, `(app)/profile`,
`profile-admin-settings-card`, and `admin-settings` across `frontend/mcm-app/tests/e2e/` returns
64 hits across 20 files — 5 web (`admin-card`, `admin-registration`, `assistant-config`, `auth`,
`bff-prod-lifecycle`) and 15 mobile.

Most hits are one navigation step (`nav-profile` → `nav-settings`) or one landing assertion
(`profile-screen` → `settings-profile-screen`). Two need real rework, because the affordance they
test is the one being deleted:

- `tests/e2e/web/admin-card.spec.ts` and `tests/e2e/mobile/admin-card.yaml` assert on
  `profile-admin-settings-card`. They become tests of the sub-navigation entry: an admin sees
  `settings-nav-admin` and reaches `admin-settings-screen`; a non-admin does not, **and** is
  refused at `/(app)/settings/admin` directly. The direct-URL half is new coverage the card-based
  test never had.

**On the instrument, not just the result**: a skipped E2E test reads as a pass. The verification
in `quickstart.md` uses `MCM_REQUIRE_LIVE_STACK=1` and watches the skip count, per
`docs/runbooks/e2e-testing.md`.
