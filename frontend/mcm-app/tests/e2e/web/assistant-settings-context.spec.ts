/**
 * Web E2E — the assistant clarifies while the user is in settings (feature 062, T031).
 *
 * FR-015, spec.md Edge Cases. This feature adds four labels to the screen-label vocabulary
 * (`settings`, `settings-assistant`, `settings-backups`, `settings-admin`). None of them appears
 * in the gateway's `_COLLECTION_SCREENS` (`{"collection", "movie-detail"}`), so the assistant has
 * no collection in view on a settings area and must ASK rather than act on a stale target.
 *
 * This is the assertion that the new vocabulary did not accidentally teach the assistant to
 * resolve "this" somewhere it never could before. research.md §R2 claims the gateway needs no
 * change; the Python tier is evidence for the claim's premise, and this is evidence for its
 * consequence at the seam where the two meet.
 *
 * THE FILENAME MATTERS, NOT ONLY THE TAG. `scripts/__tests__/agent-test-classification.test.mjs`
 * scans only files matching `^(agent|assistant)-.*\.spec\.ts$`. The same test living in
 * settings.spec.ts would carry its `@model-decision` tag UNENFORCED — nothing would fail if the
 * tag were later removed, which is exactly the silent default that guard exists to prevent. The
 * `assistant-` prefix also groups it with the specs gated on E2E_AGENT_PRODUCTION, which this
 * test needs and settings.spec.ts does not set.
 *
 * Requires the FULL agent stack + E2E_AGENT_PRODUCTION=1.
 * Run: E2E_AGENT_PRODUCTION=1 pnpm exec playwright test assistant-settings-context
 */

import { test, expect } from './fixtures/worker-session';
import { type Page } from '@playwright/test';

import { E2E_BASE_URL as BASE } from './setup/target';

const CLARIFY_TIMEOUT = 120_000;

// 'Coherence' (2013), and the year, for the same reason assistant-context.spec.ts uses it: it
// resolves to a SINGLE TMDB result. MEASURED with 'Heat' first — the assistant clarified, but
// about which FILM ("Heat (1995), The Heat (2013), Red Heat (1988)…"), so a title ambiguity
// masked the collection ambiguity actually under test. One unknown at a time.
const MOVIE_TITLE = 'Coherence';

async function openDock(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="assistant-dock-toggle"]', { state: 'visible', timeout: 60000 });
  await page.click('[data-testid="assistant-dock-toggle"]');
  await page.waitForSelector('[data-testid="assistant-dock-panel"]', { state: 'visible', timeout: 10000 });
}

test.describe('Assistant reference resolution inside settings (feature 062)', () => {
  test.skip(
    process.env['E2E_AGENT_PRODUCTION'] !== '1',
    'Needs the production-node gateway. Run with E2E_AGENT_PRODUCTION=1.',
  );

  test('"add <movie> to this" on a settings area asks the user to clarify', { tag: '@model-decision' }, async ({ page }) => {
    test.setTimeout(300_000);

    // Boot on home so the dock initializes, then navigate IN-APP to a settings area — the same
    // path assistant-context.spec.ts documents (a fresh deep-load remounts the app tree and
    // resets the dock, a deep-load-only quirk that does not affect the real UX).
    await page.goto(`${BASE}/home`);
    await page.waitForSelector('[data-testid="home-screen-create-button"]', { state: 'visible', timeout: 60000 });
    await openDock(page);

    await page.click('[data-testid="nav-settings"]');
    await page.waitForSelector('[data-testid="settings-profile-screen"]', { state: 'visible', timeout: 30000 });
    await page.click('[data-testid="settings-nav-backups"]');
    await page.waitForSelector('[data-testid="settings-backups-screen"]', { state: 'visible', timeout: 30000 });

    await page.fill('[data-testid="assistant-dock-input"]', `add the movie ${MOVIE_TITLE} (2013) to this`);
    await page.click('[data-testid="assistant-dock-send"]');

    // `settings-backups` resolves no collection target, so the assistant clarifies — it never
    // guesses and never acts on a target left over from an earlier screen.
    await expect(page.locator('[data-testid="assistant-msg-assistant"]').last()).toContainText(
      /which collection/i,
      { timeout: CLARIFY_TIMEOUT },
    );
    await expect(page.locator('[data-testid="approval-request"]')).toHaveCount(0);
  });
});
