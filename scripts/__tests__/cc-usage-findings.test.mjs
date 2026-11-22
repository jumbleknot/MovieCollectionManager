// Feature 105 US4 — `findings`, `accept`, `reject` (contracts/cli.md; FR-029, FR-030, FR-032; US4-AC3). T057.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { envFor, runCli, startFakeStore, tempConfigDir } from './cc-usage-test-support.mjs';

const NOW = '2026-12-10T12:00:00Z';
const ids = (n) => Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-00000000001${i}`);
const BASELINE = [
  { activity: 'implement', metric: 'floor_tokens', median: 100, p90: 200, p10: 50, n: 20, data_days: 30 },
  { activity: 'docs', metric: 'floor_tokens', median: 100, p90: 200, p10: 50, n: 2, data_days: 30 },
];
const RECENT = ids(3).map((session_id, i) => ({ session_id, activity: 'implement', started_at: '2026-12-09T10:00:00Z', floor_tokens: 300 + i, rework_share: 0.1 }));
const ACCEPTED = {
  finding_id: 'idle-tax:activity:implement:2026-11-16', rule: 'idle-tax', scope: 'activity:implement', status: 'accepted',
  evidence: { metric: 'idle_tax', recent_median: 0.4 }, sample_size: 12, suggestion: 's', watch_metric: 'idle_tax', counter_metric: 'rework_share',
  accepted_at: '2026-11-16T00:00:00Z', baseline_value: 0.4, after_value: 0.2, counter_baseline: 0.1, counter_after: 0.1,
};

async function withStore(views, fn) {
  const store = await startFakeStore({ views });
  const cfg = tempConfigDir();
  try {
    await fn(store, envFor(cfg.dir, store, { CC_USAGE_NOW: NOW }));
  } finally {
    cfg.cleanup();
    await store.close();
  }
}

test('findings lists open findings with their sample size, and "not enough data" below the minimum', () => withStore(
  { v_baseline: BASELINE, v_session_metrics: RECENT, findings: [] },
  async (store, env) => {
    const r = await runCli(['findings'], { env });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /session-floor/);
    assert.match(r.stdout, /activity:implement/);
    assert.match(r.stdout, /n=20/);
    assert.match(r.stdout, /watch floor_tokens/);
    assert.match(r.stdout, /not enough data/);
    assert.match(r.stdout, /docs/);
    // the new finding is stored, without overwriting an existing one (ignore-duplicates)
    const post = store.requests.find((q) => q.method === 'POST' && q.path === '/findings');
    assert.ok(post, 'the finding was upserted');
    assert.equal(post.rows[0].finding_id, 'session-floor:activity:implement:2026-12-07');
  },
));

test('accept <id> starts the experiment: status, accepted_at and the baseline values', () => withStore(
  { findings: [{ finding_id: 'session-floor:activity:implement:2026-12-07', status: 'open', rule: 'session-floor', scope: 'activity:implement', evidence: { metric: 'floor_tokens', recent_median: 301 }, watch_metric: 'floor_tokens', counter_metric: 'rework_share' }], v_session_metrics: RECENT },
  async (store, env) => {
    const r = await runCli(['accept', 'session-floor:activity:implement:2026-12-07'], { env });
    assert.equal(r.code, 0, r.stderr);
    const p = store.requests.find((q) => q.method === 'PATCH' && q.path === '/findings');
    assert.match(decodeURIComponent(p.query), /finding_id=eq\.session-floor:activity:implement:2026-12-07/);
    assert.deepEqual(p.rows, { status: 'accepted', accepted_at: new Date(NOW).toISOString(), baseline_value: 301, counter_baseline: 0.1 });
    assert.match(r.stdout, /accepted/);
  },
));

test('reject <id>', () => withStore({ findings: [{ finding_id: 'x:activity:docs:2026-12-07', status: 'open' }] }, async (store, env) => {
  const r = await runCli(['reject', 'x:activity:docs:2026-12-07'], { env });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(store.requests.find((q) => q.method === 'PATCH').rows, { status: 'rejected' });
}));

test('accept of an unknown id says so and changes nothing', () => withStore({ findings: [] }, async (store, env) => {
  const r = await runCli(['accept', 'nope:activity:x:2026-12-07'], { env });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /no finding/);
  assert.equal(store.requests.filter((q) => q.method === 'PATCH').length, 0);
}));

test('findings --all shows before/after for the watch metric and its counter-metric', () => withStore(
  { v_baseline: BASELINE, v_session_metrics: RECENT, findings: [ACCEPTED] },
  async (_store, env) => {
    const r = await runCli(['findings', '--all', '--json'], { env });
    const f = JSON.parse(r.stdout).find((x) => x.finding_id === ACCEPTED.finding_id);
    assert.deepEqual([f.watch_before, f.watch_after, f.counter_before, f.counter_after], [0.4, 0.2, 0.1, 0.1]);
    const t = await runCli(['findings', '--all'], { env });
    assert.match(t.stdout, /idle_tax 0\.4 → 0\.2/);
    assert.match(t.stdout, /rework_share 0\.1 → 0\.1/);
  },
));

test('with the store unreachable: the one-line answer, exit 0', async () => {
  const cfg = tempConfigDir();
  try {
    const r = await runCli(['findings'], { env: envFor(cfg.dir, { ingestUrl: 'http://127.0.0.1:9', tokenUrl: 'http://127.0.0.1:9/token' }) });
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), 'usage history: store unreachable (spooled 0)');
  } finally {
    cfg.cleanup();
  }
});
