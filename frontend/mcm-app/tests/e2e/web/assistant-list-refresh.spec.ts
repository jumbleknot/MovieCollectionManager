/**
 * T072 (web E2E): the on-screen list refreshes after an assistant write — no manual reload.
 *
 * Bug: after the assistant applied a write, the collection's movie list already on screen stayed
 * stale until the user re-navigated, because `useFocusEffect` does not re-fire while the screen
 * stays focused under the dock overlay (finding in US3 context work). The fix is a shared
 * data-revision ([_layout.tsx](../../../src/app/_layout.tsx)) that the dock bumps when an APPROVED
 * write-apply run goes idle ([assistant-dock.tsx](../../../src/components/agent/assistant-dock.tsx)),
 * which `collection-screen.tsx` subscribes to and re-fetches on.
 *
 * ── Why this drives a REMOVE rather than the add it used to (backlog #150) ────────────────────
 * It used to add a movie to an empty on-screen collection and assert the new row appeared. That
 * became unobservable in 040 US4: `approval_gate` now emits `navigate_to_movie` after ANY
 * successful single-movie add ("Done — applied 1 change(s). Opening it now."), so the browser
 * leaves the collection screen for the new movie's detail screen before the refreshed list can be
 * seen. Measured 2026-08-10 against the live stack: the assertion failed with the row present in
 * the DOM but `hidden` — the re-fetch HAD happened, on a screen the app had already navigated off.
 *
 * A remove is the same T072 mechanism (same screen, same shared-revision bump, same list-only
 * locator) on the one write path that does NOT navigate — `navigate_to_movie` is emitted only for
 * `Operation.add`. Two alternatives were rejected as false greens: asserting the row while it is
 * hidden proves nothing, and navigating back to the collection re-fires `useFocusEffect`, so that
 * test would pass with T072 reverted — which is precisely the bug it exists to catch.
 *
 * The add journey itself is covered by assistant-add / assistant-context, and its detail-screen
 * landing by agent-add-ownership.
 *
 * Requires the FULL agent stack + E2E_AGENT_PRODUCTION=1. IN-APP nav to the collection (research
 * R15 — never deep-load a collection before driving the dock, it resets the CopilotKit agent).
 * Determinism: invented titles, so no TMDB lookup and no ranking drift; the remove is resolved in
 * code against the collection's own movies.
 *
 * Run: E2E_AGENT_PRODUCTION=1 pnpm nx e2e mcm-app -- tests/e2e/web/assistant-list-refresh.spec.ts
 */

import { test, expect } from './fixtures/worker-session';
import { type APIRequestContext, type Page } from '@playwright/test';

import { E2E_BASE_URL as BASE } from './setup/target';
import { cleanupNonFixtureCollections } from './setup/e2e-cleanup';

const APPROVAL_TIMEOUT = 150_000;
// The refresh follows the approve-resume run (token mint → movie-mcp remove → mc-service → bump →
// refetch → render); on a cold agent stack that full cycle can exceed 90s, so allow generously.
const REFRESH_TIMEOUT = 120_000;

// Invented titles: nothing to enrich, nothing for TMDB to rank differently between runs. Two of
// them, so the assertion distinguishes "the list re-fetched" from "the list emptied/unmounted".
const REMOVED_TITLE = 'Zorgon';
const KEPT_TITLE = 'Blarnix';

// Mirrors assistant-organize.spec.ts's body exactly — the create endpoint validates the whole
// shape, so a trimmed object 422s and the seed, not the assertion, is what fails.
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

  test('an assistant write updates the on-screen movie list with no reload', async ({
    page,
    request,
  }) => {
    test.setTimeout(300_000);
    const collectionName = `t072-refresh-${Date.now()}`;
    const collectionId = await seedCollection(request, collectionName, [REMOVED_TITLE, KEPT_TITLE]);

    await openCollectionViaHome(page, collectionName);
    // Precondition: BOTH rows are on screen, rendered by the screen's own initial fetch.
    const removedRow = page.locator('[data-testid="movie-list-item-title"]').filter({ hasText: REMOVED_TITLE });
    const keptRow = page.locator('[data-testid="movie-list-item-title"]').filter({ hasText: KEPT_TITLE });
    await expect(removedRow).toBeVisible();
    await expect(keptRow).toBeVisible();

    await openDock(page);
    await page.fill('[data-testid="assistant-dock-input"]', `remove ${REMOVED_TITLE} from ${collectionName}`);
    await page.click('[data-testid="assistant-dock-send"]');

    const approval = page.locator('[data-testid="approval-request"]');
    await expect(approval).toBeVisible({ timeout: APPROVAL_TIMEOUT });
    // Nothing removed yet — the write is behind the gate (FR-006/007).
    await expect(removedRow).toBeVisible();
    await page.click('[data-testid="approval-approve"]');

    // THE ASSERTION: the removed row leaves the on-screen MovieList without any page reload /
    // re-navigation, and the untouched row stays. `movie-list-item-title` exists only in the list
    // (never the dock preview), and the screen is never re-focused, so the only thing that can
    // change it is the T072 data-revision bump.
    await expect(removedRow).toHaveCount(0, { timeout: REFRESH_TIMEOUT });
    await expect(keptRow).toBeVisible();

    // The list on screen agrees with the server — it re-fetched, it did not just drop a row.
    const moviesRes = await request.get(`/bff-api/collections/${collectionId}/movies`);
    expect(moviesRes.ok()).toBeTruthy();
    const titles = ((await moviesRes.json()).items ?? []).map((m: { title: string }) => m.title);
    expect(titles).toEqual([KEPT_TITLE]);
  });
});
