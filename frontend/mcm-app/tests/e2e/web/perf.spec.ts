/**
 * Cold-load budget — web (feature 015 T040, tightened by feature 077 / item #558).
 *
 * Records, and now GATES, two numbers for /home:
 *   1. Transferred JS bytes before the screen is interactive.
 *   2. Cold time-to-interactive under a Slow-3G network profile (CDP emulation).
 *
 * THE CONSTITUTION'S 2-SECOND-ON-3G FIGURE DOES NOT APPLY TO THIS PAGE, and that is recorded
 * rather than tacitly ignored: constitution v2.5.0 carries an **accepted exception** for the
 * mcm-app web client's cold load (backlog item #565). ~1,000 KB of the remaining entry chunk is
 * `expo-router` + `react-native-web` + `react-dom` + `@tamagui/web` — the cost of rendering any
 * route at all in this stack — so the figure is unreachable without replacing the stack. The
 * exception is bounded by the byte budget below and by
 * `scripts/check-web-bundle-budget.mjs`, NOT open-ended, and the same principle's "bundles must be
 * lazy-loaded" clause is in force: that is what the deferred chunk assertion here defends.
 *
 * FEATURE 077 TURNED THIS FROM A MEASUREMENT INTO A BUDGET. It used to carry deliberately
 * generous ceilings (8,000 KB / 150 s) because the single 4.3 MB chunk left nothing to be
 * strict about, and the file's own header named the remedy: code-splitting. That remedy
 * shipped. The assistant runtime — the model client, its schema validator, its GraphQL
 * client and the React Native polyfills its packages import as a side effect — now loads
 * in a separate chunk, taking the entry chunk from 4,283,369 to ~1.83 MB (−57%). The
 * ceilings below are set from that, with headroom, so the next ordinary feature cannot
 * quietly spend the win the way item #558 records happening before.
 *
 * WHAT EACH ASSERTION IS FOR — they are not interchangeable, and one of them cannot fail
 * on a pre-077 tree at all:
 *
 *   `jsKB` vs JS_CEILING_KB — the real budget, and the assertion that was RED before the
 *   split (the single chunk transferred ~4,180 KB against a 2,600 KB ceiling).
 *
 *   `ttiMs` vs TTI_CEILING_MS — the user-visible consequence, at ≥50% headroom against
 *   the old 150 s ceiling per the feature's SC-002.
 *
 *   `unexpectedChunks` — a GUARD, not a budget. On a single-chunk bundle it passes
 *   trivially, because the only chunk there IS the entry chunk; it could never have been
 *   this feature's RED. It exists for one specific future regression, and that regression
 *   nearly shipped: put the lazy boundary one level too high — at the dock's `runnable`
 *   gate rather than at the panel — and the deferred chunk is fetched AT MOUNT, inside
 *   this measured window, in parallel with the home screen's own bytes on a serialized
 *   pipe. Byte totals barely move and everything looks merely disappointing. This
 *   assertion names that mistake instead.
 *
 * FR-007 (a non-runnable config must fetch nothing) is NOT asserted here, and that is deliberate. The
 * E2E form of it had to clear the SHARED test user's agent config and re-seed it mid-run, while nine
 * other workers were executing assistant specs that assume a runnable dock —
 * `assistant-config.spec.ts` gates itself behind E2E_AGENT_PRODUCTION for exactly that reason. Shared
 * mutable state in a parallel suite is a defect however careful the teardown looks. The gate is fully
 * determined at unit level and is asserted in `tests/app/(app)/_layout.test.tsx`, with the dock's own
 * suite covering the other half (mounting is what schedules the prefetch).
 *
 * THE WAIT AND THE CEILING ARE ONE CONSTANT, and that is load-bearing. They used to
 * disagree — the wait was 120 s while the assertion allowed 150 s — so any TTI in that
 * 30 s band died as a `TimeoutError` before `ttiMs` was ever computed. Three things
 * followed, all bad: the documented ceiling was unreachable, the failure said "waiting
 * for locator" instead of naming the measured TTI, and the metric this file exists to
 * produce was missing from exactly the runs where it mattered most. A slow load must fail
 * as a NUMBER against a threshold, not as a timeout.
 */
import { test, expect } from './fixtures/worker-session';
import { type Page } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './setup/target';

/**
 * Cold-TTI ceiling, and therefore also the wait.
 *
 * 75 s: at least 50% headroom against the 150 s this guarded before feature 077 (SC-002).
 * The measured entry chunk is 1,762,630 B, about 35 s of transfer at the profile below, so a
 * feature of ordinary size cannot exhaust this the way item #558 documents.
 *
 * The wait must never be TIGHTER than the ceiling or the assertion below is unreachable.
 */
const TTI_CEILING_MS = 75_000;

/**
 * Transferred-JS ceiling for a cold /home, in KB.
 *
 * Kept in step with the on-disk budget `scripts/check-web-bundle-budget.mjs` enforces
 * (2,000,000 B = 1,953 KB) so the two cannot disagree about what "too big" means. Sitting a
 * little above it absorbs the difference between bytes on disk and bytes on the wire without
 * loosening the real limit, which is the disk one.
 *
 * This is the assertion that fails first when the cold-load path grows, and the one that was
 * RED before the split: the single 4.28 MB chunk transferred ~4,180 KB.
 */
const JS_CEILING_KB = 1_950;

// Chrome DevTools "Slow 3G": ~400 kbps down, 400 ms RTT.
const SLOW_3G = {
  offline: false,
  downloadThroughput: Math.floor((400 * 1024) / 8),
  uploadThroughput: Math.floor((400 * 1024) / 8),
  latency: 400,
};

