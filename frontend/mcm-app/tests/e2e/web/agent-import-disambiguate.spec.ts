/**
 * T056 (web E2E): Guided import disambiguation — the US4 journey end-to-end.
 *
 * Upload a CSV whose tab name (filename stem) matches NO collection → the assistant asks which
 * collection to import into (buttons, no guessing, SC-006/SC-007). Tapping the target resolves it
 * in pure code (no re-parse of the single-use handle), then the preview appears behind the approval
 * gate; approving creates the movie in the chosen collection (US4-AC1).
 *
 * Requires E2E_AGENT_PRODUCTION=1 + the containerized stack (gateway + spreadsheet-mcp).
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

import { E2E_BASE_URL as BASE } from './setup/target';
import { cleanupNonFixtureCollections } from './setup/e2e-cleanup';

const PROMPT_TIMEOUT = 150_000;
const PREVIEW_TIMEOUT = 150_000;
const DONE_TIMEOUT = 90_000;

async function movieTitles(request: APIRequestContext, collectionId: string): Promise<Set<string>> {
  const res = await request.get(`/bff-api/collections/${collectionId}/movies`);
  expect(res.ok()).toBeTruthy();
  const items = ((await res.json()).items ?? []) as { title: string }[];
  return new Set(items.map((m) => m.title));
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

test.describe('Assistant import disambiguation (feature 014, US4 / T056)', () => {
  test.skip(
    process.env['E2E_AGENT_PRODUCTION'] !== '1',
    'Needs the production-node containerized gateway + spreadsheet-mcp. Run with E2E_AGENT_PRODUCTION=1.',
  );

  test.afterEach(async ({ request }) => {
    await cleanupNonFixtureCollections(request);
  });

  // The US4 multi-turn import disambiguation works end-to-end live (buttons → pick → preview →
  // approve → write). The earlier "deferred" framing (import_stage not surviving / re-parsing the
  // handle) was WRONG: a full single-attempt gateway+mc-service trace showed the continuation is
  // sound and the single-use handle is never re-parsed. The flake was the assertion racing the
  // async write — the assistant summary streams BEFORE add_movie lands, so the old loose done-text
  // match + a single immediate GET let the test (and its afterEach cleanup) tear down first; the
  // late write then hit the just-deleted collection (a CORRECT 404, not an mc-service bug). The fix
  // is the poll below: wait for the imported movie to actually land before asserting/teardown.
  test('unmatched tab → collection buttons → pick → approve creates in the chosen collection', async ({
    page,
    request,
  }) => {
    test.setTimeout(360_000);
    const name = `t056-target-${Date.now()}`;
    const createRes = await request.post('/bff-api/collections', { data: { name } });
    expect(createRes.ok()).toBeTruthy();
    const collectionId = (await createRes.json()).collectionId as string;
    const csv = 'Title,Year,Video Type\nGloopnax,1999,Movie\n';

    await gotoHome(page);
    await openDock(page);

    // The import is started by TYPING (no always-on upload button — 014 UX fix); the assistant then
    // asks for a file. Filename stem matches no collection → it next asks which collection.
    await page.fill('[data-testid="assistant-dock-input"]', 'import my movies from this spreadsheet');
    await page.click('[data-testid="assistant-dock-send"]');
    await page.waitForSelector('[data-testid="request-import-file-choose"]', {
      state: 'visible',
      timeout: PROMPT_TIMEOUT,
    });
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.click('[data-testid="request-import-file-choose"]'),
    ]);
    await chooser.setFiles({ name: `unmatched-${Date.now()}.csv`, mimeType: 'text/csv', buffer: Buffer.from(csv) });

    const options = page.locator('[data-testid="selection-options"]');
    await expect(options).toBeVisible({ timeout: PROMPT_TIMEOUT });
    // Nothing written while disambiguating.
    expect(await movieTitles(request, collectionId)).toEqual(new Set());

    // Pick the seeded collection (reveal the overflow first if needed).
    const targetButton = options.getByText(name, { exact: true });
    if (!(await targetButton.isVisible().catch(() => false))) {
      await page.click('[data-testid="selection-more"]').catch(() => {});
    }
    await targetButton.click();

    // Now the confirm-once summary preview appears behind the approval gate; approve creates the movie.
    const preview = page.locator('[data-testid="import-preview"]');
    await expect(preview).toBeVisible({ timeout: PREVIEW_TIMEOUT });
    await page.click('[data-testid="import-preview-approve"]');

    // Wait for the write to ACTUALLY land before asserting/teardown. The assistant's summary
    // message streams before add_movie completes, so the old loose `/import|done.../` match +
    // single GET let the test (and its afterEach cleanup) race ahead of the still-in-flight write
    // — the late write then hit a just-deleted collection (404) or asserted on an empty one. Poll
    // the collection until the imported movie appears (cleanup runs only after this resolves).
    await expect
      .poll(async () => [...(await movieTitles(request, collectionId))], {
        timeout: DONE_TIMEOUT,
        message: 'the imported movie should land in the chosen collection',
      })
      .toEqual(['Gloopnax']);
  });
});
