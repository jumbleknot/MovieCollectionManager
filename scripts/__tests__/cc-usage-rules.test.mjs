// Feature 105 US4 — efficiency rules over the developer's own baseline (FR-028–FR-031; US4-AC1, AC2,
// AC4; data-model.md `findings`). T056. Pure: canned baseline and recent-session rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRules, findingId, nextStatus, RULES } from '../lib/cc-usage/efficiency-rules.mjs';

const NOW = Date.parse('2026-12-10T12:00:00Z'); // a Thursday; its week starts 2026-12-07
const FR028 = ['weighted_tokens', 'tokens_per_merged_pr', 'rework_share', 'floor_tokens', 'cache_read_ratio', 'idle_tax', 'context_growth',
  'compactions', 'tool_output_bytes', 'rtk_share', 'reread_rate', 'subagent_share', 'premium_share', 'limit_burn'];

const base = (metric, over = {}) => ({ activity: 'implement', metric, median: 100, p90: 200, n: 20, ...over });
const recent = (metric, values, over = {}) => values.map((v, i) => ({ session_id: `00000000-0000-4000-8000-00000000000${i}`, activity: 'implement', started_at: '2026-12-09T10:00:00Z', [metric]: v, ...over }));

test('every FR-028 metric has a rule, each with a watch metric, a counter-metric and a minimum sample', () => {
  assert.deepEqual(RULES.map((r) => r.metric).sort(), [...FR028].sort());
  for (const r of RULES) {
    assert.equal(r.watch_metric, r.metric);
    assert.ok(['rework_share', 'ci_first_pass_rate'].includes(r.counter_metric), r.id);
    assert.ok(r.min_n >= 5, r.id);
    assert.match(r.suggestion, /\?|might|may|could|if|try/i, `${r.id}: worded as a hypothesis (FR-030)`);
  }
});

test('under 14 days of data: not enough data, whatever the samples', () => {
  const r = evaluateRules({ baseline: [base('floor_tokens')], recent: recent('floor_tokens', [900, 900, 900]), dataDays: 10, now: NOW });
  assert.deepEqual(r.findings, []);
  assert.ok(r.notEnough.some((x) => x.reason === 'baseline under 14 days'));
});

test('below a rule\'s minimum sample size: not enough data for that activity', () => {
  const r = evaluateRules({ baseline: [base('floor_tokens', { n: 3 })], recent: recent('floor_tokens', [900, 900, 900]), dataDays: 30, now: NOW });
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.notEnough.find((x) => x.metric === 'floor_tokens'), { rule: 'session-floor', metric: 'floor_tokens', activity: 'implement', n: 3, reason: 'n 3 < 10' });
});

test('recent median above p90 with enough samples: a finding with numbers-only evidence', () => {
  const r = evaluateRules({ baseline: [base('floor_tokens')], recent: recent('floor_tokens', [300, 250, 280]), dataDays: 30, now: NOW });
  assert.equal(r.findings.length, 1);
  const f = r.findings[0];
  assert.equal(f.finding_id, 'session-floor:activity:implement:2026-12-07');
  assert.deepEqual([f.rule, f.scope, f.sample_size, f.watch_metric, f.counter_metric, f.status], ['session-floor', 'activity:implement', 20, 'floor_tokens', 'rework_share', 'open']);
  assert.deepEqual(f.evidence, { metric: 'floor_tokens', recent_median: 280, recent_n: 3, baseline_median: 100, baseline_p90: 200, sample_size: 20, sessions: recent('floor_tokens', [1, 1, 1]).map((s) => s.session_id) });
  const nums = (v) => (Array.isArray(v) ? v.every((x) => typeof x === 'string' && /^[0-9a-f-]{36}$/.test(x)) : typeof v === 'number' || typeof v === 'string');
  assert.ok(Object.values(f.evidence).every(nums), 'numbers (and session ids) only');
  assert.ok(f.suggestion.length > 20);
});

test('at or under p90: no finding', () => {
  const r = evaluateRules({ baseline: [base('floor_tokens')], recent: recent('floor_tokens', [150, 200, 190]), dataDays: 30, now: NOW });
  assert.deepEqual(r.findings, []);
});

test('a metric where LOWER is worse (cache read ratio) fires below p10, not above p90', () => {
  const low = evaluateRules({ baseline: [base('cache_read_ratio', { median: 0.8, p90: 0.95, p10: 0.6 })], recent: recent('cache_read_ratio', [0.3, 0.4, 0.2]), dataDays: 30, now: NOW });
  assert.equal(low.findings.length, 1);
  const high = evaluateRules({ baseline: [base('cache_read_ratio', { median: 0.8, p90: 0.95, p10: 0.6 })], recent: recent('cache_read_ratio', [0.99, 0.98, 0.97]), dataDays: 30, now: NOW });
  assert.equal(high.findings.length, 0);
});

test('finding_id is deterministic: same rule, scope and week → same id', () => {
  assert.equal(findingId('idle-tax', 'activity:docs', NOW), findingId('idle-tax', 'activity:docs', NOW + 86_400_000));
  assert.notEqual(findingId('idle-tax', 'activity:docs', NOW), findingId('idle-tax', 'activity:docs', NOW + 7 * 86_400_000));
});

test('an accepted finding: counter-metric worse → regressed; watch improved, counter not worse, window elapsed → confirmed', () => {
  const acc = { status: 'accepted', accepted_at: '2026-11-20T00:00:00Z', baseline_value: 280, counter_baseline: 0.1, watch_metric: 'floor_tokens' };
  assert.equal(nextStatus(acc, { after: 150, counterAfter: 0.25, now: NOW }), 'regressed', 'tokens down but rework up is a regression (FR-031)');
  assert.equal(nextStatus(acc, { after: 150, counterAfter: 0.1, now: NOW }), 'confirmed');
  assert.equal(nextStatus(acc, { after: 300, counterAfter: 0.1, now: NOW }), 'accepted', 'not improved yet');
  assert.equal(nextStatus({ ...acc, accepted_at: '2026-12-09T00:00:00Z' }, { after: 150, counterAfter: 0.1, now: NOW }), 'accepted', 'window not elapsed');
  assert.equal(nextStatus({ ...acc, status: 'open' }, { after: 1, counterAfter: 0, now: NOW }), 'open', 'only accepted findings move');
});
