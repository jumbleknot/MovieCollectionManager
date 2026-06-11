/**
 * T036 (web E2E, 013 US4): ambiguous look-up candidates render as selectable buttons.
 *
 * "look up Avatar" → the curator offers ambiguous matches and emits a render_disambiguation tool
 * call → the client renders one selectable button per candidate (disambiguation-options) → tapping
 * the non-first button ("Avatar: The Way of Water") posts the canonical "<title> (<year>)" pick →
 * the curator resolves it (pure code) and renders that film's card. No typing required.
 *
 * Drives the full live stack: CopilotKit dock → BFF /run → production-node gateway → Ollama
 * classify+extract → curator enrichment (ambiguous) → render_disambiguation → button tap →
 * curator resolve_option → render_movie_card.
 *
 * IMPORTANT (research R15): the dock is driven IN-APP from /home. Enrich-only — no write/approval.
 *
 * Requires the FULL agent stack + E2E_AGENT_PRODUCTION=1.
 * Run: node scripts/agent-e2e.mjs agent-disambiguation
 */

import { test, expect, type Page } from '@playwright/test';

import { E2E_BASE_URL as BASE } from './setup/target';
import { cleanupNonFixtureCollections } from './setup/e2e-cleanup';

const OFFER_TIMEOUT = 180_000;
const CARD_TIMEOUT = 150_000;

const AMBIGUOUS_TITLE = 'Avatar';
const PICK_TITLE = 'Avatar: The Way of Water';
const PICK_YEAR = '2022';

async function gotoHome(page: Page): Promise<void> {
  await page.goto(`${BASE}/home`);
  await page.waitForSelector('[data-testid="home-screen-create-button"]', { state: 'visible', timeout: 60000 });
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

test.describe('Assistant disambiguation buttons (013 US4)', () => {
  test.skip(
    process.env['E2E_AGENT_PRODUCTION'] !== '1',
    'Needs the production-node gateway. Run with E2E_AGENT_PRODUCTION=1.',
  );

  test.afterEach(async ({ request }) => {
    await cleanupNonFixtureCollections(request);
  });

  test('ambiguous look-up renders buttons; tapping one proceeds with that match (US4-AC1/AC2)', async ({
    page,
  }) => {
    test.setTimeout(360_000);

    await gotoHome(page);
    await openDock(page);

    // Turn 1: ambiguous title → the curator offers selectable option buttons.
    await send(page, `look up ${AMBIGUOUS_TITLE}`);
    const options = page.locator('[data-testid="disambiguation-options"]').last();
    await expect(options).toBeVisible({ timeout: OFFER_TIMEOUT });
    // At least the first candidate button is present.
    await expect(page.locator('[data-testid="disambig-option-0"]').last()).toBeVisible();
    // No write proposed (enrich-only).
    await expect(page.locator('[data-testid="approval-request"]')).toHaveCount(0);

    // Tap the NON-FIRST candidate button by its label — selecting it without typing.
    await options.getByText(PICK_TITLE, { exact: false }).first().click();

    // The curator resolves the tapped pick and renders that film's card (2022, not bare 2009).
    const card = page.locator('[data-testid="render-movie-card"]').last();
    await expect(card).toBeVisible({ timeout: CARD_TIMEOUT });
    await expect(card.locator('[data-testid="render-movie-card-title"]')).toContainText(PICK_TITLE);
    await expect(card.locator('[data-testid="render-movie-card-year"]')).toContainText(PICK_YEAR);
    await expect(page.locator('[data-testid="approval-request"]')).toHaveCount(0);
  });
});
