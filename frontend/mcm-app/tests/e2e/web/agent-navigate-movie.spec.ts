/**
 * T047 (web E2E, 013 US6): navigate to a specific MOVIE across the user's collections.
 *
 * "open <movie>" with no collection named → the supervisor routes `navigate` → the navigator
 * resolves the movie across ALL the user's collections in pure code (longest-match + (title,year)
 * tie-break) → emits navigate_to_movie → the client authorizes the structural target at the BFF
 * ui-action-authorizer → expo-router lands on that movie's detail screen.
 *
 * Drives the full live stack: CopilotKit dock → BFF /run → production-node gateway → Ollama
 * intent classify → navigator → movie-mcp list_collections/list_movies → UI-action dispatch →
 * BFF /bff-api/agent/ui-action authorize → router.push.
 *
 * IMPORTANT (research R15): the dock is driven IN-APP from /home (the allowed home deep-load);
 * the navigate action is the only route change (router.push) — never deep-load a collection first.
 *
 * Requires the FULL agent stack + E2E_AGENT_PRODUCTION=1.
 * Run: node scripts/agent-e2e.mjs agent-navigate-movie
 */

import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

import { E2E_BASE_URL as BASE } from './setup/target';
import { cleanupNonFixtureCollections } from './setup/e2e-cleanup';

const ACTION_TIMEOUT = 180_000;
const NAV_TIMEOUT = 60_000;

// A deliberately unique, ≥4-char, multi-word title so it resolves uniquely across every
// collection (including the BROWSE fixture) and can't shadow / be shadowed by another title.
const UNIQUE_TITLE = 'Zephyrine Protocol';

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
    data: movieBody(title, 2021),
  });
  expect(m.ok()).toBeTruthy();
  return { collectionId, movieId: (await m.json()).movieId as string };
}

async function gotoHome(page: Page): Promise<void> {
  await page.goto(`${BASE}/home`);
  await page.waitForSelector('[data-testid="home-screen-create-button"]', {
    state: 'visible',
    timeout: 60000,
  });
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

test.describe('Assistant navigate to a movie (013 US6)', () => {
  test.skip(
    process.env['E2E_AGENT_PRODUCTION'] !== '1',
    'Needs the production-node gateway. Run with E2E_AGENT_PRODUCTION=1.',
  );

  test.afterEach(async ({ request }) => {
    await cleanupNonFixtureCollections(request);
  });

  test('navigate → opens the named movie detail, resolved across collections (US6-AC1)', async ({
    page,
    request,
  }) => {
    test.setTimeout(360_000);
    const collectionName = `us6-nav-${Date.now()}`;
    const { collectionId, movieId } = await seedMovie(request, collectionName, UNIQUE_TITLE);

    await gotoHome(page);
    await openDock(page);
    // 013 US7 (New Scope 1): the unified search SCOPES to the named collection (Bug 1 — it no
    // longer sums/searches across all). Name the collection so the search resolves there + opens
    // the movie. (A bare "open X" resolves to the default/current/only collection by design.)
    await send(page, `open ${UNIQUE_TITLE} in ${collectionName}`);

    // The search workflow resolved the movie in the named collection and router.push landed on it.
    await page.waitForURL(new RegExp(`/collections/${collectionId}/movies/${movieId}`), {
      timeout: ACTION_TIMEOUT,
    });
    await expect(page.locator('[data-testid="movie-detail-title"]')).toContainText(UNIQUE_TITLE, {
      timeout: NAV_TIMEOUT,
    });
  });
});
