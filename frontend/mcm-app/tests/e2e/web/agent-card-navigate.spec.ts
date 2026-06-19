/**
 * T030 (web E2E, 013 US3 + US7): tapping an assistant search result opens that movie's detail screen.
 *
 * Ask about an in-collection movie ("do I have <title> in my <collection>") → the supervisor routes
 * it to the SEARCH node (013 US7 owns all "find"/"do I have"), which finds the single owned match
 * and offers it as a render_selection button (013 "New Scope 1": even one match is a button, never
 * auto-navigated and never a bare render_movie_card) → tapping the result button navigates to that
 * movie's exact detail screen (carrying the resolved movieId + collectionId).
 *
 * This is the precise deep-link assertion (exact movieId/collectionId URL + movie-detail-title) for
 * the find→open journey; the broader single-match-button + web-fallback behavior is in
 * agent-search.spec.ts.
 *
 * Drives the full live stack: CopilotKit dock → BFF /run → production-node gateway → Ollama
 * intent classify → search node → movie-mcp list_movies → render_selection → button tap → navigate.
 *
 * IMPORTANT (research R15): the dock is driven IN-APP from /home; the tap is the only route
 * change — never deep-load the collection before driving the dock.
 *
 * Requires the FULL agent stack + E2E_AGENT_PRODUCTION=1.
 * Run: node scripts/agent-e2e.mjs agent-card-navigate
 */

import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

import { E2E_BASE_URL as BASE } from './setup/target';
import { cleanupNonFixtureCollections } from './setup/e2e-cleanup';

const CARD_TIMEOUT = 180_000;
const NAV_TIMEOUT = 60_000;

const UNIQUE_TITLE = 'Quasar Meridian';

function movieBody(title: string, year: number): Record<string, unknown> {
  return {
    title, year, contentType: 'Movie', language: 'English',
    owned: true, ripped: false, childrens: false,
    ownedMedia: [], ripQuality: [], genres: ['Action'], rated: 'PG-13',
    directors: [], actors: [], tags: [],
    movieSet: null, originalTitle: null, releaseDate: null,
    outline: null, plot: null, runtime: null, externalIds: [],
  };
}

async function seedMovie(
  request: APIRequestContext,
  name: string,
  title: string,
): Promise<{ collectionId: string; movieId: string }> {
  const c = await request.post('/bff-api/collections', { data: { name } });
  expect(c.ok()).toBeTruthy();
  const collectionId = (await c.json()).collectionId as string;
  const m = await request.post(`/bff-api/collections/${collectionId}/movies`, {
    data: movieBody(title, 2020),
  });
  expect(m.ok()).toBeTruthy();
  return { collectionId, movieId: (await m.json()).movieId as string };
}

async function gotoHome(page: Page): Promise<void> {
  await page.goto(`${BASE}/home`);
  await page.waitForSelector('[data-testid="home-screen-create-button"]', { state: 'visible', timeout: 60000 });
}

async function openDock(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="assistant-dock-toggle"]', { state: 'visible', timeout: 60000 });
  await page.click('[data-testid="assistant-dock-toggle"]');
  await page.waitForSelector('[data-testid="assistant-dock-panel"]', { state: 'visible', timeout: 10000 });
}

async function send(page: Page, text: string): Promise<void> {
  await page.fill('[data-testid="assistant-dock-input"]', text);
  await page.click('[data-testid="assistant-dock-send"]');
}

test.describe('Assistant clickable movie card (013 US3)', () => {
  test.skip(
    process.env['E2E_AGENT_PRODUCTION'] !== '1',
    'Needs the production-node gateway. Run with E2E_AGENT_PRODUCTION=1.',
  );

  test.afterEach(async ({ request }) => {
    await cleanupNonFixtureCollections(request);
  });

  test('tap the in-collection search result → lands on that movie detail (US3-AC1/AC2)', async ({
    page,
    request,
  }) => {
    test.setTimeout(360_000);
    const name = `us3-card-${Date.now()}`;
    const { collectionId, movieId } = await seedMovie(request, name, UNIQUE_TITLE);

    await gotoHome(page);
    await openDock(page);
    await send(page, `do I have ${UNIQUE_TITLE} in my ${name} collection`);

    // The search node offers the single owned match as a result button (013 "New Scope 1") —
    // never auto-navigated, never a bare card.
    const options = page.locator('[data-testid="selection-options"]').last();
    await expect(options).toBeVisible({ timeout: CARD_TIMEOUT });
    await expect(page).not.toHaveURL(/\/movies\//);

    // Tapping the result button deep-links to the exact movie's detail screen.
    await page.locator('[data-testid="selection-option-pick-0"]').last().click();
    await page.waitForURL(new RegExp(`/collections/${collectionId}/movies/${movieId}`), {
      timeout: NAV_TIMEOUT,
    });
    await expect(page.locator('[data-testid="movie-detail-title"]')).toContainText(UNIQUE_TITLE, {
      timeout: NAV_TIMEOUT,
    });
  });
});
