/**
 * Font-fallback audit — web (feature 015, T043; FR-017 / SC-006).
 *
 * Simulates a font-load failure by aborting every web-font request (Outfit/Inter
 * .ttf/.woff + the Google Fonts hosts), then asserts the app still renders legibly
 * with the system fallback — no blank screen, no crash, no layout break. This proves
 * the non-blocking `useFonts` wiring in app/_layout.tsx (a font failure never gates
 * the first paint).
 */
import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './setup/target';

const FONT_PATTERNS = [
  '**/*.ttf',
  '**/*.otf',
  '**/*.woff',
  '**/*.woff2',
  'https://fonts.googleapis.com/**',
  'https://fonts.gstatic.com/**',
];

test.describe('font-fallback (FR-017 / SC-006)', () => {
  test('home renders with the system fallback when web fonts fail to load', async ({ page }) => {
    let aborted = 0;
    for (const pat of FONT_PATTERNS) {
      await page.route(pat, (route) => {
        aborted += 1;
        return route.abort();
      });
    }

    await page.goto(`${BASE}/home`);

    // The app must still reach an interactive authenticated screen despite the font failure.
    const ready = await Promise.race([
      page.waitForSelector('[data-testid="home-screen-create-button"]', { state: 'visible', timeout: 60000 }).then(() => true),
      page.waitForSelector('[data-testid="collection-screen-add-movie"]', { state: 'visible', timeout: 60000 }).then(() => true),
    ]).catch(() => false);
    expect(ready, 'authenticated screen did not render with fonts blocked').toBe(true);

    // The app bar (and its theme toggle) must be present — proves chrome rendered, not just a spinner.
    await expect(page.getByTestId('theme-toggle')).toBeVisible();

    // Some real text content is on screen (legible fallback, not a blank/unstyled void).
    const visibleText = await page.evaluate(() => (document.body.innerText || '').trim().length);
    expect(visibleText, 'no visible text rendered under font failure').toBeGreaterThan(0);

    // eslint-disable-next-line no-console
    console.log(`[T043] font requests aborted: ${aborted}; app rendered with system fallback.`);
  });
});
