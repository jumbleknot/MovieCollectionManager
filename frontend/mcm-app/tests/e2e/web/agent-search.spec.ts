/**
 * T065/T074 (web E2E, 013 US7 + US10): the unified movie-search workflow.
 *
 * Drives the full live stack IN-APP from /home (research R15 — never deep-load a non-home route
 * before driving the dock): CopilotKit dock → BFF /run → production-node gateway → search node
 * (pure-code resolution) → render_selection / navigate_to_movie / render_movie_card.
 *
 * AC8  — a named-collection single match navigates straight to the movie detail.
 * AC9/AC10 + US10 — no owned match → control buttons → "Search the web" → a TMDB preview card that
 *                   carries a clickable themoviedb.org link (US10/FR-031) and an add affordance.
 *
 * Requires the FULL agent stack + E2E_AGENT_PRODUCTION=1.
 * Run: node scripts/agent-e2e.mjs agent-search
 */

import { test, expect, type Page } from '@playwright/test';

import { E2E_BASE_URL as BASE } from './setup/target';
import { FIXTURE_COLLECTIONS } from '../fixtures/base-dataset';
import { cleanupNonFixtureCollections } from './setup/e2e-cleanup';

const ACTION_TIMEOUT = 180_000;
const BROWSE = FIXTURE_COLLECTIONS.BROWSE; // 'E2E Browse'

async function gotoHome(page: Page): Promise<void> {
  await page.goto(`${BASE}/home`);
  await page.waitForSelector('[data-testid="home-screen-create-button"]', {
    state: 'visible',
    timeout: 60000,
  });
}

async function openDock(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="assistant-dock-toggle"]', {
    state: 'visible',
    timeout: 60000,
  });
  await page.click('[data-testid="assistant-dock-toggle"]');
  await page.waitForSelector('[data-testid="assistant-dock-panel"]', {
    state: 'visible',
    timeout: 10000,
  });
}

async function send(page: Page, text: string): Promise<void> {
  await page.fill('[data-testid="assistant-dock-input"]', text);
  await page.click('[data-testid="assistant-dock-send"]');
}

test.describe('Assistant unified search workflow (013 US7 + US10)', () => {
  test.skip(
    process.env['E2E_AGENT_PRODUCTION'] !== '1',
    'Needs the production-node gateway. Run with E2E_AGENT_PRODUCTION=1.',
  );

  test.afterEach(async ({ request }) => {
    await cleanupNonFixtureCollections(request);
  });

  test('a named-collection single match navigates to the movie detail (US7-AC8)', async ({
    page,
  }) => {
    test.setTimeout(360_000);
    await gotoHome(page);
    await openDock(page);

    // "Alpha" is a unique title in the BROWSE fixture → the search resolves it and navigates.
    await send(page, `find Alpha in my ${BROWSE} collection`);
    await page.waitForURL(/\/collections\/[^/]+\/movies\/[^/]+/, { timeout: ACTION_TIMEOUT });
    expect(page.url()).toMatch(/\/movies\//);
  });

  test('no owned match → "Search the web" → a TMDB preview card with a clickable link (US7-AC10/US10)', async ({
    page,
  }) => {
    test.setTimeout(420_000);
    await gotoHome(page);
    await openDock(page);

    // "Inception" is NOT in the fixture → owned search misses → workflow control buttons.
    await send(page, `find Inception in my ${BROWSE} collection`);
    const options = page.locator('[data-testid="selection-options"]').last();
    await expect(options).toBeVisible({ timeout: ACTION_TIMEOUT });
    // No write proposed (read-only search).
    await expect(page.locator('[data-testid="approval-request"]')).toHaveCount(0);

    // Tap "Search the web" control → TMDB results. A common title returns several results
    // (render_selection web buttons) — pick the first; a single result renders the card directly.
    await options.getByText('Search the web', { exact: false }).first().click();
    const card = page.locator('[data-testid="render-movie-card"]').last();
    const webPick = page.locator('[data-testid="selection-option-pick-0"]').last();
    await expect(card.or(webPick)).toBeVisible({ timeout: ACTION_TIMEOUT });
    if (await webPick.isVisible()) {
      await webPick.click();
    }
    await expect(card).toBeVisible({ timeout: ACTION_TIMEOUT });

    // US10: the web card carries a clickable themoviedb.org link + an "Add to collection" button.
    await expect(card.locator('[data-testid="render-movie-card-url"]')).toBeVisible();
    await expect(card.locator('[data-testid="render-movie-card-add"]')).toBeVisible();
    // Still read-only — nothing added without confirmation.
    await expect(page.locator('[data-testid="approval-request"]')).toHaveCount(0);
  });
});
