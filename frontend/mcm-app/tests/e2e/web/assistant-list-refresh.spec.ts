/**
 * T072 (web E2E): the on-screen list refreshes after an assistant write — no manual reload.
 *
 * Bug: after the assistant applied a write (e.g. "add <movie> to this"), the collection's movie
 * list already on screen stayed stale until the user re-navigated, because `useFocusEffect` does
 * not re-fire while the screen stays focused under the dock overlay (finding in US3 context work).
 *
 * This drives the real fix end-to-end: while VIEWING an (empty) collection, the user adds a movie
 * via the assistant and approves; the dock bumps the shared data-revision when the approved run
 * finishes, and the collection screen re-fetches — so the new row appears in the on-screen list
 * WITHOUT any `page.goto`/reload. The decisive assertion is `movie-list-item-title` (which lives
 * ONLY in the MovieList, never the dock) becoming visible with no navigation after the approve.
 *
 * Requires the FULL agent stack + E2E_AGENT_PRODUCTION=1. IN-APP nav to the collection (research
 * R15 — never deep-load a collection before driving the dock, it resets the CopilotKit agent).
 * Determinism: "Coherence" (2013) resolves to a single TMDB result; "this" resolution is pure code.
 *
 * Run: E2E_AGENT_PRODUCTION=1 pnpm nx e2e mcm-app -- tests/e2e/web/assistant-list-refresh.spec.ts
 */

import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

import { E2E_BASE_URL as BASE } from './setup/target';
import { cleanupNonFixtureCollections } from './setup/e2e-cleanup';

const APPROVAL_TIMEOUT = 150_000;
// The refresh follows the approve-resume run (token mint → movie-mcp add → mc-service → bump →
// refetch → render); on a cold agent stack that full cycle can exceed 90s, so allow generously.
const REFRESH_TIMEOUT = 120_000;

const MOVIE_TITLE = 'Coherence';

async function seedCollection(request: APIRequestContext, name: string): Promise<string> {
  const res = await request.post('/bff-api/collections', { data: { name } });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).collectionId as string;
}

async function openDock(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="assistant-dock-toggle"]', { state: 'visible', timeout: 60000 });
  await page.click('[data-testid="assistant-dock-toggle"]');
  await page.waitForSelector('[data-testid="assistant-dock-panel"]', { state: 'visible', timeout: 10000 });
}

// Reach the collection screen via IN-APP navigation from home (never a deep-load — that resets
// the CopilotKit dock agent; research R15). Mirrors assistant-context.spec.ts.
async function openCollectionViaHome(page: Page, name: string): Promise<void> {
  await page.goto(`${BASE}/home`);
  const where = await Promise.race([
    page.waitForSelector('[data-testid="home-screen-create-button"]', { state: 'visible', timeout: 60000 }).then(() => 'home' as const),
    page.waitForSelector('[data-testid="collection-screen-add-movie"]', { state: 'visible', timeout: 60000 }).then(() => 'collection' as const),
  ]);
  if (where === 'collection') {
    await page.goto(`${BASE}/home`);
    await page.waitForSelector('[data-testid="home-screen-create-button"]', { state: 'visible', timeout: 60000 });
  }
  if ((await page.locator(`text=${name}`).count()) === 0) {
    await page.getByText('My Collections').first().click();
    await page.waitForTimeout(1500);
  }
  await page.locator(`text=${name}`).first().click();
  await page.waitForSelector('[data-testid="collection-screen-add-movie"]', { state: 'visible', timeout: 30000 });
}

test.describe('Assistant list refresh after a write (feature 012, T072)', () => {
  test.skip(
    process.env['E2E_AGENT_PRODUCTION'] !== '1',
    'Needs the production-node host gateway (:8123). Run with E2E_AGENT_PRODUCTION=1.',
  );

  test.afterEach(async ({ request }) => {
    await cleanupNonFixtureCollections(request);
  });

  test('adding via the assistant updates the on-screen movie list with no reload', async ({
    page,
    request,
  }) => {
    test.setTimeout(300_000);
    const collectionName = `t072-refresh-${Date.now()}`;
    await seedCollection(request, collectionName); // EMPTY — so the new row can only come from the write

    await openCollectionViaHome(page, collectionName);
    // Precondition: the list is empty on screen (no movie rows yet).
    await expect(page.locator('[data-testid="movie-list-item-title"]')).toHaveCount(0);

    await openDock(page);
    await page.fill('[data-testid="assistant-dock-input"]', `add the movie ${MOVIE_TITLE} (2013) to this`);
    await page.click('[data-testid="assistant-dock-send"]');

    const approval = page.locator('[data-testid="approval-request"]');
    await expect(approval).toBeVisible({ timeout: APPROVAL_TIMEOUT });
    await page.click('[data-testid="approval-approve"]');

    // THE ASSERTION: the new row appears in the on-screen MovieList without any page reload /
    // re-navigation. `movie-list-item-title` exists only in the list (never the dock preview),
    // so this proves the screen re-fetched after the assistant write completed (T072).
    await expect(
      page.locator('[data-testid="movie-list-item-title"]').filter({ hasText: MOVIE_TITLE }),
    ).toBeVisible({ timeout: REFRESH_TIMEOUT });
  });
});
