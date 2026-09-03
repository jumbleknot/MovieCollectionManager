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
import { test, expect } from './fixtures/worker-session';
import { type APIRequestContext, type Page } from '@playwright/test';

import { E2E_BASE_URL as BASE } from './setup/target';
import { requireAgentStack } from './setup/agent-stack-gate';
import { cleanupOwnedCollections, ownCollection } from './setup/e2e-cleanup';
import { awaitTurn, beginTurn, branchNotOffered, offeredSelection } from './setup/assistant-turn';

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
  requireAgentStack(test);

  test.afterEach(async ({ request }) => {
    await cleanupOwnedCollections(request);
  });

  // The US4 multi-turn import disambiguation works end-to-end live (buttons → pick → preview →
  // approve → write). The earlier "deferred" framing (import_stage not surviving / re-parsing the
  // handle) was WRONG: a full single-attempt gateway+mc-service trace showed the continuation is
  // sound and the single-use handle is never re-parsed. The flake was the assertion racing the
  // async write — the assistant summary streams BEFORE add_movie lands, so the old loose done-text
  // match + a single immediate GET let the test (and its afterEach cleanup) tear down first; the
  // late write then hit the just-deleted collection (a CORRECT 404, not an mc-service bug). The fix
  // is the poll below: wait for the imported movie to actually land before asserting/teardown.
  test('unmatched tab → collection buttons → pick → approve creates in the chosen collection', { tag: '@gate' }, async ({
    page,
    request,
  }) => {
    test.setTimeout(360_000);
    const name = `t056-target-${Date.now()}`;
    ownCollection(name);
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
    // Read the reply count BEFORE the upload. Choosing the file uploads it and then sends the
    // import turn, and the wait below is "one more reply than there were" — not "at least one",
    // which the assistant's earlier "choose a file" reply would already satisfy.
    const beforeImportTurn = await beginTurn(page);
    await chooser.setFiles({ name: `unmatched-${Date.now()}.csv`, mimeType: 'text/csv', buffer: Buffer.from(csv) });

    // ── Wait for the TURN, then look at what it produced (064 US3, item #337) ─────────────────
    //
    // This used to wait 150 s for `selection-options` directly, and failed BOTH attempts on CI run
    // 2541 — blocking a comment-only pull request (#339). It was read for three sessions as the
    // model declining to disambiguate. It was not: the client's own `if (agent.isRunning) return`
    // dropped the import turn after the upload had already staged the file server-side, so no turn
    // ever reached the gateway and the element could not appear. Separating the two waits is what
    // makes those two failures tell themselves apart.
    await awaitTurn(page, beforeImportTurn, PROMPT_TIMEOUT);

    // The disambiguation itself is NOT a model decision. `resolve_tab_collection`
    // (nodes/import_collection.py) asks whenever the tab name has 0 or >1 exact case-folded
    // collection matches, and a tab named `unmatched-<epoch>` can only ever be 0. So once the turn
    // is routed to `import`, the buttons are guaranteed by pure code — which is why this stays in
    // the gate. What can still vary is the supervisor's classification, and that is what the
    // failure message below sends the reader to read.
    const options = await offeredSelection(page);
    if (!options) throw new Error(branchNotOffered('a collection choice for the unmatched tab'));
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
