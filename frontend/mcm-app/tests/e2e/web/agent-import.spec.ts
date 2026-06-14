/**
 * T040 (web E2E): Import a spreadsheet by conversation — the US2 journey end-to-end.
 *
 * The import is started by TYPING the request (there is no always-on upload button — 014 UX fix):
 * the assistant replies with a "Choose file…" affordance; choosing a CSV whose tab name (filename
 * stem) matches a seeded collection → the assistant parses it, maps columns, and previews behind a
 * confirm-once SUMMARY card (per-tab counts, not a per-movie wall — 014 UX fix; nothing written
 * pre-approval, SC-009). Approving creates exactly the planned movies; re-running is idempotent (0
 * new). Drives the full live stack: dock → BFF /import-upload + /run → production gateway →
 * spreadsheet-mcp parse + movie-mcp add → mc-service.
 *
 * A multi-row in-memory CSV (not the 200-row sample fixture) keeps the run inside the access-token
 * window while still exercising a multi-movie summary. The filename matches the collection so no
 * tab→collection disambiguation is needed (that path is T056). Requires E2E_AGENT_PRODUCTION=1 +
 * the containerized stack.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

import { E2E_BASE_URL as BASE } from './setup/target';
import { cleanupNonFixtureCollections } from './setup/e2e-cleanup';

const PREVIEW_TIMEOUT = 150_000;
const DONE_TIMEOUT = 120_000;
// 60 rows deliberately exceeds the gateway's per-agent tool-call cap (30/60s) — the approved import
// apply must NOT be throttled (014 bug: a 200-row import applied only 30, failed 170). The unit
// suite proves arbitrary scale; this keeps a fast live guard above the cap.
const IMPORT_ROWS = Array.from({ length: 60 }, (_, i) => `Zormovie${String(i).padStart(3, '0')}`);

function importCsv(): string {
  return (
    'Title,Year,Video Type\n' +
    IMPORT_ROWS.map((t, i) => `${t},${1960 + i},Movie`).join('\n') +
    '\n'
  );
}

// Page through the cursor-paginated movie list (batch size 50) — a 60-row import spans 2 pages.
async function movieTitles(request: APIRequestContext, collectionId: string): Promise<Set<string>> {
  const titles = new Set<string>();
  let cursor: string | undefined;
  for (let i = 0; i < 20; i += 1) {
    const url = `/bff-api/collections/${collectionId}/movies${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await request.get(url);
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as { items?: { title: string }[]; nextCursor?: string | null };
    for (const m of body.items ?? []) titles.add(m.title);
    if (!body.nextCursor) break;
    cursor = body.nextCursor;
  }
  return titles;
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

/**
 * Start the import by TYPING (no always-on button) → the assistant asks for a file → pick the CSV.
 * Mirrors the real UX: the file picker is surfaced by the assistant's request_import_file response,
 * not an always-present upload button.
 */
async function startImportByTyping(page: Page, filename: string, csv: string): Promise<void> {
  // Bare "import movies" (the exact phrase that misrouted to navigate — 014 Bug 1) must reach the
  // import flow: the assistant asks for a file rather than asking which collection to open.
  await page.fill('[data-testid="assistant-dock-input"]', 'import movies');
  await page.click('[data-testid="assistant-dock-send"]');
  await page.waitForSelector('[data-testid="request-import-file-choose"]', {
    state: 'visible',
    timeout: PREVIEW_TIMEOUT,
  });
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.click('[data-testid="request-import-file-choose"]'),
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

  test('type → choose file → summary preview → approve creates exactly the rows; re-run idempotent', async ({
    page,
    request,
  }) => {
    test.setTimeout(360_000);
    const name = `t040-imp-${Date.now()}`;
    const collectionId = await seedEmptyCollection(request, name);
    const csv = importCsv();

    await gotoHome(page);
    await openDock(page);
    await startImportByTyping(page, `${name}.csv`, csv); // filename stem == collection name → no disambiguation

    // A single confirm-once SUMMARY card (NOT a per-item wall) appears behind the approval gate —
    // nothing written yet (SC-009). The Approve button is reachable regardless of row count.
    const preview = page.locator('[data-testid="import-preview"]');
    await expect(preview).toBeVisible({ timeout: PREVIEW_TIMEOUT });
    await expect(page.locator('[data-testid="import-preview-total"]')).toContainText(
      `${IMPORT_ROWS.length} to add`,
    );
    await expect(page.locator('[data-testid="import-preview-approve"]')).toBeVisible();
    expect(await movieTitles(request, collectionId)).toEqual(new Set());

    await page.click('[data-testid="import-preview-approve"]');
    // Wait for the writes to ACTUALLY land before asserting — the assistant summary streams before
    // add_movie completes, so a single immediate GET races the still-in-flight async write (and the
    // afterEach cleanup). Poll the collection until every movie appears (see
    // agent-import-disambiguate for the full root-cause trace).
    await expect
      .poll(async () => [...(await movieTitles(request, collectionId))].sort(), {
        timeout: DONE_TIMEOUT,
        message: 'the imported movies should land in the collection',
      })
      .toEqual([...IMPORT_ROWS].sort());

    // Re-run the identical import → idempotent: still exactly the same movies (SC-005).
    await startImportByTyping(page, `${name}.csv`, csv);
    const preview2 = page.locator('[data-testid="import-preview"]');
    if (await preview2.isVisible({ timeout: PREVIEW_TIMEOUT }).catch(() => false)) {
      await page.click('[data-testid="import-preview-approve"]');
      await page.waitForTimeout(3000);
    }
    expect(await movieTitles(request, collectionId)).toEqual(new Set(IMPORT_ROWS));
  });
});
