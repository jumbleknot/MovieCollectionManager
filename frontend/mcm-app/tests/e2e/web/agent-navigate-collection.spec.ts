/**
 * T007 (web E2E, 040 US1 / Item 4): navigate-to-collection reliability — the reported bug.
 *
 * Repro: the user asks the assistant to navigate to a collection; when the name matches MORE than
 * one owned collection the navigator offers disambiguation buttons; tapping "…​Import" must OPEN
 * the Test Import collection screen — NOT mis-fire an in-collection movie search (the reported
 * failure, bug-a). A qualified "navigate to <X> collection" opens X directly (bug-b classifier).
 *
 * Drives the full live stack: CopilotKit dock → BFF /run → production-node gateway → intent
 * classify (navigate) → navigator (name resolve, pure code) → render_selection buttons → tap →
 * navigate_to_collection UI-action → BFF ui-action authorize (default-deny) → router.push.
 *
 * IMPORTANT (research R15 / CLAUDE.md): the dock is driven IN-APP from /home — never a deep-load
 * of the target collection before the navigate action. Each test seeds its own collections + tears
 * them down. Requires the FULL agent stack + E2E_AGENT_PRODUCTION=1 + a runnable dock config.
 *
 * Run: node scripts/agent-e2e.mjs agent-navigate-collection
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

import { E2E_BASE_URL as BASE } from './setup/target';
import { cleanupNonFixtureCollections } from './setup/e2e-cleanup';

const ACTION_TIMEOUT = 180_000;
const OFFER_TIMEOUT = 180_000;
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

test.describe('Assistant navigate-to-collection (040 US1 / Item 4)', () => {
  test.skip(
    process.env['E2E_AGENT_PRODUCTION'] !== '1',
    'Needs the production-node gateway + a runnable dock config. Run with E2E_AGENT_PRODUCTION=1.',
  );

  test.afterEach(async ({ request }) => {
    await cleanupNonFixtureCollections(request);
  });

  test('ambiguous navigate → tap "Import" OPENS that collection (not an in-collection search)', async ({
    page,
    request,
  }) => {
    test.setTimeout(420_000);
    const prefix = `t040nav${Date.now()}`;
    // Two owned collections both matching `<prefix>` → the navigator must disambiguate.
    const importId = await seedCollection(request, `${prefix} Import`);
    await seedCollection(request, `${prefix} Export`);

    await gotoHome(page);
    await openDock(page);
    await send(page, `take me to my ${prefix} collection`);

    // The navigator's `_clarify` offers one bare stage-anchored button per collection via
    // `render_selection` → the `selection-options` component (NOT the curator's
    // `disambiguation-options`, which renders `render_disambiguation` for movie candidates).
    const options = page.locator('[data-testid="selection-options"]').last();
    await expect(options).toBeVisible({ timeout: OFFER_TIMEOUT });
    // No movie-search misfire: we are still on /home (the dock hasn't navigated anywhere yet).
    await expect(page).toHaveURL(new RegExp('/home(?:[/?#]|$)'));

    // Tap the "…​Import" collection button — the bug was this tapping a SEARCH, not a navigate.
    await options.getByText(`${prefix} Import`, { exact: false }).first().click();

    // The tap resolves in the navigator and OPENS the Test Import collection screen.
    await page.waitForURL(new RegExp(`/collections/${importId}(?:[/?#]|$)`), {
      timeout: ACTION_TIMEOUT,
    });
    await expect(page.locator('[data-testid="collection-screen-add-movie"]')).toBeVisible({
      timeout: NAV_TIMEOUT,
    });
  });

  test('qualified "navigate to <X> collection" opens X directly (classifier bug-b)', async ({
    page,
    request,
  }) => {
    test.setTimeout(360_000);
    const name = `t040navq${Date.now()}`;
    const collectionId = await seedCollection(request, name);

    await gotoHome(page);
    await openDock(page);
    await send(page, `navigate to my ${name} collection`);

    await page.waitForURL(new RegExp(`/collections/${collectionId}(?:[/?#]|$)`), {
      timeout: ACTION_TIMEOUT,
    });
    await expect(page.locator('[data-testid="collection-screen-add-movie"]')).toBeVisible({
      timeout: NAV_TIMEOUT,
    });
  });
});
