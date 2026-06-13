/**
 * T082 (web E2E): Disambiguation-pick correctness + year-suffix move resolution.
 *
 * Two regression-targeted tests for the two bugs fixed in Phase 9:
 *
 * Test 1 (bug-1 E2E): look-up disambiguation picks the RIGHT (non-first) option.
 *   Bug-1 pre-fix: resolve_option matched the SHORTER option title first (bare "Avatar" was a
 *   substring of "Avatar: The Way of Water"), so a user pick of the longer title resolved to the
 *   wrong (first) film. Fix: sorted options by descending title length so the MOST SPECIFIC title
 *   matches first. This test asks the assistant to "look up Avatar" (enrich intent, not add), picks
 *   "Avatar: The Way of Water" (the non-first option), and asserts the rendered card shows the 2022
 *   film — NOT the 2009 "Avatar". No write, no approval, no teardown.
 *
 * Test 2 (bug-2 E2E): move "Title (Year)" resolves + moves the right film.
 *   A year-qualified title in a move command ("Avatar (2009)") must resolve to the seeded movie via
 *   resolve_option step-1 (year match) rather than the bare title path that could match the wrong
 *   TMDB result. Seeds a SOURCE collection with "Avatar" (year 2009) and an empty DEST. Sends the
 *   move command, approves, and asserts the movie crossed collections.
 *
 * Drives the full live stack: CopilotKit dock → BFF /run → production-node gateway → Ollama
 * classify+extract → supervisor.resolve_option (pure code) → curator enrichment / organizer →
 * HITL approval gate (test 2) → movie-mcp → mc-service.
 *
 * IMPORTANT (research R15): the dock is always opened from /home (page.goto('/home') is the
 * allowed home deep-load). Never deep-load a non-home route before driving the dock.
 *
 * Requires the FULL agent stack (HANDOFF.md) + E2E_AGENT_PRODUCTION=1 (host gateway with
 * production nodes). Test 2 seeds/tears down its own collections via the BFF.
 *
 * Run: node scripts/agent-e2e.mjs assistant-disambiguate
 * Or:  E2E_AGENT_PRODUCTION=1 pnpm nx e2e mcm-app -- tests/e2e/web/assistant-disambiguate.spec.ts
 */

import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

import { E2E_BASE_URL as BASE } from './setup/target';
import { cleanupNonFixtureCollections } from './setup/e2e-cleanup';

// Generous timeouts: LLM classify+extract + TMDB enrich; the first /run of a session can be cold.
const OFFER_TIMEOUT = 150_000;
const CARD_TIMEOUT = 120_000;
const PREVIEW_TIMEOUT = 150_000;
const DONE_TIMEOUT = 90_000;

// "Avatar" is the canonical ambiguous franchise: "Avatar" (2009) and "Avatar: The Way of Water"
// (2022) are the two most prominent TMDB results. We pick the non-first (longer-title) one.
const AMBIGUOUS_TITLE = 'Avatar';
const EXPECTED_PICK_TITLE = 'Avatar: The Way of Water';
const EXPECTED_PICK_YEAR = '2022';

