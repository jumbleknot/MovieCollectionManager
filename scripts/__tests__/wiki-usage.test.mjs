// Feature 078 US4 — every run records what it cost (FR-010, FR-011, SC-005).
//
// The tap (wiki-usage-tap.mjs) writes one line of counts per model call. This is the pure half that
// turns those lines into a per-invocation summary priced from a dated table. The rule that matters
// most is the negative one: missing usage is reported as "not captured", NEVER as zero — a run that
// silently recorded $0 would be the cheapest-looking run in the history and the least true.
//
// Deterministic, offline, token-free.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { summarizeUsage, sumUsage, NOT_CAPTURED } from '../wiki-usage.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// The arithmetic tests price from a FROZEN fixture: their premise is "a run is priced from a dated table",
// not "the table holds these rates". They used to read the real table, so correcting a rate (T023a: the
// 2026-09-27 Fireworks rates under-priced the bill by 1.43×) would have broken tests that never cared
// which rates were in force. What the real table must satisfy is the reconciliation guard at the end.
const PRICES = {
  asOf: '2026-09-27',
  providers: {
    anthropic: { standard: { uncached: 2.0, cached: 0.2, cacheWrite: 2.5, output: 10.0 } },
    fireworks: {
      standard: { uncached: 0.22, cached: 0.007, cacheWrite: 0, output: 0.66 },
      priority: { uncached: 0.275, cached: 0.00875, cacheWrite: 0, output: 0.825 },
    },
  },
};
const TABLE = JSON.parse(readFileSync(join(REPO_ROOT, 'scripts', 'wiki-provider-prices.json'), 'utf8'));

const line = (o) => JSON.stringify({ kind: 'page', status: 200, ms: 1000, uncached: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, ...o });

test('two calls are summed and priced from the table (Fireworks standard)', () => {
  const text = [line({ uncached: 100_000, cached: 1_000_000, output: 10_000, ms: 4000 }), line({ kind: 'plan', uncached: 50_000, output: 5_000, ms: 2000 })].join('\n');
  const u = summarizeUsage(text, { provider: 'fireworks', model: 'm', tier: null, prices: PRICES });
  assert.equal(u.calls, 2);
  assert.equal(u.uncached, 150_000);
  assert.equal(u.cached, 1_000_000);
  assert.equal(u.output, 15_000);
  assert.equal(u.ms, 6000);
  // 150k × $0.22 + 1M × $0.007 + 15k × $0.66 = 0.033 + 0.007 + 0.0099
  assert.equal(u.estCostUsd, 0.0499);
  assert.equal(u.priceTable, PRICES.asOf, 'the record names the table it was priced from');
});

test('the priority tier is priced at its own rates', () => {
  const text = line({ uncached: 1_000_000 });
  const std = summarizeUsage(text, { provider: 'fireworks', model: 'm', tier: null, prices: PRICES });
  const pri = summarizeUsage(text, { provider: 'fireworks', model: 'm', tier: 'priority', prices: PRICES });
  assert.equal(std.estCostUsd, 0.22);
  assert.equal(pri.estCostUsd, 0.275);
});

test('Anthropic cache writes are priced separately from cache reads', () => {
  const u = summarizeUsage(line({ cacheWrite: 1_000_000, cached: 1_000_000 }), { provider: 'anthropic', model: 'claude-sonnet-5', tier: null, prices: PRICES });
  assert.equal(u.estCostUsd, 2.7, '1M written at $2.50 + 1M read at $0.20');
});

test('no lines is NOT CAPTURED — never zero', () => {
  for (const text of ['', '\n', null, undefined]) {
    assert.equal(summarizeUsage(text, { provider: 'fireworks', model: 'm', tier: null, prices: PRICES }), NOT_CAPTURED);
  }
});

test('non-200 calls and tap errors are counted, so a rate-limited run is visible', () => {
  const text = [line({ uncached: 10 }), line({ status: 429 }), JSON.stringify({ kind: 'page', status: 200, ms: 5, tapError: 'SyntaxError' })].join('\n');
  const u = summarizeUsage(text, { provider: 'fireworks', model: 'm', tier: null, prices: PRICES });
  assert.equal(u.calls, 3);
  assert.equal(u.failedCalls, 1);
  assert.equal(u.uncounted, 1, 'a call whose usage could not be read is admitted, not silently dropped');
});

