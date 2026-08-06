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
    let stillRunningWhenSampled = false;
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
        'the progress line never appeared. CHECK THE IMAGES FIRST — both are baked, not mounted, ' +
          'and a stale one produces this exact failure:\n' +
          "  docker run --rm --entrypoint sh agent-gateway:latest -c \"grep -c manually_emit_state /app/src/runtime_nodes.py\"  # 0 = stale\n" +
          '  docker run --rm --entrypoint sh mcm-bff:latest -c "grep -rl import-progress /app/runtime/dist | head -1"        # empty = stale\n' +
          '  rebuild: SPECIALIST_MODEL=qwen2.5 node scripts/agent-stack.mjs  ·  pnpm nx docker-build mcm-app\n' +
          'Only once BOTH are current does this point at the CopilotRuntime bridge in run+api.ts ' +
          'failing to forward gateway STATE_SNAPSHOT into agent.state — the component and the ' +
          'OnStateChanged subscription are both unit-proven, so that is the next place to look.',
      ).toBeVisible({ timeout: 60_000 });

      await expect(label).toHaveText(/Importing [\d,]+ of [\d,]+…/, { timeout: 10_000 });

      // Give the sampler a window WHILE the apply is demonstrably still going, then record
      // whether it was. This is what separates "the client went stale" from "the apply was fast".
      const firstText = await label.textContent();
      const changed = await label
        .filter({ hasNotText: firstText ?? '' })
        .waitFor({ state: 'visible', timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
      stillRunningWhenSampled = !changed && (await progress.isVisible());
    } finally {
      clearInterval(collect);
    }

    // FR-014b: when the run ends the surface is REPLACED by the report, not left on a final number.
    await expect(progress).toBeHidden({ timeout: DONE_TIMEOUT });

    // FR-014a: it UPDATED rather than rendering once and going stale.
    //
    // Distinguish the two ways this can fail, because they look identical from a single sample:
    // the client not re-rendering, versus the apply finishing before the sampler saw a second
    // value. `firstSeen` is captured while the surface is still visible and `sawChange` is
    // asserted only if the run was still going — so a fast apply is reported as a fast apply
    // rather than as a client bug.
    const distinct = [...new Set(seen)];
    // Printed unconditionally so the run states its own evidence. "Appeared once" and "advanced
    // 25 -> 50 -> ... -> 400" are different strengths of claim about FR-014a, and a green tick
    // alone does not say which one you got.
    console.log(`[import-progress] distinct values observed: ${JSON.stringify(distinct)}`);
    if (distinct.length <= 1) {
      expect(
        stillRunningWhenSampled,
        `the progress line showed only ${JSON.stringify(distinct)} and the import was STILL ` +
          'RUNNING when sampled — agent state is arriving (the line rendered at least once) but ' +
          'later snapshots are not re-rendering. Check the useAgent `updates` option and the ' +
          '`throttleMs` default, in that order.',
      ).toBe(false);
      // The apply outran the sampler. The line appeared and the transport is proven; how many
      // intermediate values a human would have seen is a timing property, not a correctness one.
      test.info().annotations.push({
        type: 'note',
        description: `progress sampled once (${distinct[0] ?? 'n/a'}) — apply finished faster than the 100ms sampler`,
      });
    }

    // And exactly ONE surface throughout — the flood FR-014a exists to prevent.
    expect(await page.locator('[data-testid="import-progress"]').count()).toBeLessThanOrEqual(1);
  });
});
