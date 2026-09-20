# Feature 074 — tasks

**Spec:** `specs/074-not-found-route/spec.md`  **Plan:** `specs/074-not-found-route/plan.md`
**Total: 6 tasks (T001–T006).**

Every test task follows the repository's TDD checkpoint format: **Verify RED** before the
implementation that satisfies it, **Verify GREEN** after. A checkpoint is not complete until the
stated command has been run and its output observed — a skipped test reads as a pass, so the SKIP
COUNT is part of what is observed.

---

## T001 — Unit test for `NotFoundScreen` (RED)

**Files:** `frontend/mcm-app/src/screens/not-found-screen.test.tsx` (new)

Covers US1-AC1, US1-AC2, US1-AC3 / FR-003, FR-004.

Assertions:
1. Renders a node with `testID="not-found-screen"`.
2. That node's text states the address was not found.
3. Exactly one affordance is offered, carrying `testID="not-found-home-link"`.
4. Pressing the affordance calls `router.replace('/(app)/home')` — mock `expo-router`'s
   `useRouter` as `frontend/mcm-app/src/screens/home/home-screen.test.tsx` does.

**Verify RED:** `pnpm nx test mcm-app --skip-nx-cache -- --testPathPattern not-found-screen`
Expect: failure on the unresolved import of `@/screens/not-found-screen`. Record the observed
failure. A pass here means the test is not testing what it claims.

---

## T002 — `NotFoundScreen` (GREEN for T001)

**Files:** `frontend/mcm-app/src/screens/not-found-screen.tsx` (new)

Satisfies FR-003, FR-004, FR-005, FR-006.

- Outer `View` from **`react-native`** carrying `testID="not-found-screen"` — host node, per
  plan §"Where the testID goes".
- `Card` / `CardHeader` / `CardContent` from `@mcm/design-system` for the surface and copy.
- `Text` from `@tamagui/core` for body copy, colour from `theme.onSurfaceVariant?.val`.
- One `Button` from `@mcm/design-system`, `testID="not-found-home-link"`, calling
  `router.replace('/(app)/home')`.
- `StyleSheet` carries layout only (`flex`, `padding: 16`). No colour literals, no ad-hoc spacing.

**Verify GREEN:** `pnpm nx test mcm-app --skip-nx-cache -- --testPathPattern not-found-screen`
Expect: all assertions pass, **0 skipped**.

---

## T003 — The two route files

**Files:**
- `frontend/mcm-app/src/app/+not-found.tsx` (new) — FR-001
- `frontend/mcm-app/src/app/(app)/+not-found.tsx` (new) — FR-002

Each is a route only: it imports `NotFoundScreen` and returns it, holding no screen content, per
the Screens-Layer rule. The `(app)` one reports UI state via `useReportUiState` as its sibling
routes do (`src/app/(app)/settings/backups.tsx` is the shape to copy); the root one does not,
because `useReportUiState` reports into authenticated app state that the root route is outside of.

**Verify:** `pnpm nx typecheck mcm-app --skip-nx-cache` and `pnpm nx lint mcm-app --skip-nx-cache`
both clean.

---

## T004 — Web E2E: the positive half of the "old addresses" cases (RED)

**Files:** `frontend/mcm-app/tests/e2e/web/settings.spec.ts` (edit)

Satisfies SC-002, SC-003. The `Settings — old addresses` describe block's two cases currently
assert only ABSENCE. **Keep every existing assertion** — they are what proves the addresses were
removed rather than redirected (FR-011 of feature 062) — and add to each:

- `not-found-screen` is visible.
- `nav-bar` (the `(app)` navigation bar) is present, proving the group's `+not-found` won
  resolution over the root one. This is the assertion plan §Risks names as the detector; do not
  weaken it if it fires — record the finding and fall back to the root-only route.

Add one further case for an address outside the group entirely (e.g. `/total-nonsense`):
`not-found-screen` is visible, and pressing `not-found-home-link` lands the user on the home route.

**Verify RED:** run the web E2E suite filtered to `settings.spec.ts` BEFORE T003 is merged into the
run, or by temporarily reverting T003 if the tasks are executed out of order. Expect the new
assertions to fail while no `+not-found` route exists.

---

## T005 — Verify GREEN across the touched tiers

No new files. Run, and observe the output of, every tier the diff touches:

1. `pnpm nx test mcm-app --skip-nx-cache` — full app unit suite, not just the new file. Check the
   SKIP COUNT, not only the pass count.
2. `pnpm nx lint mcm-app --skip-nx-cache`
3. `pnpm nx typecheck mcm-app --skip-nx-cache`
4. The web E2E suite covering `settings.spec.ts`.

SC-004: no test disabled, skipped or weakened. Confirm by reading the diff of
`settings.spec.ts`, not by assertion.

**A tier that could not be run is reported as not run** — not as a pass, and not as "this
environment cannot do it" without first naming the missing input and checking whether a generator
or documented command supplies it.

---

## T006 — Close backlog item #237

Only after T005's output has been observed and the acceptance criteria in item #237's body are each
met. Closure is an explicit act: verify, then close. If a criterion turned out to be wrong, edit it
and say why in a comment before closing.

`node scripts/backlog.mjs comment 237 --body-file <file>` then
`node scripts/backlog.mjs update 237 --state closed`.
