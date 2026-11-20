/**
 * Theme toggle web E2E (feature 015, US4 — T036).
 *
 * Verifies the dark/light theming contract (FR-004 / FR-005 / SC-003 / Contract 2):
 *   1. First load defaults to DARK (no stored preference).
 *   2. The app-bar theme toggle flips the whole app to LIGHT.
 *   3. The choice PERSISTS across a full page reload.
 *
 * Robust signal: the toggle's accessibilityLabel (rendered as aria-label on web)
 * reflects the *next* action — "Switch to light theme" while dark, "Switch to dark
 * theme" while light — so the assertions don't depend on brittle colour values.
 *
 * Uses the authenticated session inherited from global setup (the app bar only
 * exists on the authenticated (app) routes).
 */
import { test, expect } from './fixtures/worker-session';
import { type Page } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './setup/target';

const DARK_LABEL = 'Switch to light theme'; // shown while dark is active
const LIGHT_LABEL = 'Switch to dark theme'; // shown while light is active

async function gotoHome(page: Page): Promise<void> {
  await page.goto(`${BASE}/home`);
  const result = await Promise.race([
    page
      .waitForSelector('[data-testid="home-screen-create-button"]', {
        state: 'visible',
        timeout: 60000,
      })
      .then(() => 'home' as const),
    page
      .waitForSelector('[data-testid="collection-screen-add-movie"]', {
        state: 'visible',
        timeout: 60000,
      })
      .then(() => 'collection' as const),
  ]).catch(() => null);

  if (result === 'collection') {
    await page.goto(`${BASE}/home`);
    await page.waitForSelector('[data-testid="home-screen-create-button"]', {
      state: 'visible',
      timeout: 60000,
    });
    return;
  }
  if (!result) {
    throw new Error('gotoHome: home screen did not render — is the global-setup session valid?');
  }
}

test.describe('Theme toggle + persistence', () => {
  // Leave the shared session in dark so later specs start from the default (FR-004).
  test.afterEach(async ({ page }) => {
    await page.evaluate(() => window.localStorage.removeItem('mcm.theme')).catch(() => {});
  });

  test('defaults to dark, toggles to light, and persists across reload', async ({ page }) => {
    await gotoHome(page);

    const toggle = page.getByTestId('theme-toggle');
    await expect(toggle).toBeVisible();

    // 1. Dark default — the toggle offers to switch *to light*.
    await expect(toggle).toHaveAttribute('aria-label', DARK_LABEL);

    // 2. Toggle → light applied.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-label', LIGHT_LABEL);
    const stored = await page.evaluate(() => window.localStorage.getItem('mcm.theme'));
    expect(stored).toBe('light');

    // 3. Reload — light persists.
    await page.reload();
    await gotoHome(page);
    await expect(page.getByTestId('theme-toggle')).toHaveAttribute('aria-label', LIGHT_LABEL);
  });

  test('toggles back to dark and persists', async ({ page }) => {
    await gotoHome(page);
    const toggle = page.getByTestId('theme-toggle');

    // Start light, then switch back to dark.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-label', LIGHT_LABEL);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-label', DARK_LABEL);

    const stored = await page.evaluate(() => window.localStorage.getItem('mcm.theme'));
    expect(stored).toBe('dark');

    await page.reload();
    await gotoHome(page);
    await expect(page.getByTestId('theme-toggle')).toHaveAttribute('aria-label', DARK_LABEL);
  });
});

// Item #243: React Navigation paints each navigator's screen container with its own theme. With none
// supplied that is its LIGHT default, rgb(242, 242, 242), whatever the app theme — a bright band in
// dark mode wherever a layout does not paint over it. Walks every painted ancestor of a routed screen.
const RN_LIGHT_DEFAULT = 'rgb(242, 242, 242)';
const DS_LIGHT_BACKGROUND = 'rgb(253, 251, 255)'; // lightColors.background, #FDFBFF

async function ancestorBackgrounds(page: Page, testId: string): Promise<string[]> {
  return page.getByTestId(testId).evaluate((el) => {
    const out: string[] = [];
    for (let n: Element | null = el; n; n = n.parentElement) {
      const bg = getComputedStyle(n).backgroundColor;
      if (bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') out.push(bg);
    }
    return out;
  });
}

test.describe('Navigator container follows the app theme (item #243)', () => {
  test.afterEach(async ({ page }) => {
    await page.evaluate(() => window.localStorage.removeItem('mcm.theme')).catch(() => {});
  });

  test('no ancestor of a routed screen keeps React Navigation’s light default, in either theme', async ({
    page,
  }) => {
    await page.goto(`${BASE}/(app)/settings`);
    const screen = page.getByTestId('settings-profile-screen');
    await expect(screen).toBeVisible({ timeout: 30000 });
    const toggle = page.getByTestId('theme-toggle');
    await expect(toggle).toHaveAttribute('aria-label', DARK_LABEL);

    // Dark (the default).
    const dark = await ancestorBackgrounds(page, 'settings-profile-screen');
    expect(dark.length, 'dark: at least one painted ancestor').toBeGreaterThan(0);
    expect(dark, 'dark: a navigator container is painted with the light default').not.toContain(
      RN_LIGHT_DEFAULT,
    );

    // Light, switched at runtime — no reload — so the container must repaint with the theme.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-label', LIGHT_LABEL);
    await expect
      .poll(() => ancestorBackgrounds(page, 'settings-profile-screen'), {
        message: 'light: the navigator container repaints with the design-system light surface',
      })
      .toContain(DS_LIGHT_BACKGROUND);
    expect(await ancestorBackgrounds(page, 'settings-profile-screen')).not.toContain(
      RN_LIGHT_DEFAULT,
    );
  });
});
