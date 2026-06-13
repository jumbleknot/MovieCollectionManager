/**
 * T040 (web E2E): Import a spreadsheet by conversation — the US2 journey end-to-end.
 *
 * Upload a small CSV whose tab name (filename stem) matches a seeded collection → the assistant
 * parses it, maps high-confidence columns, previews behind the explicit approval gate (nothing
 * written pre-approval, SC-009), and on approval creates exactly the planned movies. Re-running the
 * same import is idempotent (0 new). Drives the full live stack: dock → BFF /import-upload +
 * /run → production gateway → spreadsheet-mcp parse + movie-mcp add → mc-service.
 *
 * A tiny in-memory CSV (not the 200-row sample fixture) keeps the run inside the access-token
 * window. The filename matches the collection so no tab→collection disambiguation is needed
 * (that path is T056). Requires E2E_AGENT_PRODUCTION=1 + the containerized stack.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

import { E2E_BASE_URL as BASE } from './setup/target';
import { cleanupNonFixtureCollections } from './setup/e2e-cleanup';

const PREVIEW_TIMEOUT = 150_000;
const DONE_TIMEOUT = 90_000;

async function movieTitles(request: APIRequestContext, collectionId: string): Promise<Set<string>> {
  const res = await request.get(`/bff-api/collections/${collectionId}/movies`);
  expect(res.ok()).toBeTruthy();
  const items = ((await res.json()).items ?? []) as { title: string }[];
  return new Set(items.map((m) => m.title));
}

async function seedEmptyCollection(request: APIRequestContext, name: string): Promise<string> {
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

async function uploadCsv(page: Page, filename: string, csv: string): Promise<void> {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.click('[data-testid="spreadsheet-import-button"]'),
  ]);
  await chooser.setFiles({ name: filename, mimeType: 'text/csv', buffer: Buffer.from(csv) });
}

test.describe('Assistant import flow (feature 014, US2 / T040)', () => {
  test.skip(
    process.env['E2E_AGENT_PRODUCTION'] !== '1',
    'Needs the production-node containerized gateway + spreadsheet-mcp. Run with E2E_AGENT_PRODUCTION=1.',
  );

  test.afterEach(async ({ request }) => {
    await cleanupNonFixtureCollections(request);
  });

  test('upload CSV → preview behind approval → approve creates exactly the rows; re-run idempotent', async ({
    page,
    request,
  }) => {
    test.setTimeout(360_000);
    const name = `t040-imp-${Date.now()}`;
    const collectionId = await seedEmptyCollection(request, name);
    const csv = 'Title,Year,Video Type\nZorgon,1999,Movie\nQuaffle,2001,Movie\n';

    await gotoHome(page);
    await openDock(page);
    await uploadCsv(page, `${name}.csv`, csv); // filename stem == collection name → no disambiguation

    // Preview appears behind the approval gate — nothing written yet (SC-009).
    const approval = page.locator('[data-testid="approval-request"]');
    await expect(approval).toBeVisible({ timeout: PREVIEW_TIMEOUT });
    expect(await movieTitles(request, collectionId)).toEqual(new Set());

    await page.click('[data-testid="approval-approve"]');
    await expect(page.locator('[data-testid="assistant-msg-assistant"]').last()).toContainText(
      /import|done|added|created/i,
      { timeout: DONE_TIMEOUT },
    );

    expect(await movieTitles(request, collectionId)).toEqual(new Set(['Zorgon', 'Quaffle']));

    // Re-run the identical import → idempotent: still exactly the two movies (SC-005).
    await uploadCsv(page, `${name}.csv`, csv);
    const approval2 = page.locator('[data-testid="approval-request"]');
    if (await approval2.isVisible({ timeout: PREVIEW_TIMEOUT }).catch(() => false)) {
      await page.click('[data-testid="approval-approve"]');
      await page.waitForTimeout(3000);
    }
    expect(await movieTitles(request, collectionId)).toEqual(new Set(['Zorgon', 'Quaffle']));
  });
});
