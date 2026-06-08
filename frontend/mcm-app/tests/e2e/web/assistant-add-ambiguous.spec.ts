/**
 * T069e (web E2E): Add a movie whose title is AMBIGUOUS — the realistic franchise journey.
 *
 * The single-shot exact path is covered by assistant-add.spec.ts (T037, "Coherence"). This
 * exercises the multi-turn disambiguation hardening (T069 / research R14):
 *   ask to add an ambiguous title → assistant offers the matches (NO approval yet) →
 *   user picks by ordinal ("the first one") → assistant resolves a single film → approval card
 *   → approve → movie added to the (create-if-missing) collection EXACTLY ONCE.
 *
 * Proves the disambiguation state machine end-to-end on real react-native-web DOM through the
 * full live stack (CopilotKit dock → BFF runtime → AG-UI gateway production nodes → Ollama
 * classify/extract → web-api-mcp/TMDB → organizer → approval_gate interrupt → resume →
 * movie-mcp → mc-service). Verified via the BFF API.
 *
 * Requires the FULL agent stack (HANDOFF.md) + E2E_AGENT_PRODUCTION=1 (host gateway :8123).
 *
 * Determinism: "Pirates of the Caribbean" returns several TMDB results (matchConfidence=
 * ambiguous); "the first one" resolves deterministically to the first offered option in code
 * (supervisor.resolve_option) — independent of the model — so the journey is stable.
 *
 * Run (isolated): E2E_AGENT_PRODUCTION=1 pnpm nx e2e mcm-app -- tests/e2e/web/assistant-add-ambiguous.spec.ts
 */

import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

import { E2E_BASE_URL as BASE } from './setup/target';
import { cleanupNonFixtureCollections } from './setup/e2e-cleanup';

const OFFER_TIMEOUT = 150_000;
const APPROVAL_TIMEOUT = 90_000;
const DONE_TIMEOUT = 90_000;

const AMBIGUOUS_TITLE = 'Pirates of the Caribbean';

async function gotoHome(page: Page): Promise<void> {
  await page.goto(`${BASE}/home`);
  const result = await Promise.race([
    page.waitForSelector('[data-testid="home-screen-create-button"]', { state: 'visible', timeout: 60000 }).then(() => 'home' as const),
    page.waitForSelector('[data-testid="collection-screen-add-movie"]', { state: 'visible', timeout: 60000 }).then(() => 'collection' as const),
  ]).catch(() => null);
  if (result === 'collection') {
    await page.goto(`${BASE}/home`);
    await page.waitForSelector('[data-testid="home-screen-create-button"]', { state: 'visible', timeout: 60000 });
    return;
  }
  if (!result) throw new Error('gotoHome: home screen did not render — is the global-setup session valid?');
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

async function findCollection(
  request: APIRequestContext,
  name: string,
): Promise<{ collectionId: string } | undefined> {
  const res = await request.get('/bff-api/collections');
  if (!res.ok()) return undefined;
  const body = await res.json();
  const items = (body.items ?? body) as { collectionId: string; name: string }[];
  return items.find((c) => c.name.toLowerCase() === name.toLowerCase());
}

test.describe('Assistant ambiguous add flow (feature 012, US1 / T069)', () => {
  test.skip(
    process.env['E2E_AGENT_PRODUCTION'] !== '1',
    'Needs the production-node host gateway (:8123). Run with E2E_AGENT_PRODUCTION=1.',
  );

  test.afterEach(async ({ request }) => {
    await cleanupNonFixtureCollections(request);
  });

  test('ambiguous title → ordinal pick → approve adds exactly one movie', async ({
    page,
    request,
  }) => {
    test.setTimeout(360_000);
    const collectionName = `t069-amb-${Date.now()}`;
    await gotoHome(page);
    await openDock(page);

    // Turn 1: ambiguous title → the assistant offers matches, builds NO proposal yet.
    await send(page, `add ${AMBIGUOUS_TITLE} to my collection ${collectionName}`);
    await expect(page.locator('[data-testid="assistant-msg-assistant"]').last()).toContainText(
      'matches',
      { timeout: OFFER_TIMEOUT },
    );
    await expect(page.locator('[data-testid="approval-request"]')).toHaveCount(0);
    expect(await findCollection(request, collectionName)).toBeUndefined();

    // Turn 2: pick by ordinal → resolves a single film → approval card appears.
    await send(page, 'the first one');
    const approval = page.locator('[data-testid="approval-request"]');
    await expect(approval).toBeVisible({ timeout: APPROVAL_TIMEOUT });
    await expect(approval).toContainText('Pirates');
    expect(await findCollection(request, collectionName)).toBeUndefined();

    // Approve → the create-if-missing collection + the chosen movie are applied exactly once.
    await page.click('[data-testid="approval-approve"]');
    await expect(page.locator('[data-testid="assistant-msg-assistant"]').last()).toContainText(
      'Done',
      { timeout: DONE_TIMEOUT },
    );

    const collection = await findCollection(request, collectionName);
    expect(collection).toBeDefined();
    const moviesRes = await request.get(`/bff-api/collections/${collection!.collectionId}/movies`);
    expect(moviesRes.ok()).toBeTruthy();
    const movies = ((await moviesRes.json()).items ?? []) as { title: string }[];
    expect(movies).toHaveLength(1);
    expect(movies[0].title).toContain('Pirates');
  });
});
