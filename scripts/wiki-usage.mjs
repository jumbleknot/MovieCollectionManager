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

/**
 * Item #719: the tap's page-attributed lines, grouped by page — how many calls each worker made, its
 * largest prompt, whether it ever called submit_page, and its last `tail` calls (finish reason, tool
 * names, unparseable arguments). The last calls are what tell a truncated turn (`length`), a turn that
 * simply stopped (`stop` with no tool call) and a malformed tool call apart. Lines without a page
 * (planner calls, older taps) are skipped.
 */
export function pageTrails(text, { tail = 3 } = {}) {
  const trails = {};
  for (const raw of (text ?? '').split('\n')) {
    let call;
    try { call = JSON.parse(raw); } catch { continue; }
    if (typeof call?.page !== 'string') continue;
    const t = (trails[call.page] ??= { calls: 0, maxPrompt: 0, badArgs: 0, submitted: false, last: [] });
    t.calls += 1;
    t.maxPrompt = Math.max(t.maxPrompt, (call.uncached ?? 0) + (call.cached ?? 0) + (call.cacheWrite ?? 0));
    t.badArgs += call.badArgs ?? 0;
    if ((call.tools ?? []).includes('submit_page')) t.submitted = true;
    t.last.push({ status: call.status, finish: call.finish ?? null, tools: call.tools ?? null, badArgs: call.badArgs ?? 0 });
    if (t.last.length > tail) t.last.shift();
  }
  return trails;
}

/** One line per page for the job log, which is what reaches the failure bundle. */
export function formatPageTrail(page, trail) {
  if (!trail) return `${page}: no page-attributed calls in the usage log`;
  const step = (c) => `${c.status === 200 ? '' : `HTTP ${c.status} `}${c.finish ?? '?'}[${(c.tools ?? []).join(',')}${c.badArgs > 0 ? ' ✗args' : ''}]`;
  return `${page}: ${trail.calls} call(s), max prompt ${trail.maxPrompt}, `
    + `${trail.submitted ? 'called submit_page' : 'never called submit_page'}`
    + `${trail.badArgs > 0 ? `, ${trail.badArgs} call(s) with unparseable tool arguments` : ''}`
    + ` — last: ${trail.last.map(step).join(' → ')}`;
}
