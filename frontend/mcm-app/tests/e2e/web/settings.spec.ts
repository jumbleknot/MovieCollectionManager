/**
 * Web E2E — the settings destination and its sub-navigation (feature 062).
 *
 * FR-001, FR-002, FR-004, FR-007, FR-011, FR-017, FR-018.
 *
 * This file carries the assertions that only a real DOM can make. In particular the
 * "sub-navigation is locatable" case is the ONE check that tells a React Native host node from
 * a Tamagui component: a testID on a Tamagui component passes the design system's jest suite
 * (jest-expo renders React Native, not React Native Web) and still emits no `data-testid` on
 * web. The Tabs change in T004 is not finished until this case passes.
 */
import { test, expect } from './fixtures/worker-session';

import { E2E_BASE_URL as BASE } from './setup/target';

test.describe('Settings destination', () => {
  test('the app bar offers Settings, and no Profile destination remains', async ({ page }) => {
    await page.goto(`${BASE}/home`);
    await expect(page.getByTestId('home-route')).toBeVisible({ timeout: 60000 });

    const settings = page.getByTestId('nav-settings');
    await expect(settings).toBeVisible({ timeout: 15000 });
    await expect(settings).toHaveText('Settings');
    await expect(page.getByTestId('nav-profile')).toHaveCount(0);
  });

  test('selecting Settings lands on the Profile area with the sub-navigation above it', async ({ page }) => {
    await page.goto(`${BASE}/home`);
    await expect(page.getByTestId('home-route')).toBeVisible({ timeout: 60000 });

    await page.getByTestId('nav-settings').click();

    await expect(page).toHaveURL(/\/settings$/, { timeout: 20000 });
    await expect(page.getByTestId('settings-profile-screen')).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId('settings-nav')).toBeVisible();
    await expect(page.getByTestId('profile-display')).toBeVisible();
  });

  test('sub-navigation is locatable', async ({ page }) => {
    await page.goto(`${BASE}/(app)/settings`);
    await expect(page.getByTestId('settings-profile-screen')).toBeVisible({ timeout: 30000 });

    // THE DISCRIMINATING ASSERTION (T004). If the per-tab testID landed on the Tamagui View
    // instead of the RN host node, this resolves nothing on web while jest stays green.
    const assistantEntry = page.getByTestId('settings-nav-assistant');
    await expect(assistantEntry).toBeVisible({ timeout: 15000 });

    await assistantEntry.click();

    await expect(page).toHaveURL(/\/settings\/assistant$/, { timeout: 20000 });
    await expect(page.getByTestId('assistant-config')).toBeVisible({ timeout: 30000 });
    // The sub-navigation survives the switch — it lives in the group layout, not the screen.
    await expect(page.getByTestId('settings-nav')).toBeVisible();
  });

  /**
   * FR-013 / data-model.md §2 — each area reports its OWN screen label to the assistant.
   *
   * Asserted on the wire rather than inferred. The label is what the BFF sanitizer allowlists and
   * the assistant reads, and nothing else in the suite proves an area actually SENDS one: the
   * assistant-clarifies test passes whether the label is `settings-backups` or `unknown`, because
   * neither resolves a collection. The report rides `useFocusEffect`, so it is precisely what the
   * group layout's routing primitive can silently break.
   */
  test('each settings area reports its own screen label to the BFF', async ({ page }) => {
    const reported: string[] = [];
    await page.route('**/bff-api/agent/ui-state', async (route) => {
      try {
        const body = route.request().postDataJSON() as { current_screen?: string };
        if (body?.current_screen) reported.push(body.current_screen);
      } catch {
        /* a non-JSON body is not what this test is about */
      }
      await route.continue();
    });

    await page.goto(`${BASE}/(app)/settings`);
    await expect(page.getByTestId('settings-profile-screen')).toBeVisible({ timeout: 30000 });
    await expect.poll(() => reported, { timeout: 20000 }).toContain('settings');

    await page.getByTestId('settings-nav-backups').click();
    await expect(page.getByTestId('settings-backups-screen')).toBeVisible({ timeout: 30000 });
    await expect.poll(() => reported, { timeout: 20000 }).toContain('settings-backups');

    await page.getByTestId('settings-nav-assistant').click();
    await expect(page.getByTestId('settings-assistant-screen')).toBeVisible({ timeout: 30000 });
    await expect.poll(() => reported, { timeout: 20000 }).toContain('settings-assistant');

    // Nothing outside the allowlisted vocabulary rode this channel.
    expect(reported.every((s) => /^(home|collection|movie-detail|settings(-assistant|-backups|-admin)?)$/.test(s))).toBe(true);
  });

  /**
   * contracts/ui-contract.md §5. Each entry must announce as a tab AND announce which one is
   * current. Asserted HERE and not in the design system's jest suite, because it cannot be
   * asserted there: React Native's Pressable folds `aria-selected` into `accessibilityState` and
   * strips the aria prop, so the RN renderer never sees it. Measured on feature 062: role="tab"
   * reached the DOM while `aria-selected` was null on every entry — assistive technology was told
   * what the elements were and never which was current.
   */
  test('each sub-navigation entry announces as a tab and announces which is current', async ({ page }) => {
    await page.goto(`${BASE}/(app)/settings`);
    await expect(page.getByTestId('settings-profile-screen')).toBeVisible({ timeout: 30000 });

    for (const id of ['settings-nav-profile', 'settings-nav-assistant', 'settings-nav-backups']) {
      await expect(page.getByTestId(id)).toHaveAttribute('role', 'tab');
    }
    await expect(page.getByTestId('settings-nav-profile')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('settings-nav-assistant')).toHaveAttribute('aria-selected', 'false');

    await page.getByTestId('settings-nav-assistant').click();
    await expect(page.getByTestId('settings-assistant-screen')).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId('settings-nav-assistant')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('settings-nav-profile')).toHaveAttribute('aria-selected', 'false');
  });

  /**
   * FR-007, SC-006, US3-AC1/AC2. The Backups area is a placeholder with no capability behind it,
   * so what is worth asserting is that it is a REAL addressable route rather than a dead entry:
   * it renders, and navigation works away from it and back.
   */
  test('the Backups area renders its placeholder and navigates both ways', async ({ page }) => {
    await page.goto(`${BASE}/(app)/settings`);
    await expect(page.getByTestId('settings-profile-screen')).toBeVisible({ timeout: 30000 });

    await page.getByTestId('settings-nav-backups').click();
    await expect(page).toHaveURL(/\/settings\/backups$/, { timeout: 20000 });
    await expect(page.getByTestId('settings-backups-screen')).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId('settings-backups-screen')).toContainText(/not yet available/i);
    await expect(page.getByTestId('settings-nav')).toBeVisible();

    // Away…
    await page.getByTestId('settings-nav-assistant').click();
    await expect(page.getByTestId('settings-assistant-screen')).toBeVisible({ timeout: 30000 });
    // …and back. A dead entry would fail one of these two directions.
    await page.getByTestId('settings-nav-backups').click();
    await expect(page.getByTestId('settings-backups-screen')).toBeVisible({ timeout: 30000 });
  });

  test('a cold load of a settings area address renders that area directly', async ({ page }) => {
    // COLD: no in-app navigation first. This is what FR-018/SC-002 actually require, and it is
    // the case a client-side section-state design would fail.
    await page.goto(`${BASE}/(app)/settings/assistant`);

    await expect(page.getByTestId('settings-assistant-screen')).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId('assistant-config')).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId('settings-nav')).toBeVisible();
    // It landed on the assistant area, not on the Profile area first.
    await expect(page.getByTestId('settings-profile-screen')).toHaveCount(0);
  });
});

