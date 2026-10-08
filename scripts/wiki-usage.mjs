// wiki-usage.mjs — turn the usage tap's per-call lines into a priced, per-invocation summary
// (feature 078 US4, FR-010/FR-011, SC-005).
//
// Pure: no IO beyond what the caller passes in. The price table (wiki-provider-prices.json) is dated,
// and the date travels into every summary, so a figure in the run record always says what it was
// computed from. The estimate reconciled with the Fireworks bill to the cent on the research probes.
//
// The negative rule is the load-bearing one: no usage lines means NOT_CAPTURED, never zero. A run
// recorded as costing $0 would be the cheapest-looking run in the history and the least true one.

export const NOT_CAPTURED = 'not captured';

const TOKEN_FIELDS = ['uncached', 'cached', 'cacheWrite', 'output'];
const round4 = (x) => Math.round(x * 1e4) / 1e4;

function priceRow(prices, provider, tier) {
  const row = prices?.providers?.[provider]?.[tier ?? 'standard'];
  if (!row || TOKEN_FIELDS.some((f) => typeof row[f] !== 'number')) {
    throw new Error(`no price for ${provider}/${tier ?? 'standard'} in the price table (${prices?.asOf ?? 'undated'}) — add it rather than guess`);
  }
  return row;
}

/**
 * Summarize one invocation's usage log text. Returns NOT_CAPTURED when there are no lines.
 * Throws when the price table does not cover the provider/tier — an unpriced figure is not reported.
 */
export function summarizeUsage(text, { provider, model, tier = null, reasoningEffort = null, prices }) {
  const lines = (text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return NOT_CAPTURED;
  const row = priceRow(prices, provider, tier);

  const total = { calls: 0, failedCalls: 0, uncounted: 0, uncached: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, ms: 0 };
  for (const raw of lines) {
    let call;
    try { call = JSON.parse(raw); } catch { total.calls++; total.uncounted++; continue; }
    total.calls++;
    total.ms += call.ms ?? 0;
    if (call.status !== 200) total.failedCalls++;
    if (call.tapError) { total.uncounted++; continue; }
    for (const f of [...TOKEN_FIELDS, 'reasoning']) total[f] += call[f] ?? 0;
  }
  const estCostUsd = round4(TOKEN_FIELDS.reduce((sum, f) => sum + (total[f] * row[f]) / 1e6, 0));
  return { provider, model, tier, reasoningEffort, ...total, estCostUsd, priceTable: prices.asOf };
}

/** Sum invocation summaries into a run total. Partial totals say how many invocations are missing. */
export function sumUsage(summaries) {
  const captured = summaries.filter((s) => s && s !== NOT_CAPTURED);
  if (captured.length === 0) return NOT_CAPTURED;
  const out = { invocations: summaries.length, invocationsNotCaptured: summaries.length - captured.length };
  for (const f of ['calls', 'failedCalls', 'uncounted', 'uncached', 'cached', 'cacheWrite', 'output', 'reasoning', 'ms']) {
    out[f] = captured.reduce((sum, s) => sum + (s[f] ?? 0), 0);
  }
  out.estCostUsd = round4(captured.reduce((sum, s) => sum + s.estCostUsd, 0));
  out.provider = captured[0].provider;
  out.model = captured[0].model;
  out.tier = captured[0].tier;
  // 078 FR-022: invocations at different efforts (an escalated one beside default ones) are 'mixed';
  // naming the first one's effort would misattribute the whole run's tokens to it.
  const efforts = new Set(captured.map((s) => s.reasoningEffort ?? null));
  out.reasoningEffort = efforts.size > 1 ? 'mixed' : (captured[0].reasoningEffort ?? null);
  out.priceTable = captured[0].priceTable;
  return out;
}
