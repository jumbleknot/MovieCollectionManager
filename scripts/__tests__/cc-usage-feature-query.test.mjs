// Feature 105 US3 — the feature commands (contracts/cli.md; FR-038; US3-AC3, AC5, AC6, AC7). T046.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { envFor, runCli, startFakeStore, tempConfigDir, SESSION } from './cc-usage-test-support.mjs';

const tok = (n) => ({ input_tokens: n, output_tokens: n, cache_read_tokens: n, cache_write_5m_tokens: 0, cache_write_1h_tokens: 0, weighted_tokens: 10 * n });
const FEATURES = [
  { feature_id: 'feat-a@2026-11-14', branch: 'feat-a', kind: 'no-spec', spec_dir: null, spec_number: null, pr_state: 'merged', pr_number: 7, first_seen_at: '2026-11-14T10:00:00Z', sessions: 2, session_ids: [SESSION.A, SESSION.C], turns: 4, main_tokens: 50, subagent_tokens: 10, ...tok(20), activity_mix: { implement: 0.75, explore: 0.25 }, commits: 3, lines_added: 40, lines_removed: 2, tasks_total: null, tasks_done: null, ci_runs_red: 1, ci_runs_green: 2, backlog_closed: 0 },
  { feature_id: 'feat-a@2026-11-20', branch: 'feat-a', kind: 'no-spec', spec_dir: null, spec_number: null, pr_state: 'none', pr_number: null, first_seen_at: '2026-11-20T10:00:00Z', sessions: 1, session_ids: [SESSION.B], turns: 1, main_tokens: 3, subagent_tokens: 0, ...tok(1), activity_mix: { git: 1 }, commits: 1, lines_added: 1, lines_removed: 0, tasks_total: null, tasks_done: null, ci_runs_red: 0, ci_runs_green: 0, backlog_closed: 0 },
  { feature_id: '105-cc@2026-11-21', branch: '105-cc', kind: 'spec', spec_dir: 'specs/105-cc-token-usage-capture', spec_number: 105, pr_state: 'open', pr_number: 9, first_seen_at: '2026-11-21T10:00:00Z', sessions: 1, session_ids: [SESSION.C], turns: 2, main_tokens: 30, subagent_tokens: 0, ...tok(10), activity_mix: { docs: 1 }, commits: 5, lines_added: 500, lines_removed: 9, tasks_total: 76, tasks_done: 40, ci_runs_red: 0, ci_runs_green: 1, backlog_closed: 1 },
];
const NO_FEATURE = [{ sessions: 3, turns: 6, main_tokens: 12, subagent_tokens: 0, ...tok(4) }];
const VIEWS = {
  v_feature_totals: FEATURES,
  v_no_feature_totals: NO_FEATURE,
  v_session_feature_totals: [
    { session_id: SESSION.A, feature_id: 'feat-a@2026-11-14', spec_number: null, turns: 2, ...tok(15) },
    { session_id: SESSION.C, feature_id: 'feat-a@2026-11-14', spec_number: null, turns: 2, ...tok(5) },
  ],
  v_session_totals: [
    { session_id: SESSION.A, started_at: '2026-11-14T09:00:00Z', starting_branch: 'main', turns: 3, ...tok(30), subagent_tokens: 0 },
    { session_id: SESSION.C, started_at: '2026-11-14T10:00:00Z', starting_branch: 'main', turns: 5, ...tok(50), subagent_tokens: 0 },
  ],
  v_session_activity_mix: [
    { session_id: SESSION.A, activity: 'implement', weighted_tokens: 100, share: 0.8, dominant: true },
    { session_id: SESSION.C, activity: 'implement', weighted_tokens: 90, share: 0.6, dominant: true },
  ],
  v_weekly_trend: [
    { week: '2026-11-09', activity: 'implement', area: 'frontend', feature_id: 'feat-a@2026-11-14', spec_number: null, turns: 3, ...tok(10) },
    { week: '2026-11-09', activity: 'docs', area: 'docs', feature_id: '105-cc@2026-11-21', spec_number: 105, turns: 2, ...tok(5) },
    { week: '2026-11-16', activity: 'implement', area: 'frontend', feature_id: null, spec_number: null, turns: 1, ...tok(2) },
  ],
};

async function run(args, check, extra = {}) {
  const store = await startFakeStore({ views: VIEWS });
  const cfg = tempConfigDir();
  try {
    const r = await runCli(args, { env: envFor(cfg.dir, store, extra) });
    assert.equal(r.code, 0, r.stderr);
    await check(r, store);
  } finally {
    cfg.cleanup();
    await store.close();
  }
}

