/**
 * T049 (web E2E): Export collections by conversation — the US3 journey end-to-end.
 *
 * Ask the assistant to export → it reads the user's collections, builds a multi-tab .xlsx via
 * spreadsheet-mcp, and emits a `download_export` UI-action the client downloads. Asserts a real
 * browser download with an .xlsx filename. Drives the full live stack: dock → BFF /run →
 * production gateway → movie-mcp list → spreadsheet-mcp build → BFF /export-download stream.
 *
 * Requires E2E_AGENT_PRODUCTION=1 + the containerized stack (gateway + spreadsheet-mcp).
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

import { E2E_BASE_URL as BASE } from './setup/target';
import { cleanupNonFixtureCollections } from './setup/e2e-cleanup';

const DOWNLOAD_TIMEOUT = 150_000;

function movieBody(title: string): Record<string, unknown> {
  return {
    title, year: 1999, contentType: 'Movie', language: 'English', owned: true, ripped: false,
    childrens: false, ownedMedia: [], ripQuality: [], genres: ['Sci-Fi'], rated: 'R',
    directors: [], actors: [], tags: [], movieSet: null, originalTitle: null, releaseDate: null,
    outline: null, plot: null, runtime: null, externalIds: [],
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

test.describe('Assistant export flow (feature 014, US3 / T049)', () => {
  test.skip(
    process.env['E2E_AGENT_PRODUCTION'] !== '1',
    'Needs the production-node containerized gateway + spreadsheet-mcp. Run with E2E_AGENT_PRODUCTION=1.',
  );

  test.afterEach(async ({ request }) => {
    await cleanupNonFixtureCollections(request);
  });

  test('ask to export → a multi-tab .xlsx downloads', async ({ page, request }) => {
    test.setTimeout(300_000);
    await seedCollection(request, `t049-exp-${Date.now()}`, ['Zorgon', 'Quaffle']);

    await gotoHome(page);
    await openDock(page);

    const downloadPromise = page.waitForEvent('download', { timeout: DOWNLOAD_TIMEOUT });
    await page.fill('[data-testid="assistant-dock-input"]', 'export my collections to a spreadsheet');
    await page.click('[data-testid="assistant-dock-send"]');

    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
  });
});
