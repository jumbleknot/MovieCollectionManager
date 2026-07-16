/**
 * T045 (web E2E, 040 US4 / Item 2): TMDB add asks ownership + navigates to the movie detail.
 *
 * The add-from-TMDB flow now asks "Do you own this movie?" (Yes/No buttons) BEFORE the approval
 * gate; answering "No" builds the proposal with owned=false; approving adds the movie AND the
 * assistant navigates to that movie's detail screen (navigate_to_movie with the created movieId).
 *
 * Drives the full live stack: CopilotKit dock → BFF /run → production-node gateway → intent
 * classify (add) → curator TMDB enrich → organizer ownership question (render_selection) → tap
 * "No" → HITL approval → movie-mcp add (owned=false) → navigate_to_movie UI-action → router.push.
 *
 * IMPORTANT (research R15 / CLAUDE.md): the dock is driven IN-APP from /home. Requires the FULL
 * agent stack + E2E_AGENT_PRODUCTION=1 + a runnable dock config (TMDB key for enrichment).
 *
 * Run: node scripts/agent-e2e.mjs agent-add-ownership
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

import { E2E_BASE_URL as BASE } from './setup/target';
import { cleanupNonFixtureCollections } from './setup/e2e-cleanup';

const OWNERSHIP_TIMEOUT = 180_000;
const APPROVAL_TIMEOUT = 150_000;
const NAV_TIMEOUT = 90_000;

// A real TMDB title (also used by assistant-add) so curator enrichment resolves deterministically.
const MOVIE_TITLE = 'Coherence';

async function seedCollection(request: APIRequestContext, name: string): Promise<string> {
  const res = await request.post('/bff-api/collections', { data: { name } });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).collectionId as string;
}

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

test.describe('Assistant TMDB add — ownership + detail navigation (040 US4)', () => {
  test.skip(
    process.env['E2E_AGENT_PRODUCTION'] !== '1',
    'Needs the production-node gateway + a runnable dock config (TMDB). Run with E2E_AGENT_PRODUCTION=1.',
  );

  test.afterEach(async ({ request }) => {
    await cleanupNonFixtureCollections(request);
  });

  test('add from TMDB → "Do you own this?" → No → added owned=false → lands on the detail screen', async ({
    page,
    request,
  }) => {
    test.setTimeout(420_000);
    const name = `t040own${Date.now()}`;
    const collectionId = await seedCollection(request, name);

    await gotoHome(page);
    await openDock(page);
    await send(page, `add the movie ${MOVIE_TITLE} (2013) to my collection ${name}`);

    // ── The ownership question (Yes/No) appears BEFORE the approval gate ─────────────
    const options = page.locator('[data-testid="disambiguation-options"]').last();
    await expect(options).toBeVisible({ timeout: OWNERSHIP_TIMEOUT });
    // Nothing is written yet, and the approval card hasn't been offered.
    await expect(page.locator('[data-testid="approval-request"]')).toHaveCount(0);

    // ── Answer "No" (not owned) ──────────────────────────────────────────────────────
    await options.getByText('No', { exact: true }).first().click();

    // ── The add proposal is then surfaced for approval; approve it ───────────────────
    const approval = page.locator('[data-testid="approval-request"]');
    await expect(approval).toBeVisible({ timeout: APPROVAL_TIMEOUT });
    await expect(approval).toContainText(MOVIE_TITLE);
    await page.click('[data-testid="approval-approve"]');

    // ── The assistant navigates to the newly-added movie's detail screen ─────────────
    await page.waitForURL(new RegExp(`/collections/${collectionId}/movies/[^/?#]+`), {
      timeout: NAV_TIMEOUT,
    });
    await expect(page.locator('[data-testid="movie-detail-back-button"]')).toBeVisible({
      timeout: NAV_TIMEOUT,
    });

    // ── The movie was persisted with owned=false ─────────────────────────────────────
    const moviesRes = await request.get(`/bff-api/collections/${collectionId}/movies`);
    expect(moviesRes.ok()).toBeTruthy();
    const movies = ((await moviesRes.json()).items ?? []) as Array<{ title: string; owned: boolean }>;
    expect(movies).toHaveLength(1);
    expect(movies[0].title).toBe(MOVIE_TITLE);
    expect(movies[0].owned).toBe(false);
  });
});
