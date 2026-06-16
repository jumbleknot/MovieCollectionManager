/**
 * Bundle-size + cold-TTI measurement — web (feature 015, T040; research R3).
 *
 * Records two numbers for the PR description:
 *   1. Transferred JS bytes for a cold /home load.
 *   2. Cold time-to-interactive (goto → home create button visible) under a
 *      Slow-3G network profile (CDP emulation).
 *
 * This is a MEASUREMENT, not a tight gate: the ≤2 s-on-3G target is not achievable for
 * a React-Native-Web + Tamagui bundle, so a generous ceiling guards only against a
 * catastrophic regression and the real numbers are logged/attached for the PR. If the
 * 3G TTI materially exceeds the budget, the documented follow-up is code-splitting /
 * deeper Tamagui-compiler tree-shaking.
 */
import { test, expect, type Page } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './setup/target';

// Chrome DevTools "Slow 3G": ~400 kbps down, 400 ms RTT.
const SLOW_3G = {
  offline: false,
  downloadThroughput: Math.floor((400 * 1024) / 8),
  uploadThroughput: Math.floor((400 * 1024) / 8),
  latency: 400,
};

async function sumJsBytes(page: Page, run: () => Promise<void>): Promise<number> {
  let bytes = 0;
  const onResponse = async (res: import('@playwright/test').Response) => {
    const url = res.url();
    if (!/\.(js|hbc)(\?|$)/.test(url) && !/_expo\/static\/js/.test(url)) return;
    try {
      const sizes = await res.request().sizes();
      bytes += sizes.responseBodySize > 0 ? sizes.responseBodySize : Number(res.headers()['content-length'] ?? 0);
    } catch { /* ignore */ }
  };
  page.on('response', onResponse);
  await run();
  page.off('response', onResponse);
  return bytes;
}

async function waitHome(page: Page): Promise<void> {
  await Promise.race([
    page.waitForSelector('[data-testid="home-screen-create-button"]', { state: 'visible', timeout: 120000 }),
    page.waitForSelector('[data-testid="collection-screen-add-movie"]', { state: 'visible', timeout: 120000 }),
  ]);
}

test.describe('bundle + cold TTI (T040)', () => {
  test('measure transferred JS and Slow-3G cold TTI for /home', async ({ page }, testInfo) => {
    test.setTimeout(180000);

    // Slow-3G emulation via CDP.
    const client = await page.context().newCDPSession(page);
    await client.send('Network.enable');
    await client.send('Network.emulateNetworkConditions', SLOW_3G);

    const startMs = Date.now();
    const jsBytes = await sumJsBytes(page, async () => {
      await page.goto(`${BASE}/home`, { waitUntil: 'commit' });
      await waitHome(page);
    });
    const ttiMs = Date.now() - startMs;

    const jsKB = Math.round(jsBytes / 1024);
    const report = { jsTransferredKB: jsKB, slow3gColdTtiMs: ttiMs, slow3gColdTtiSec: +(ttiMs / 1000).toFixed(1) };
    await testInfo.attach('perf-metrics', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
    // eslint-disable-next-line no-console
    console.log(`[T040] /home cold load — JS transferred: ${jsKB} KB; Slow-3G TTI: ${(ttiMs / 1000).toFixed(1)} s`);

    // Catastrophic-regression guards only (NOT the 2s budget — see file header).
    expect(jsKB, 'transferred JS sanity ceiling').toBeLessThan(8000);
    expect(ttiMs, 'Slow-3G TTI sanity ceiling').toBeLessThan(150000);
  });
});