/**
 * FR-011 — the pre-split addresses are REMOVED, not redirected (research.md §R1, an operator
 * decision taken against the measured fact that the admin address had no in-app affordance at
 * all until the card that this feature deletes).
 *
 * Each case asserts BOTH halves: no settings shell AND no pre-split content. The second half is
 * what makes it a real test — while profile.tsx still exists the address renders ProfileDisplay,
 * so the assertion fails for the right reason instead of passing because nothing was ever there.
 */
test.describe('Settings — old addresses', () => {
  test('the pre-split profile address renders neither the settings shell nor profile content', async ({ page }) => {
    await page.goto(`${BASE}/(app)/profile`);

    await expect(page.getByTestId('settings-nav')).toHaveCount(0);
    await expect(page.getByTestId('settings-profile-screen')).toHaveCount(0);
    // The half that could fail while profile.tsx still existed: the old route rendered this.
    await expect(page.getByTestId('profile-display')).toHaveCount(0);
    // And the address is unmatched rather than redirected — the operator decision in §R1.
    await expect(page).toHaveURL(/\/profile$/, { timeout: 15000 });
  });

  test('the pre-split admin-settings address is unmatched, not merely refused', async ({ page }) => {
    await page.goto(`${BASE}/(app)/admin/settings`);

    await expect(page.getByTestId('settings-nav')).toHaveCount(0);
    await expect(page.getByTestId('admin-settings-screen')).toHaveCount(0);

    // THE DISCRIMINATING ASSERTION, and the reason the two above are not enough. This session
    // is a non-admin, so `admin-settings-screen` is absent whether the route was REMOVED or
    // merely REFUSED — asserting its absence alone passes vacuously and proves nothing about
    // FR-011. What separates the two is the URL: a route that still exists bounces a non-admin
    // to the login screen via ProtectedRoute → AuthGuard's `router.replace`, while a route that
    // has been deleted leaves the address alone and falls through to unmatched handling.
    // Red until T024 deletes the route; do not weaken it to go green sooner.
    await expect(page).toHaveURL(/\/admin\/settings$/, { timeout: 15000 });
  });
});
