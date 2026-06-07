/**
 * T037 (web E2E): Add a movie by conversation — the US1 MVP journey end-to-end in a browser.
 *
 * Drives the FULL live stack on real react-native-web DOM:
 *   CopilotKit dock → BFF CopilotKit-runtime bridge (mints a run-scoped subject token) →
 *   AG-UI-native gateway (production nodes) → supervisor/curator (Ollama) → web-api-mcp/TMDB
 *   enrich → organizer → approval_gate LangGraph interrupt → ApprovalRequest card →
 *   approve → resume (fresh token) → movie-mcp → mc-service write. Verified via the BFF API.
 *
 * Proves (FR-005/006/007, SC-001 web leg, create-if-missing FR-005a):
 *   - the assistant previews the add behind an explicit approval (nothing written pre-approval);
 *   - approve creates the missing collection + adds the enriched movie exactly once;
 *   - reject leaves everything unchanged.
 *
 * Requires the FULL agent stack (HANDOFF.md): Ollama (qwen2.5) + Agent Gateway :8123 with
 * PRODUCTION nodes (WEB_API_MCP_URL + MOVIE_MCP_URL set) + movie-mcp :8766 + web-api-mcp :8765
 * + Keycloak + Redis + mc-service + Expo web :8081. Session from the Playwright global setup.
 *
 * Determinism: "Coherence" (2013) resolves to a single TMDB result (matchConfidence=exact), and
 * qwen2.5 reliably classifies intent=add + extracts {title, year, collection} for this phrasing.
 *
 * Run (isolated):  pnpm nx e2e mcm-app -- tests/e2e/web/assistant-add.spec.ts
 */

import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

import { E2E_BASE_URL as BASE } from './setup/target';
import { cleanupNonFixtureCollections } from './setup/e2e-cleanup';

// Add flow = Ollama classify+extract + TMDB enrich + movie-mcp list + Keycloak exchange, then a
// resume round. Generous budgets on top of a possible Metro cold-compile.
const APPROVAL_TIMEOUT = 150_000;
const DONE_TIMEOUT = 90_000;

const MOVIE_TITLE = 'Coherence';

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

async function askToAdd(page: Page, collectionName: string): Promise<void> {
  const prompt = `add the movie ${MOVIE_TITLE} (2013) to my collection ${collectionName}`;
  await page.fill('[data-testid="assistant-dock-input"]', prompt);
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

test.describe('Assistant add flow (feature 012, US1)', () => {
  test.afterEach(async ({ request }) => {
    await cleanupNonFixtureCollections(request);
  });

  test('approve creates the collection and adds the movie once (create-if-missing)', async ({
    page,
    request,
  }) => {
    test.setTimeout(300_000);
    const collectionName = `t037-add-${Date.now()}`;
    await gotoHome(page);
    await openDock(page);
    await askToAdd(page, collectionName);

    // The HITL approval card appears once enrichment + the proposal are ready. Nothing is
    // written yet — the collection must not exist before approval.
    const approval = page.locator('[data-testid="approval-request"]');
    await expect(approval).toBeVisible({ timeout: APPROVAL_TIMEOUT });
    await expect(approval).toContainText(MOVIE_TITLE);
    expect(await findCollection(request, collectionName)).toBeUndefined();

    // Approve → the create-if-missing collection + the movie are applied.
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
    expect(movies[0].title).toBe(MOVIE_TITLE);
  });

  test('reject leaves the collection uncreated (no writes)', async ({ page, request }) => {
    test.setTimeout(300_000);
    const collectionName = `t037-reject-${Date.now()}`;
    await gotoHome(page);
    await openDock(page);
    await askToAdd(page, collectionName);

    const approval = page.locator('[data-testid="approval-request"]');
    await expect(approval).toBeVisible({ timeout: APPROVAL_TIMEOUT });

    await page.click('[data-testid="approval-reject"]');
    await expect(page.locator('[data-testid="assistant-msg-assistant"]').last()).toBeVisible({
      timeout: DONE_TIMEOUT,
    });
    // FR-007: nothing persisted on reject.
    expect(await findCollection(request, collectionName)).toBeUndefined();
  });
});