test('feature <branch> shows the OPEN feature of a reused name, with kind, PR, sessions, tokens, mix and outcomes', () => run(['feature', 'feat-a'], (r, store) => {
  const q = store.requests.find((x) => x.path === '/v_feature_totals').query;
  assert.match(q, /branch=eq\.feat-a/);
  assert.match(r.stdout, /feat-a@2026-11-20/);
  assert.doesNotMatch(r.stdout, /feat-a@2026-11-14/);
  assert.match(r.stdout, /kind no-spec/);
  assert.match(r.stdout, /PR none/);
  assert.match(r.stdout, /tasks: n\/a/);
  assert.match(r.stdout, /sessions 1/);
  assert.match(r.stdout, /weighted/);
  assert.match(r.stdout, /git 100%/);
}));

test('feature <branch> --all lists every feature of the name', () => run(['feature', 'feat-a', '--all'], (r) => {
  assert.match(r.stdout, /feat-a@2026-11-14/);
  assert.match(r.stdout, /feat-a@2026-11-20/);
}));

test('feature spec:105 and a feature id resolve too; a spec feature shows tasks done/total', () => run(['feature', 'spec:105'], (r, store) => {
  assert.match(store.requests.find((x) => x.path === '/v_feature_totals').query, /spec_number=eq\.105/);
  assert.match(r.stdout, /tasks: 40\/76/);
  assert.match(r.stdout, /kind spec/);
}));

test('features --kind no-spec filters, and the list ends with a "no feature" row', () => run(['features', '--kind', 'no-spec', '--state', 'all'], (r, store) => {
  assert.match(store.requests.find((x) => x.path === '/v_feature_totals').query, /kind=eq\.no-spec/);
  const lines = r.stdout.trim().split('\n');
  assert.match(lines.at(-1), /^no feature\s/);
}));

test('features defaults to open features (pr_state none or open)', () => run(['features'], (_r, store) => {
  assert.match(decodeURIComponent(store.requests.find((x) => x.path === '/v_feature_totals').query), /pr_state=in\.\(none,open\)/);
}));

test('sessions --feature shows the tokens attributed to that feature beside the session total', () => run(['sessions', '--feature', 'feat-a@2026-11-14', '--json'], (r) => {
  const rows = JSON.parse(r.stdout);
  const a = rows.find((x) => x.session_id === SESSION.A);
  assert.deepEqual([a.attributed, a.tokens], [45, 90]);
}));

test('sessions --activity and --spec narrow through the attribution views', () => run(['sessions', '--activity', 'implement'], (_r, store) => {
  assert.match(store.requests.find((x) => x.path === '/v_session_activity_mix').query, /activity=eq\.implement/);
  assert.match(decodeURIComponent(store.requests.find((x) => x.path === '/v_session_totals').query), /session_id=in\.\(/);
}));

test('sessions --spec 105', () => run(['sessions', '--spec', '105'], (_r, store) => {
  assert.match(store.requests.find((x) => x.path === '/v_session_feature_totals').query, /spec_number=eq\.105/);
}));

test('trend --by activity, --by spec and --by feature', async () => {
  await run(['trend', '--by', 'activity', '--json'], (r) => {
    assert.deepEqual(JSON.parse(r.stdout).map((x) => [x.activity, x.turns]), [['implement', 4], ['docs', 2]]);
  });
  await run(['trend', '--by', 'spec', '--json'], (r) => {
    assert.deepEqual(JSON.parse(r.stdout).map((x) => [x.spec, x.turns]), [['(no spec)', 4], ['105', 2]]);
  });
  await run(['trend', '--by', 'feature', '--json'], (r) => {
    assert.deepEqual(JSON.parse(r.stdout).map((x) => x.feature), ['feat-a@2026-11-14', '105-cc@2026-11-21', 'feat-a@2026-11-20', 'no feature']);
  });
});

test('compare branch:feat-a spec:105', () => run(['compare', 'branch:feat-a', 'spec:105', '--json'], (r) => {
  const total = JSON.parse(r.stdout).find((x) => x.metric === 'total tokens');
  assert.deepEqual([total.a, total.b], [3, 30]);
}));

test('now narrows its comparison to sessions of the same dominant activity once labels exist', () => run(['now', '--session', SESSION.A, '--json'], (r, store) => {
  const j = JSON.parse(r.stdout);
  const mix = store.requests.find((x) => x.path === '/v_session_activity_mix');
  assert.ok(mix, 'now asked for sessions of its dominant activity');
  assert.match(mix.query, /dominant=is\.true/);
  assert.ok(j.dominant_activity, 'this session has a dominant activity');
  assert.match(mix.query, new RegExp(`activity=eq\\.${j.dominant_activity}`));
}));
