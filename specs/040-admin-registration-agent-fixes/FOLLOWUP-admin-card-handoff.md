# Handoff — Admin-settings entry point (profile card)

**Status:** not started. Fresh-session handoff.
**Branch:** cut a new branch off latest `main` (currently `b88b112`). Do NOT reuse the merged
`040-admin-registration-agent-fixes` branch (deleted).
**Origin:** follow-on to feature 040 US3. That feature built the admin self-registration toggle
screen but wired **no way to reach it** — an mc-admin can only get there by typing the URL
`/(app)/admin/settings`. This task adds the missing affordance.

## Goal

Add an **admin-only card on the Profile screen**, gated on `isAdmin`, that navigates to the existing
admin settings screen. Matching **web (Playwright) + mobile (Maestro) E2E**, per the CLAUDE.md
"Consistent E2E Tests Across Clients" rule. TDD: write the tests first (RED), then implement (GREEN).

Nothing about the admin *screen*, its route guard, or the BFF enforcement changes — this is purely the
entry point + its tests.

## Concrete facts (verified in-code 2026-07-17, cite before trusting)

### The pieces that already exist
- **Profile screen** — [profile-screen.tsx](../../frontend/mcm-app/src/screens/auth/profile-screen.tsx).
  Renders `<ProfileDisplay user onLogout />` then `<MovieAssistantConfig />` inside a `ScrollView`
  testID `profile-screen`. The admin card goes in this ScrollView (below `ProfileDisplay`, near
  `MovieAssistantConfig`). Note `content: { paddingBottom: 180 }` already exists so the last control
  clears the floating dock overlay — keep the card above that.
