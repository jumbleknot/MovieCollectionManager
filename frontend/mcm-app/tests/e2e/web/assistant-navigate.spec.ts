/**
 * T059 (web E2E): Navigate / prefill by conversation — the US3 UI-action capability end-to-end.
 *
 * "take me to my <collection>" → the navigator resolves the collection (pure code, against the
 * user's own list) → emits an allowlisted navigate_to_collection tool call → the client
 * authorizes the structural target at the BFF ui-action-authorizer (default-deny) → expo-router
 * lands on the collection screen. "let me add a movie to my <collection>" → prefill_add_movie →
 * the add-movie form opens for that collection (HITL-surfaced — opened, never submitted).
 *
 * Drives the full live stack: CopilotKit dock → BFF /run → production-node gateway → Ollama
 * intent classify → navigator → movie-mcp list_collections → UI-action dispatch → BFF
 * /bff-api/agent/ui-action authorize → router.push.
 *
 * IMPORTANT (research R15): the dock is driven IN-APP from home (page.goto('/home') is the home
 * deep-load, which is allowed); the navigate action itself is the only route change, via
 * router.push — never a deep-load of a collection before driving the dock.
 *
 * Requires the FULL agent stack (HANDOFF.md) + E2E_AGENT_PRODUCTION=1 (host gateway :8123 with
 * the T059 navigator). Each test seeds its own collection via the BFF and tears it down.
 *
 * Run: E2E_AGENT_PRODUCTION=1 pnpm nx e2e mcm-app -- tests/e2e/web/assistant-navigate.spec.ts
 */

import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

import { E2E_BASE_URL as BASE } from './setup/target';
import { cleanupNonFixtureCollections } from './setup/e2e-cleanup';

const ACTION_TIMEOUT = 150_000;
const NAV_TIMEOUT = 60_000;

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
  await page.waitForSelector('[data-testid="assistant-dock-toggle"]', { state: 'visible', timeout: 60000 });
  await page.click('[data-testid="assistant-dock-toggle"]');
  await page.waitForSelector('[data-testid="assistant-dock-panel"]', { state: 'visible', timeout: 10000 });
}

async function send(page: Page, text: string): Promise<void> {
  await page.fill('[data-testid="assistant-dock-input"]', text);
  await page.click('[data-testid="assistant-dock-send"]');
}

test.describe('Assistant navigate / prefill (feature 012, US3 / T059)', () => {
  test.skip(
    process.env['E2E_AGENT_PRODUCTION'] !== '1',
    'Needs the production-node host gateway (:8123). Run with E2E_AGENT_PRODUCTION=1.',
  );

  test.afterEach(async ({ request }) => {
    await cleanupNonFixtureCollections(request);
  });

  test('navigate → the assistant opens the named collection screen', async ({ page, request }) => {
    test.setTimeout(360_000);
    const name = `t059-nav-${Date.now()}`;
    const collectionId = await seedCollection(request, name);

    await gotoHome(page);
    await openDock(page);
    await send(page, `take me to my ${name} collection`);

    // The UI-action fired (authorized at the BFF) and expo-router landed on the collection.
    await page.waitForURL(new RegExp(`/collections/${collectionId}(?:[/?#]|$)`), {
      timeout: ACTION_TIMEOUT,
    });
    await expect(page.locator('[data-testid="collection-screen-add-movie"]')).toBeVisible({
      timeout: NAV_TIMEOUT,
    });
  });

  test('prefill → the assistant opens the add-movie form on the named collection', async ({
    page,
    request,
  }) => {
    test.setTimeout(360_000);
    const name = `t059-pre-${Date.now()}`;
    const collectionId = await seedCollection(request, name);

    await gotoHome(page);
    await openDock(page);
    // NB: "open the add movie form for …" routes to `navigate` on BOTH the runtime model
    // (qwen2.5) and the gate (Claude). The looser "let me add a movie to …" phrasing classifies
    // as `add` on qwen2.5 (→ curator), so it is NOT a reliable prefill trigger at runtime.
    await send(page, `open the add movie form for my ${name} collection`);

    // prefill_add_movie opens the add-movie form for the resolved collection (HITL — not submitted).
    await page.waitForURL(new RegExp(`/collections/${collectionId}/add-movie`), {
      timeout: ACTION_TIMEOUT,
    });
    await expect(page.locator('[data-testid="new-movie-screen"]')).toBeVisible({
      timeout: NAV_TIMEOUT,
    });
  });
});
