/**
 * T043 (web E2E, 013 US5): an assistant-added TMDB movie carries the themoviedb.org link.
 *
 * Add a TMDB-enriched movie by conversation (approve the HITL proposal) → the stored movie's
 * externalIds carries { system: "tmdb", url: https://www.themoviedb.org/movie/<id> }
 * (proposals.to_movie_payload), and the movie-detail screen renders it as a tappable link.
 *
 * Drives the full live stack: dock → BFF /run → production-node gateway → Ollama classify/extract
 * → curator TMDB enrich → organizer → approval_gate → resume → movie-mcp → mc-service write.
 *
 * Requires the FULL agent stack + E2E_AGENT_PRODUCTION=1.
 * Run: node scripts/agent-e2e.mjs agent-add-external-link
 */

import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

import { E2E_BASE_URL as BASE } from './setup/target';
import { cleanupNonFixtureCollections } from './setup/e2e-cleanup';

const APPROVAL_TIMEOUT = 180_000;
const DONE_TIMEOUT = 90_000;
const MOVIE_TITLE = 'Coherence';
const TMDB_URL_RE = /^https:\/\/www\.themoviedb\.org\/movie\/\d+$/;

async function gotoHome(page: Page): Promise<void> {
  await page.goto(`${BASE}/home`);
  await page.waitForSelector('[data-testid="home-screen-create-button"]', { state: 'visible', timeout: 60000 });
}

async function openDock(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="assistant-dock-toggle"]', { state: 'visible', timeout: 60000 });
  await page.click('[data-testid="assistant-dock-toggle"]');
  await page.waitForSelector('[data-testid="assistant-dock-panel"]', { state: 'visible', timeout: 10000 });
}

interface ExternalId { system: string; uniqueId: string; url?: string | null }
interface StoredMovie { movieId: string; title: string; externalIds: ExternalId[] }

/**
 * Find the added movie by TITLE across ALL the user's collections — name-independent, since the
 * model may not echo a long timestamped collection name back verbatim (the movie title is the
 * reliable handle, and "Coherence" is unique to the freshly-created collection).
 */
async function findAddedMovie(
  request: APIRequestContext,
  title: string,
): Promise<{ collectionId: string; movie: StoredMovie } | undefined> {
  const res = await request.get('/bff-api/collections');
  if (!res.ok()) return undefined;
  const cols = ((await res.json()).items ?? []) as { collectionId: string }[];
  for (const c of cols) {
    const mres = await request.get(`/bff-api/collections/${c.collectionId}/movies`);
    if (!mres.ok()) continue;
    const items = ((await mres.json()).items ?? []) as StoredMovie[];
    const movie = items.find((m) => m.title.trim().toLowerCase() === title.toLowerCase());
    if (movie) return { collectionId: c.collectionId, movie };
  }
  return undefined;
}

test.describe('Assistant-added TMDB movie external link (013 US5)', () => {
  test.skip(
    process.env['E2E_AGENT_PRODUCTION'] !== '1',
    'Needs the production-node gateway. Run with E2E_AGENT_PRODUCTION=1.',
  );

  test.afterEach(async ({ request }) => {
    await cleanupNonFixtureCollections(request);
  });

  test('added TMDB movie carries the themoviedb.org external link (US5-AC1/AC2)', async ({
    page,
    request,
  }) => {
    test.setTimeout(300_000);
    const collectionName = `us5-link-${Date.now()}`;

    await gotoHome(page);
    await openDock(page);
    await page.fill('[data-testid="assistant-dock-input"]', `add the movie ${MOVIE_TITLE} (2013) to my collection ${collectionName}`);
    await page.click('[data-testid="assistant-dock-send"]');

    const approval = page.locator('[data-testid="approval-request"]');
    await expect(approval).toBeVisible({ timeout: APPROVAL_TIMEOUT });
    await page.click('[data-testid="approval-approve"]');
    await expect(page.locator('[data-testid="assistant-msg-assistant"]').last()).toContainText('Done', {
      timeout: DONE_TIMEOUT,
    });

    // The stored movie carries the TMDB external-id URL (proposals.to_movie_payload, US5-AC1).
    const found = await findAddedMovie(request, MOVIE_TITLE);
    expect(found, 'the added Coherence movie is found in one of the collections').toBeDefined();
    const tmdb = (found!.movie.externalIds ?? []).find((e) => e.system === 'tmdb');
    expect(tmdb, 'a tmdb external id is present').toBeDefined();
    expect(tmdb!.url ?? '').toMatch(TMDB_URL_RE);

    // The movie-detail screen renders it as a tappable link (US5-AC2). The agent flow is complete,
    // so deep-loading the detail here is fine (no dock interaction follows).
    await page.goto(`${BASE}/collections/${found!.collectionId}/movies/${found!.movie.movieId}`);
    const link = page.locator('[data-testid="movie-detail-ext-id-url-0"]');
    await expect(link).toBeVisible({ timeout: 60000 });
    await expect(link).toContainText(TMDB_URL_RE);
  });
});