function movieBody(title: string, year: number): Record<string, unknown> {
  return {
    title,
    year,
    contentType: 'Movie',
    language: 'English',
    owned: true,
    ripped: false,
    childrens: false,
    ownedMedia: [],
    ripQuality: [],
    genres: ['Action'],
    rated: 'PG-13',
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
  movies: { title: string; year: number }[] = [],
): Promise<string> {
  const res = await request.post('/bff-api/collections', { data: { name } });
  expect(res.ok()).toBeTruthy();
  const collectionId = (await res.json()).collectionId as string;
  for (const m of movies) {
    const r = await request.post(`/bff-api/collections/${collectionId}/movies`, {
      data: movieBody(m.title, m.year),
    });
    expect(r.ok()).toBeTruthy();
  }
  return collectionId;
}

async function movieTitles(request: APIRequestContext, collectionId: string): Promise<Set<string>> {
  const res = await request.get(`/bff-api/collections/${collectionId}/movies`);
  expect(res.ok()).toBeTruthy();
  return new Set(
    ((await res.json()).items ?? []).map((m: { title: string }) => m.title),
  );
}

async function gotoHome(page: Page): Promise<void> {
  await page.goto(`${BASE}/home`);
  const result = await Promise.race([
    page
      .waitForSelector('[data-testid="home-screen-create-button"]', { state: 'visible', timeout: 60000 })
      .then(() => 'home' as const),
    page
      .waitForSelector('[data-testid="collection-screen-add-movie"]', { state: 'visible', timeout: 60000 })
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

test.describe('Assistant disambiguation correctness (feature 012, T082)', () => {
  test.skip(
    process.env['E2E_AGENT_PRODUCTION'] !== '1',
    'Needs the production-node gateway. Run with E2E_AGENT_PRODUCTION=1.',
  );

  test.afterEach(async ({ request }) => {
    await cleanupNonFixtureCollections(request);
  });

  test('look-up disambiguation pick resolves the NON-FIRST (longer-title) option', async ({
    page,
  }) => {
    /**
     * Bug-1 regression: picking "Avatar: The Way of Water" must NOT resolve to bare "Avatar"
     * (2009). The fix in resolve_option sorts options by descending title length before the
     * substring check, so the longer title matches first.
     *
     * This is an enrich-only flow (no collection, no write). The assistant shows the render_movie_card
     * for the resolved film — we assert the card carries the 2022 title and year.
     */
    test.setTimeout(360_000);

    await gotoHome(page);
    await openDock(page);

    // Turn 1: ambiguous title → assistant offers matches (no approval card yet). "tell me about"
    // stays enrich → curator disambiguation (013 Bug 2 routed "look up X" to the search workflow).
    await send(page, `tell me about ${AMBIGUOUS_TITLE}`);
    const lastMsg = page.locator('[data-testid="assistant-msg-assistant"]').last();
    // The assistant should list the options mentioning "Avatar: The Way of Water".
    await expect(lastMsg).toContainText('Avatar', { timeout: OFFER_TIMEOUT });
    // No write proposed yet.
    await expect(page.locator('[data-testid="approval-request"]')).toHaveCount(0);

    // Turn 2: pick the NON-FIRST option by full title → curator resolves it deterministically
    // (resolve_option step-2: longest-title-first substring match). No model needed for the pick.
    await send(page, EXPECTED_PICK_TITLE);

    // The render_movie_card for the resolved film appears.
    const card = page.locator('[data-testid="render-movie-card"]').last();
    await expect(card).toBeVisible({ timeout: CARD_TIMEOUT });

    // KEY assertion (bug-1 regression): the card shows "Avatar: The Way of Water" (2022),
    // NOT bare "Avatar" (2009).
    const cardTitle = card.locator('[data-testid="render-movie-card-title"]');
    await expect(cardTitle).toContainText(EXPECTED_PICK_TITLE);
    const cardYear = card.locator('[data-testid="render-movie-card-year"]');
    await expect(cardYear).toContainText(EXPECTED_PICK_YEAR);

    // Enrich-only: no approval card, no write (the assistant does not ask to add to a collection).
    await expect(page.locator('[data-testid="approval-request"]')).toHaveCount(0);
  });

  test('move "Title (Year)" resolves and moves the correct film across collections', async ({
    page,
    request,
  }) => {
    /**
     * Bug-2 regression: a year-qualified title in a move command ("Avatar (2009)") must use the
     * year to disambiguate and arrive at the correct movie. The organizer's title resolution
     * (resolve_option step-1: year match) must handle the "(YYYY)" suffix form so the user can
     * unambiguously refer to the 2009 film in a collection that also might contain others.
     *
     * Seed a source collection with a seeded "Avatar" (year 2009) and an empty dest.
     * Send the move command, approve the preview, assert the movie crossed collections.
     */
    test.setTimeout(360_000);
    const ts = Date.now();
    const srcName = `t082-mv-src-${ts}`;
    const dstName = `t082-mv-dst-${ts}`;
    const srcId = await seedCollection(request, srcName, [{ title: 'Avatar', year: 2009 }]);
    const dstId = await seedCollection(request, dstName, []);

    await gotoHome(page);
    await openDock(page);

    // Explicitly name both collections so the organizer doesn't have to guess.
    await send(page, `move Avatar (2009) from ${srcName} to ${dstName}`);

    // The organizer plans the move and the approval gate shows the preview (FR-007 — nothing moves
    // before approval).
    const approval = page.locator('[data-testid="approval-request"]');
    await expect(approval).toBeVisible({ timeout: PREVIEW_TIMEOUT });
    // Pre-approval: movie still in source.
    expect(await movieTitles(request, srcId)).toEqual(new Set(['Avatar']));
    expect(await movieTitles(request, dstId)).toEqual(new Set());

    // Approve → add-to-dest then remove-from-source (Operation.move).
    await page.click('[data-testid="approval-approve"]');
    await expect(page.locator('[data-testid="assistant-msg-assistant"]').last()).toContainText(
      'Done',
      { timeout: DONE_TIMEOUT },
    );

    // Post-approval: movie has crossed collections (US2-AC2).
    expect(await movieTitles(request, srcId)).toEqual(new Set());
    expect(await movieTitles(request, dstId)).toEqual(new Set(['Avatar']));
  });
});
