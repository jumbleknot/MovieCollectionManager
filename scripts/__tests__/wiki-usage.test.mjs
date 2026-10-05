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
const PRICES = JSON.parse(readFileSync(join(REPO_ROOT, 'scripts', 'wiki-provider-prices.json'), 'utf8'));

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
  assert.match(PRICES.asOf, /^\d{4}-\d{2}-\d{2}$/);
  for (const [name, row] of Object.entries(WIKI_PROVIDERS)) {
    assert.ok(PRICES.providers[name]?.standard, `${name}: standard prices`);
    for (const tier of row.tiers) assert.ok(PRICES.providers[name][tier], `${name}: ${tier} prices`);
  }
});