test('a price table that does not know the provider/tier refuses to guess', () => {
  assert.throws(() => summarizeUsage(line({ uncached: 1 }), { provider: 'fireworks', model: 'm', tier: 'bogus', prices: PRICES }), /price/i);
});

test('the reasoning effort is carried into the summary and the run total, and does not change the price', () => {
  const text = line({ uncached: 1_000_000 });
  const plain = summarizeUsage(text, { provider: 'fireworks', model: 'm', tier: null, prices: PRICES });
  const low = summarizeUsage(text, { provider: 'fireworks', model: 'm', tier: null, reasoningEffort: 'low', prices: PRICES });
  assert.equal(plain.reasoningEffort, null);
  assert.equal(low.reasoningEffort, 'low');
  assert.equal(low.estCostUsd, plain.estCostUsd, 'Fireworks bills reasoning as output tokens; the effort has no price row');
  assert.equal(sumUsage([low]).reasoningEffort, 'low');
});

test('summing across invocations keeps "not captured" honest', () => {
  const a = summarizeUsage(line({ uncached: 1_000_000 }), { provider: 'fireworks', model: 'm', tier: null, prices: PRICES });
  const total = sumUsage([a, NOT_CAPTURED]);
  assert.equal(total.estCostUsd, 0.22);
  assert.equal(total.invocationsNotCaptured, 1, 'a partial total says it is partial');
  assert.equal(sumUsage([NOT_CAPTURED]), NOT_CAPTURED);
});

test('the price table is dated and covers every provider row', async () => {
  const { WIKI_PROVIDERS } = await import('../wiki-provider.mjs');
  assert.match(TABLE.asOf, /^\d{4}-\d{2}-\d{2}$/);
  for (const [name, row] of Object.entries(WIKI_PROVIDERS)) {
    assert.ok(TABLE.providers[name]?.standard, `${name}: standard prices`);
    for (const tier of row.tiers) assert.ok(TABLE.providers[name][tier], `${name}: ${tier} prices`);
  }
});

// SC-005 / T023a: the real table must price a billed window to within 5% of the bill. The window is
// 2026-10-01 00:00 → 10-07 23:59 UTC: 24 CI runs whose recorded tokens matched the Fireworks console
// day by day (research R14, "SC-005 reconciled"), against a console bill of ≈ $10.08. The 2026-09-27
// rates priced it at $7.03 (−30%); the operator's corrected standard rates at $9.997 (−0.8%). If
// Fireworks changes a rate, re-measure a window against the console and update both this and the table.
test('the real Fireworks standard rates reconcile the R14 billed window within 5% (SC-005)', () => {
  const window = line({ uncached: 12_226_337, cached: 231_915_448, output: 4_114_894 });
  const u = summarizeUsage(window, { provider: 'fireworks', model: 'm', tier: null, prices: TABLE });
  const bill = 10.08;
  const delta = Math.abs(u.estCostUsd - bill) / bill;
  assert.ok(delta <= 0.05, `estimate $${u.estCostUsd} is ${(delta * 100).toFixed(1)}% from the $${bill} bill`);
});

// 078 US6 / FR-022 (review I2): a run whose invocations ran at different efforts must not report
// the first one's effort for the whole run's tokens.
test('a run total over invocations at different efforts says "mixed"', () => {
  const a = summarizeUsage(line({ uncached: 1 }), { provider: 'fireworks', model: 'm', tier: null, reasoningEffort: 'low', prices: PRICES });
  const b = summarizeUsage(line({ uncached: 1 }), { provider: 'fireworks', model: 'm', tier: null, prices: PRICES });
  assert.equal(sumUsage([a, b]).reasoningEffort, 'mixed');
  assert.equal(sumUsage([a, a]).reasoningEffort, 'low');
  assert.equal(sumUsage([b, b]).reasoningEffort, null);
});
