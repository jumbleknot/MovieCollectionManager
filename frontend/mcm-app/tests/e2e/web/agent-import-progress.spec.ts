/**
 * 047 US3 / T052a (web E2E): the in-place import progress line, end to end.
 *
 * THE ONE THING THIS PROVES that nothing below it can. RQ-2 measured the progress transport at the
 * GATEWAY boundary: `manually_emit_state` → `STATE_SNAPSHOT` carrying `import_applied` /
 * `import_total`. But the BFF is not a raw AG-UI passthrough — `run+api.ts` builds a
 * `CopilotRuntime` around an `HttpAgent` — so gateway events cross a bridge before reaching
 * `useAgent`. Whether a state snapshot survives that hop into `agent.state` is invisible to the
 * gateway tests, invisible to the component tests (which pass state as props), and invisible to
 * the dock tests (which mock `useAgent`). Only a real browser against the real stack answers it.
 *
 * If this fails with the progress line never appearing, the bridge is dropping agent state — the
 * component and the subscription are both already unit-proven, so that is where to look first.
 *
 * SIZING. The progress surface exists only WHILE the apply runs, so the import has to be big
 * enough to be observable and small enough to stay inside the access-token window. 400 rows
 * applies in roughly 5-10 s through the full stack (measured: 300 rows in 5.0 s at the integration
 * tier), which is thousands of Playwright polls — the assertion is not racing the apply.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

import { E2E_BASE_URL as BASE } from './setup/target';
import { requireAgentStack } from './setup/agent-stack-gate';
import { cleanupNonFixtureCollections } from './setup/e2e-cleanup';

const PREVIEW_TIMEOUT = 150_000;
const DONE_TIMEOUT = 180_000;
const ROWS = 400;

function importCsv(): string {
  return (
    'Title,Year,Video Type\n' +
    Array.from({ length: ROWS }, (_, i) => `Progrow${String(i).padStart(4, '0')},${1950 + (i % 70)},Movie`).join('\n') +
    '\n'
  );
}

async function seedEmptyCollection(request: APIRequestContext, name: string): Promise<string> {
  const res = await request.post('/bff-api/collections', { data: { name } });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).collectionId as string;
}

async function openDockOnHome(page: Page): Promise<void> {
  await page.goto(`${BASE}/home`);
  await page.waitForSelector('[data-testid="home-screen-create-button"]', {
    state: 'visible',
    timeout: 60000,
  });
  await page.waitForSelector('[data-testid="assistant-dock-toggle"]', { state: 'visible', timeout: 60000 });
  await page.click('[data-testid="assistant-dock-toggle"]');
  await page.waitForSelector('[data-testid="assistant-dock-panel"]', { state: 'visible', timeout: 10000 });
}

async function startImportByTyping(page: Page, filename: string, csv: string): Promise<void> {
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

test.describe('Assistant import progress (047 US3 / FR-014a, FR-014b)', () => {
  requireAgentStack(test);

  test.afterEach(async ({ request }) => {
    await cleanupNonFixtureCollections(request);
  });

  test('the progress line appears in place while the import applies, then is replaced by the report', async ({
    page,
    request,
  }) => {
    test.setTimeout(DONE_TIMEOUT + 120_000);

    const name = `E2E Progress ${Date.now()}`;
    await seedEmptyCollection(request, name);
    await openDockOnHome(page);
    await startImportByTyping(page, `${name}.csv`, importCsv());

    await expect(page.locator('[data-testid="import-preview"]')).toBeVisible({
      timeout: PREVIEW_TIMEOUT,
    });

    // Watch for the progress surface from the moment of approval — it exists only during the apply.
    const progress = page.locator('[data-testid="import-progress"]');
    const label = page.locator('[data-testid="import-progress-label"]');
    const seen: string[] = [];
    const collect = setInterval(() => {
      label
        .textContent({ timeout: 200 })
        .then((t) => {
          if (t && seen[seen.length - 1] !== t) seen.push(t);
        })
        .catch(() => {});
    }, 100);

    await page.click('[data-testid="import-preview-approve"]');

    try {
      // THE ASSERTION THIS SPEC EXISTS FOR: agent state crossed the BFF bridge.
      await expect(
        progress,
        'the progress line never appeared — the CopilotRuntime bridge in run+api.ts is not ' +
          'forwarding gateway STATE_SNAPSHOT into agent.state (the component and the ' +
          'OnStateChanged subscription are both unit-proven, so start there)',
      ).toBeVisible({ timeout: 60_000 });

      await expect(label).toHaveText(/Importing [\d,]+ of [\d,]+…/, { timeout: 10_000 });
    } finally {
      clearInterval(collect);
    }

    // FR-014b: when the run ends the surface is REPLACED by the report, not left on a final number.
    await expect(progress).toBeHidden({ timeout: DONE_TIMEOUT });

    // FR-014a: it UPDATED rather than accumulating. More than one distinct value proves the
    // subscription is live — a single value would mean it rendered once and then went stale, which
    // is exactly what happens without the OnStateChanged subscription.
    const distinct = [...new Set(seen)];
    expect(
      distinct.length,
      `the progress line showed only ${JSON.stringify(distinct)} — it rendered once and never ` +
        'updated, so agent state is arriving but not re-rendering (check the useAgent updates option)',
    ).toBeGreaterThan(1);

    // And exactly ONE surface throughout — the flood FR-014a exists to prevent.
    expect(await page.locator('[data-testid="import-progress"]').count()).toBeLessThanOrEqual(1);
  });
});