/** A JS asset served out of the Expo web bundle directory. */
const BUNDLE_JS = /_expo\/static\/js\/web\/([^/?]+\.js)/;

type JsTraffic = { bytes: number; chunkNames: string[] };

/**
 * Sum JS bytes AND record which bundle chunks were fetched, over `run`'s lifetime.
 *
 * The two travel together deliberately: the byte total answers "how much", and the chunk
 * list answers "which" — and only the second can tell a deferred chunk that arrived late
 * from one that was never deferred at all.
 */
async function measureJs(page: Page, run: () => Promise<void>): Promise<JsTraffic> {
  let bytes = 0;
  const chunkNames: string[] = [];
  const onResponse = async (res: import('@playwright/test').Response) => {
    const url = res.url();
    if (!/\.(js|hbc)(\?|$)/.test(url) && !/_expo\/static\/js/.test(url)) return;
    const m = BUNDLE_JS.exec(url);
    if (m && !chunkNames.includes(m[1])) chunkNames.push(m[1]);
    try {
      const sizes = await res.request().sizes();
      bytes += sizes.responseBodySize > 0 ? sizes.responseBodySize : Number(res.headers()['content-length'] ?? 0);
    } catch { /* a response whose sizes are gone contributes nothing; the ceiling errs low, never high */ }
  };
  page.on('response', onResponse);
  await run();
  page.off('response', onResponse);
  return { bytes, chunkNames };
}

/**
 * Wait for /home to be interactive. Resolves `false` if the ceiling passes first.
 *
 * It swallows the timeout deliberately. The wait and the ceiling are one constant, so a load slower
 * than the budget necessarily exhausts the wait — and if that surfaced as Playwright's
 * `TimeoutError: waiting for locator`, the run would report a locator problem for what is actually a
 * size regression, with no measured number anywhere. That is the exact failure this file's header
 * warns about, and it is how the pre-077 RED first presented. Returning instead lets the assertions
 * below report `74998 ms against a 75000 ms ceiling` and the chunk list that explains it.
 */
async function waitHome(page: Page): Promise<boolean> {
  try {
    await Promise.race([
      page.waitForSelector('[data-testid="home-screen-create-button"]', { state: 'visible', timeout: TTI_CEILING_MS }),
      page.waitForSelector('[data-testid="collection-screen-add-movie"]', { state: 'visible', timeout: TTI_CEILING_MS }),
    ]);
    return true;
  } catch {
    return false;
  }
}

/** Cold-load /home under Slow-3G and report what crossed the wire before interactive. */
async function coldLoadHome(page: Page): Promise<{ tti: number; interactive: boolean } & JsTraffic> {
  const client = await page.context().newCDPSession(page);
  await client.send('Network.enable');
  await client.send('Network.emulateNetworkConditions', SLOW_3G);

  const startMs = Date.now();
  let interactive = false;
  const traffic = await measureJs(page, async () => {
    await page.goto(`${BASE}/home`, { waitUntil: 'commit' });
    interactive = await waitHome(page);
  });
  return { tti: Date.now() - startMs, interactive, ...traffic };
}

/** Bundle chunks that are not the entry chunk. Empty is the whole point. */
const nonEntryChunks = (names: string[]): string[] => names.filter((n) => !n.startsWith('entry-'));

test.describe('cold-load budget (T040; feature 077)', () => {
  test('/home reaches interactive within the JS and Slow-3G TTI budgets', async ({ page }, testInfo) => {
    test.setTimeout(180_000);

    const { tti, interactive, bytes, chunkNames } = await coldLoadHome(page);
    const jsKB = Math.round(bytes / 1024);
    const unexpected = nonEntryChunks(chunkNames);

    const report = {
      jsTransferredKB: jsKB,
      jsCeilingKB: JS_CEILING_KB,
      slow3gColdTtiMs: tti,
      slow3gColdTtiSec: +(tti / 1000).toFixed(1),
      ttiCeilingMs: TTI_CEILING_MS,
      chunksBeforeInteractive: chunkNames,
      deferredChunkStayedDeferred: unexpected.length === 0,
      reachedInteractive: interactive,
    };
    await testInfo.attach('perf-metrics', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
    // eslint-disable-next-line no-console
    console.log(
      `[T040] /home cold load — JS ${jsKB} KB (ceiling ${JS_CEILING_KB}); Slow-3G TTI ${(tti / 1000).toFixed(1)} s ` +
        `(ceiling ${TTI_CEILING_MS / 1000} s); chunks before interactive: ${chunkNames.join(', ') || 'none'}`,
    );

    expect(jsKB, `transferred JS for a cold /home (chunks: ${chunkNames.join(', ')})`).toBeLessThan(JS_CEILING_KB);
    expect(
      interactive,
      `/home never became interactive within ${TTI_CEILING_MS} ms — it transferred ${jsKB} KB of JS ` +
        `(chunks: ${chunkNames.join(', ') || 'none'}). Over-budget size, not a broken locator.`,
    ).toBe(true);
    expect(tti, 'Slow-3G cold TTI for /home').toBeLessThan(TTI_CEILING_MS);
    // See the header: a guard against the boundary being placed too high, not a budget.
    expect(
      unexpected,
      'a non-entry chunk was fetched BEFORE /home was interactive — the assistant runtime is not ' +
        'actually deferred past interactive (boundary too high, or the prefetch is not on idle)',
    ).toEqual([]);
  });

});