- **Profile route** — [profile.tsx](../../frontend/mcm-app/src/app/(app)/profile.tsx), nav tab
  `nav-profile` (`{ label: 'Profile', href: '/(app)/profile' }` in
  [navigation-bar.tsx](../../frontend/mcm-app/src/components/navigation-bar.tsx#L27)).
- **`isAdmin` helper** — already exists:
  [role-checker.ts](../../frontend/mcm-app/src/utils/role-checker.ts#L22) →
  `isAdmin(user)` = `user.roles.includes('mc-admin')`. Use this. `user` comes from
  `useAuth()` ([use-auth.tsx](../../frontend/mcm-app/src/hooks/use-auth.tsx)); `UserProfile.roles: string[]`.
- **DS Card** — `import { Card } from '@mcm/design-system'`
  ([Card.tsx](../../packages/design-system/components/surfaces/Card.tsx)). Pressable by default via
  `onPress`; `Card.Header` gives a `title`/`subtitle` row. Variants: `elevated | filled | outlined`.
- **Target screen** — [admin-settings-screen.tsx](../../frontend/mcm-app/src/screens/admin/admin-settings-screen.tsx),
  route `/(app)/admin/settings` (guarded `<ProtectedRoute requiredRole="mc-admin">`). Landing testID:
  `admin-settings-screen`; the toggle is `toggle-self-registration`.

### Navigation
- Web + mobile both use expo-router. Navigate with `router.push('/(app)/admin/settings')` from the
  card's `onPress` (import `useRouter` from `expo-router`).
- Give the card a stable testID, e.g. **`profile-admin-settings-card`** (used by both E2E clients —
  React Native Web renders `testID` → `data-testid`; Maestro matches `id:`).

### The one real blocker — admin identity for E2E (decide this first)
**There is NO pre-seeded mc-admin user anywhere.** Both `dev-realm.json` and `ci-realm.json` seed only
`e2e-test-user` (roles: `['mc-user']`) + two service accounts. So:

- **Negative case (mc-user does NOT see the card)** — trivial on both clients with the existing shared
  `e2e-test-user`.
- **Positive case (admin sees card → taps → lands on `admin-settings-screen`)** needs an mc-admin
  identity:
  - **Web:** SOLVED — feature 040 added a dynamic mint helper
    [keycloak-admin.ts](../../frontend/mcm-app/tests/e2e/web/setup/keycloak-admin.ts):
    `createUserWithRoles('e2e-admin', ['mc-user','mc-admin'])` + `deleteUser` + `E2E_ADMIN_PASSWORD`,
    gated by `keycloakAdminEnabled()` (needs `KEYCLOAK_SERVICE_CLIENT_SECRET`).
    [admin-registration.spec.ts](../../frontend/mcm-app/tests/e2e/web/admin-registration.spec.ts) is
    the worked example (mint an admin, `loginAs`, tear down in `afterAll`). Reuse that pattern.
  - **Mobile:** NOT solved. `_login-helper.yaml` logs in as `${MAESTRO_E2E_TEST_USER}` (mc-user only),
    and Maestro can't easily mint a user mid-flow. **Recommended:** add a seeded admin user
    (`e2e-admin-user`, roles `['mc-user','mc-admin']`) to **both** `dev-realm.json` and
    `ci-realm.json`, then wire `E2E_ADMIN_USER`/`E2E_ADMIN_PASSWORD` through
    [maestro-run.sh](../../scripts/maestro-run.sh) as `MAESTRO_`-prefixed env (feature 027 — secrets
    via env, never argv) + the app-ci job env, and add an admin variant of the login helper (or
    parameterize it). Confirm this approach before building — it touches the CI realm + secret wiring.
    A cheaper alternative if seeding is deemed out of scope: ship the mobile **negative** case only
    (mc-user sees no card) and cover the positive path on web, documenting the asymmetry — but this
    weakens the parity rule, so get sign-off.

## Suggested test placement (per CLAUDE.md Feature Branch Test Scope — 001-US3 access control)
- **Web:** `tests/e2e/web/auth.spec.ts` (owns profile/access-control), OR a small new
  `tests/e2e/web/admin-card.spec.ts`. If the positive case mints+logs-in a second identity, watch the
  isolation note in `playwright.config.ts` (the `lifecycle` dependent project) — but this card test
  does NOT toggle the global registration setting, so it likely does NOT need `lifecycle` isolation;
  a minted admin in its own context (like admin-registration's `beforeAll`) is enough. Verify.
- **Mobile:** extend `tests/e2e/mobile/home-screen.yaml` / `auth-guard.yaml` for the negative case;
  new `tests/e2e/mobile/admin-card.yaml` for the positive (drive in-app: log in → `nav-profile` →
  scroll to `profile-admin-settings-card` → tap → assert `admin-settings-screen`). If added to CI,
  register it in [ci-mobile-agent-flows.sh](../../scripts/ci-mobile-agent-flows.sh) only if it needs
  the agent stack (it does NOT — it's a plain nav flow, so it belongs with the regular mobile E2E
  suite `e2e:mobile`, not the agent-flows script). **Maestro tapOn gotcha (feature 040 lesson):**
  select the card by its `id:` (testID), not bare text — bare text can match a node behind an overlay.

## Also do
- **Unit test** the card's gating: renders for mc-admin, absent for mc-user (jest + RTL, alongside
  other component tests). Cheapest RED/GREEN and it runs in CI `affected`.
- Update the feature-040 **platform parity table** (or note this as a 040 follow-on) if you treat it
  as part of 040; otherwise a tiny new spec dir is overkill — a branch + PR is fine. Confirm with the
  user whether this needs its own SDD spec/plan/tasks or ships as a documented follow-on to 040.

## Test protocol reminders (CLAUDE.md)
- DinD dev container: read [devcontainer.md](../../docs/runbooks/devcontainer.md) first —
  `localhost:<published-port>`, Playwright-in-a-container `--network host`, re-apply the firewall
  (never allowlist), Anthropic (not Ollama) for any agent path (this task needs no agent).
- Run isolated test → user-story suite → full suite. Web E2E is required for every feature.
- RTK: `rtk init --global` once at session start.
