// Feature 105 US4 — `findings`, `accept`, `reject` (contracts/cli.md; FR-029–FR-032). `findings` runs the
// rules over the store's baseline and last week's sessions, stores NEW findings (never overwriting an
// existing one's status), moves accepted experiments on (confirmed / regressed), and lists the result.
import { evaluateRules, nextStatus } from './efficiency-rules.mjs';
import { shapeRows } from './privacy-shape.mjs';
import { configuredHosts, redactLine, renderTable } from './render-table.mjs';
import { storeClient } from './store-client.mjs';

const WEEK = 7 * 86_400_000;
const median = (xs) => {
  const s = xs.filter((x) => x !== null && x !== undefined && Number.isFinite(Number(x))).map(Number).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const activityOf = (scope) => (String(scope).startsWith('activity:') ? scope.slice('activity:'.length) : null);
const recentMedian = (recent, scope, metric) => {
  const a = activityOf(scope);
  return median(recent.filter((r) => a === null || r.activity === a).map((r) => r[metric]));
};
const fmt = (v) => (v === null || v === undefined ? '—' : String(Math.round(Number(v) * 1000) / 1000));

export async function findings(cfg, { all, json }) {
  const st = storeClient(cfg);
  const now = cfg.now();
  const [baseline, recent, existing] = await Promise.all([
    st.get('/v_baseline'),
    st.get(`/v_session_metrics?started_at=gte.${new Date(now - WEEK).toISOString()}`),
    st.get('/findings?order=created_at.desc&limit=500'),
  ]);
  const dataDays = Number(baseline[0]?.data_days ?? 0);
  const result = evaluateRules({ baseline, recent, dataDays, now });
  const known = new Set(existing.map((f) => f.finding_id));
  const fresh = result.findings.filter((f) => !known.has(f.finding_id));
  if (fresh.length) await st.insertNew('findings', 'finding_id', shapeRows('findings', fresh));

  // Experiments: measure accepted findings again and move their status.
  const rows = [...fresh, ...existing];
  for (const f of rows.filter((x) => x.status === 'accepted')) {
    const after = recentMedian(recent, f.scope, f.watch_metric) ?? f.after_value ?? null;
    const counterAfter = recentMedian(recent, f.scope, f.counter_metric) ?? f.counter_after ?? null;
    const status = nextStatus(f, { after, counterAfter, now });
    if (after !== f.after_value || counterAfter !== f.counter_after || status !== f.status) {
      await st.patch(`/findings?finding_id=eq.${encodeURIComponent(f.finding_id)}`, { after_value: after, counter_after: counterAfter, status });
      Object.assign(f, { after_value: after, counter_after: counterAfter, status });
    }
  }

  const hosts = configuredHosts();
  if (all) {
    const out = rows.map((f) => ({
      finding_id: f.finding_id, rule: f.rule, scope: f.scope, status: f.status, sample_size: f.sample_size,
      watch_metric: f.watch_metric, watch_before: f.baseline_value ?? null, watch_after: f.after_value ?? null,
      counter_metric: f.counter_metric, counter_before: f.counter_baseline ?? null, counter_after: f.counter_after ?? null,
      accepted_at: f.accepted_at ?? null,
    }));
    if (json) return { code: 0, out: renderTable(out, [], { json, hosts }) };
    if (!out.length) return { code: 0, out: 'findings: none yet' };
    return { code: 0, out: out.map((f) => redactLine(`${f.finding_id}  ${f.status}  n=${f.sample_size ?? '—'}\n  ${f.watch_metric} ${fmt(f.watch_before)} → ${fmt(f.watch_after)}   ${f.counter_metric} ${fmt(f.counter_before)} → ${fmt(f.counter_after)}`, { hosts })).join('\n') };
  }

  const open = rows.filter((f) => f.status === 'open');
  if (json) return { code: 0, out: renderTable({ findings: open, not_enough_data: result.notEnough }, [], { json, hosts }) };
  const lines = [];
  for (const f of open) {
    const e = f.evidence ?? {};
    const limit = e.baseline_p90 !== undefined ? `p90 ${fmt(e.baseline_p90)}` : `p10 ${fmt(e.baseline_p10)}`;
    lines.push(`${f.finding_id}`);
    lines.push(`  ${f.rule}  ${f.scope}  n=${f.sample_size}  recent ${fmt(e.recent_median)} vs ${limit} (median ${fmt(e.baseline_median)})  watch ${f.watch_metric} (counter ${f.counter_metric})`);
    lines.push(`  ${f.suggestion}`);
  }
  for (const x of result.notEnough) {
    lines.push(x.rule ? `not enough data: ${x.rule} for ${x.activity} (${x.reason})` : `not enough data: ${x.reason} (${x.data_days} days so far)`);
  }
  if (!lines.length) lines.push('findings: nothing beyond the baseline this week');
  return { code: 0, out: lines.map((l) => redactLine(l, { hosts })).join('\n') };
}

async function getFinding(st, id) {
  return (await st.get(`/findings?finding_id=eq.${encodeURIComponent(id)}`))[0] ?? null;
}

/** Start the experiment (FR-032): the baseline is the finding's evidence, the counter's is last week's. */
export async function accept(cfg, { id }) {
  const st = storeClient(cfg);
  const f = await getFinding(st, id);
  if (!f) return { code: 0, out: `accept: no finding ${id}` };
  const recent = await st.get(`/v_session_metrics?started_at=gte.${new Date(cfg.now() - WEEK).toISOString()}`);
  const body = {
    status: 'accepted',
    accepted_at: new Date(cfg.now()).toISOString(),
    baseline_value: f.evidence?.recent_median ?? null,
    counter_baseline: recentMedian(recent, f.scope, f.counter_metric),
  };
  await st.patch(`/findings?finding_id=eq.${encodeURIComponent(id)}`, body);
  return { code: 0, out: `accepted ${id}: watching ${f.watch_metric} (from ${fmt(body.baseline_value)}) and ${f.counter_metric} (from ${fmt(body.counter_baseline)})` };
}

export async function reject(cfg, { id }) {
  const st = storeClient(cfg);
  const f = await getFinding(st, id);
  if (!f) return { code: 0, out: `reject: no finding ${id}` };
  await st.patch(`/findings?finding_id=eq.${encodeURIComponent(id)}`, { status: 'rejected' });
  return { code: 0, out: `rejected ${id}` };
}
