/**
 * T055 (web E2E): Context-aware "this" — the US3 journey end-to-end in a browser.
 *
 * While viewing a specific collection, the user says "add <movie> to this"; the assistant
 * resolves the target from the on-screen collection (the sanitized ui_snapshot pushed to
 * /bff-api/agent/ui-state and bridged to the gateway as X-UI-Snapshot → config), then runs the
 * normal preview→approve flow and adds the movie to THAT collection — never a literal "this"
 * collection (US3-AC1). On a screen with no resolvable target (home), an ambiguous "this"
 * reference makes the assistant clarify rather than guess (US3-AC2 / FR-014).
 *
 * Drives the full live stack (HANDOFF.md): screen reports ui-state → CopilotKit dock flushes it
 * → BFF /run (X-UI-Snapshot header) → production-node gateway → Ollama enrich → organizer "this"
 * resolution (pure code) → approval_gate → approve → movie-mcp → mc-service. Verified via the BFF.
 *
 * Requires the FULL agent stack + E2E_AGENT_PRODUCTION=1 (host gateway :8123 with US3 nodes —
 * UiSnapshotMiddleware + the organizer ui_snapshot resolution). Determinism: "Coherence" (2013)
 * resolves to a single TMDB result; "this" resolution is pure code.
 *
 * Run: E2E_AGENT_PRODUCTION=1 pnpm nx e2e mcm-app -- tests/e2e/web/assistant-context.spec.ts
 */

import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

import { E2E_BASE_URL as BASE } from './setup/target';
import { cleanupNonFixtureCollections } from './setup/e2e-cleanup';

const APPROVAL_TIMEOUT = 150_000;
const DONE_TIMEOUT = 90_000;
const CLARIFY_TIMEOUT = 120_000;

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

async function askAddToThis(page: Page): Promise<void> {
  await page.fill('[data-testid="assistant-dock-input"]', `add the movie ${MOVIE_TITLE} (2013) to this`);
  await page.click('[data-testid="assistant-dock-send"]');
}

async function listCollections(
  request: APIRequestContext,
): Promise<{ collectionId: string; name: string }[]> {
  const res = await request.get('/bff-api/collections');
  if (!res.ok()) return [];
  const body = await res.json();
  return (body.items ?? body) as { collectionId: string; name: string }[];
}

test.describe('Assistant context-aware "this" (feature 012, US3)', () => {
  test.skip(
    process.env['E2E_AGENT_PRODUCTION'] !== '1',
    'Needs the production-node host gateway (:8123). Run with E2E_AGENT_PRODUCTION=1.',
  );

  test.afterEach(async ({ request }) => {
    await cleanupNonFixtureCollections(request);
  });

  test('US3-AC1: "add <movie> to this" on a collection screen adds to that collection', async ({
    page,
    request,
  }) => {
    test.setTimeout(300_000);
    const collectionName = `t055-ctx-${Date.now()}`;
    const collectionId = await seedCollection(request, collectionName);

    // View the seeded collection — the screen reports its ui_snapshot (current_screen=collection,
    // collection_id) on focus; the dock flushes it before the turn.
    await page.goto(`${BASE}/collections/${collectionId}`);
    await page.waitForSelector('[data-testid="collection-screen-add-movie"]', { state: 'visible', timeout: 60000 });
    await openDock(page);
    await askAddToThis(page);

    // The approval card resolves the ON-SCREEN collection (no named target). Nothing written yet.
    const approval = page.locator('[data-testid="approval-request"]');
    await expect(approval).toBeVisible({ timeout: APPROVAL_TIMEOUT });
    await expect(approval).toContainText(MOVIE_TITLE);

    await page.click('[data-testid="approval-approve"]');
    await expect(page.locator('[data-testid="assistant-msg-assistant"]').last()).toContainText(
      'Done',
      { timeout: DONE_TIMEOUT },
    );

    // The movie landed in the on-screen collection — and no literal "this" collection was made.
    const moviesRes = await request.get(`/bff-api/collections/${collectionId}/movies`);
    expect(moviesRes.ok()).toBeTruthy();
    const movies = ((await moviesRes.json()).items ?? []) as { title: string }[];
    expect(movies.map((m) => m.title)).toContain(MOVIE_TITLE);

    const names = (await listCollections(request)).map((c) => c.name.toLowerCase());
    expect(names).not.toContain('this');
  });

  test('US3-AC2: "add <movie> to this" on home asks the user to clarify', async ({ page }) => {
    test.setTimeout(300_000);
    await page.goto(`${BASE}/home`);
    await page.waitForSelector('[data-testid="home-screen-create-button"]', { state: 'visible', timeout: 60000 });
    await openDock(page);
    await askAddToThis(page);

    // No on-screen collection to resolve "this" → the assistant clarifies (never guesses / never
    // creates one). The approval card must NOT appear.
    await expect(page.locator('[data-testid="assistant-msg-assistant"]').last()).toContainText(
      /which collection/i,
      { timeout: CLARIFY_TIMEOUT },
    );
    await expect(page.locator('[data-testid="approval-request"]')).toHaveCount(0);
  });
});
