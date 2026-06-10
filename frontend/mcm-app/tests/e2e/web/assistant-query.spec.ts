/**
 * T071g (web E2E): Query your collection by conversation — the US4 read journey end-to-end.
 *
 * count / list / find-in-collection, all answered from the user's OWN seeded collection:
 *   - "how many movies are in my <name> collection" → the assistant answers the real count.
 *   - "what's in my <name> collection"             → render_collection_summary + the titles.
 *   - "do I have <seeded> in my <name> collection" → render_movie_card (a true hit).
 *   - "do I have <absent> in my <name> collection" → "<title> isn't in your <name> collection"
 *     (≠ the external TMDB no-match copy — FR-024; this is about THEIR collection).
 * Plus a US1 no-regress guard: a BARE "look up <title>" still ENRICHES (curator → TMDB preview),
 * proving the query intent didn't swallow external look-ups.
 *
 * Read-only: no approval gate, no writes, no navigation. Drives the full live stack: CopilotKit
 * dock → BFF /run → production-node gateway → Ollama intent+extraction → movie-mcp
 * count/list_movies → mc-service. Verified through the BFF.
 *
 * Requires the FULL agent stack (HANDOFF.md) + E2E_AGENT_PRODUCTION=1 (host gateway :8123 with
 * the T071 query node) AND a mc-service image carrying the /movies/count endpoint (T071b). Each
 * test seeds its own collection via the BFF and tears it down.
 *
 * Run: E2E_AGENT_PRODUCTION=1 pnpm nx e2e mcm-app -- tests/e2e/web/assistant-query.spec.ts
 */

import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

import { E2E_BASE_URL as BASE } from './setup/target';
import { cleanupNonFixtureCollections } from './setup/e2e-cleanup';

const ANSWER_TIMEOUT = 150_000;

function movieBody(title: string): Record<string, unknown> {
  return {
    title,
    year: 1999,
    contentType: 'Movie',
    language: 'English',
    owned: true,
    ripped: false,
    childrens: false,
    ownedMedia: [],
    ripQuality: [],
    genres: ['Sci-Fi'],
    rated: 'R',
    directors: [],
    actors: [],
    tags: [],
    movieSet: null,
    originalTitle: null,
    releaseDate: null,
    outline: null,
    plot: null,
    runtime: null,
    externalIds: [],
  };
}

async function seedCollection(
  request: APIRequestContext,
  name: string,
  titles: string[],
): Promise<string> {
  const res = await request.post('/bff-api/collections', { data: { name } });
  expect(res.ok()).toBeTruthy();
  const collectionId = (await res.json()).collectionId as string;
  for (const title of titles) {
    const m = await request.post(`/bff-api/collections/${collectionId}/movies`, {
      data: movieBody(title),
    });
    expect(m.ok()).toBeTruthy();
  }
  return collectionId;
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

function lastAssistantMsg(page: Page) {
  return page.locator('[data-testid="assistant-msg-assistant"]').last();
}

test.describe('Assistant query flow (feature 012, US4 / T071)', () => {
  test.skip(
    process.env['E2E_AGENT_PRODUCTION'] !== '1',
    'Needs the production-node host gateway (:8123). Run with E2E_AGENT_PRODUCTION=1.',
  );

  test.afterEach(async ({ request }) => {
    await cleanupNonFixtureCollections(request);
  });

  test('count → the assistant answers the real number of movies', async ({ page, request }) => {
    test.setTimeout(360_000);
    const name = `t071-q-${Date.now()}`;
    await seedCollection(request, name, ['Zorgon', 'Blarnix', 'Quaffle']);

    await gotoHome(page);
    await openDock(page);
    await send(page, `how many movies are in my ${name} collection`);

    // Exactly the three seeded movies, read server-side (count endpoint).
    await expect(lastAssistantMsg(page)).toContainText('3 movie', { timeout: ANSWER_TIMEOUT });
  });

  test('list → render_collection_summary + the seeded titles', async ({ page, request }) => {
    test.setTimeout(360_000);
    const name = `t071-q-${Date.now()}`;
    await seedCollection(request, name, ['Zorgon', 'Blarnix', 'Quaffle']);

    await gotoHome(page);
    await openDock(page);
    await send(page, `what's in my ${name} collection`);

    await expect(page.locator('[data-testid="render-collection-summary"]').last()).toBeVisible({
      timeout: ANSWER_TIMEOUT,
    });
    await expect(lastAssistantMsg(page)).toContainText('Zorgon');
  });

  test('find hit → render_movie_card for a movie that IS in the collection', async ({
    page,
    request,
  }) => {
    test.setTimeout(360_000);
    const name = `t071-q-${Date.now()}`;
    await seedCollection(request, name, ['Zorgon', 'Blarnix', 'Quaffle']);

    await gotoHome(page);
    await openDock(page);
    await send(page, `do I have Zorgon in my ${name} collection`);

    const card = page.locator('[data-testid="render-movie-card"]').last();
    await expect(card).toBeVisible({ timeout: ANSWER_TIMEOUT });
    await expect(card.locator('[data-testid="render-movie-card-title"]')).toContainText('Zorgon');
  });

  test('find miss → "isn\'t in your <name> collection" (not the external no-match)', async ({
    page,
    request,
  }) => {
    test.setTimeout(360_000);
    const name = `t071-q-${Date.now()}`;
    await seedCollection(request, name, ['Zorgon', 'Blarnix', 'Quaffle']);

    await gotoHome(page);
    await openDock(page);
    await send(page, `do I have Inception in my ${name} collection`);

    await expect(lastAssistantMsg(page)).toContainText("isn't in your", { timeout: ANSWER_TIMEOUT });
    await expect(lastAssistantMsg(page)).toContainText(name);
  });

  test('no-regress: a bare "look up <title>" still ENRICHES (external preview)', async ({
    page,
    request,
  }) => {
    test.setTimeout(360_000);
    // Seed a collection so the user is in a normal state; the look-up is NOT scoped to it.
    const name = `t071-q-${Date.now()}`;
    await seedCollection(request, name, ['Zorgon']);

    await gotoHome(page);
    await openDock(page);
    await send(page, 'look up the movie Inception');

    // Routed to the curator (enrich), which renders a TMDB preview card — proves the query
    // intent did not swallow an external look-up (US1 no-regress).
    await expect(page.locator('[data-testid="render-movie-card"]').last()).toBeVisible({
      timeout: ANSWER_TIMEOUT,
    });
    await expect(lastAssistantMsg(page)).toContainText('Inception');
  });
});
