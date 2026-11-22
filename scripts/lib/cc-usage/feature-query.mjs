// Feature 105 US3 — `feature`, `features` and `weights push` (contracts/cli.md; FR-038). Reads
// v_feature_totals / v_no_feature_totals; a feature without a task list shows `tasks: n/a` (FR-025).
import { pushWeights, weightsRow } from './feature-context.mjs';
import { configuredHosts, redactLine, renderTable } from './render-table.mjs';
import { TOKEN_TYPES } from './session-summary.mjs';
import { storeClient } from './store-client.mjs';
import { sinceIso } from './query.mjs';

const OPEN = new Set(['none', 'open']);
const rowTotal = (r) => TOKEN_TYPES.reduce((n, t) => n + Number(r[`${t}_tokens`] ?? 0), 0);
const n = (v) => Number(v ?? 0).toLocaleString('en-US');
const pct = (x) => `${Math.round(Number(x) * 100)}%`;

/** `<branch>`, `spec:NNN` or a feature id → the v_feature_totals filter. */
function selector(ref) {
  if (/^spec:\d+$/.test(ref)) return `spec_number=eq.${Number(ref.slice(5))}`;
  if (ref.includes('@')) return `feature_id=eq.${encodeURIComponent(ref)}`;
  return `branch=eq.${encodeURIComponent(ref)}`;
}

function describe(f) {
  const mix = Object.entries(f.activity_mix ?? {}).sort((a, b) => b[1] - a[1]).map(([a, s]) => `${a} ${pct(s)}`).join(', ') || '—';
  const tasks = f.tasks_total === null || f.tasks_total === undefined ? 'tasks: n/a' : `tasks: ${f.tasks_done ?? 0}/${f.tasks_total}`;
  return [
    `feature ${f.feature_id}  branch ${f.branch}  kind ${f.kind}  spec ${f.spec_dir ?? '—'}  PR ${f.pr_state}${f.pr_number ? ` #${f.pr_number}` : ''}`,
    `sessions ${n(f.sessions)}  turns ${n(f.turns)}  tokens ${n(rowTotal(f))}  weighted ${n(Math.round(Number(f.weighted_tokens ?? 0)))}  main ${n(f.main_tokens)} / subagent ${n(f.subagent_tokens)}`,
    renderTable([Object.fromEntries(TOKEN_TYPES.map((t) => [t, Number(f[`${t}_tokens`] ?? 0)]))], TOKEN_TYPES.map((t) => ({ key: t, label: t.replace(/_/g, ' '), align: 'right' }))),
    `activity mix: ${mix}`,
    `outcomes: commits ${n(f.commits)}  lines +${n(f.lines_added)}/-${n(f.lines_removed)}  ${tasks}  CI red ${n(f.ci_runs_red)} / green ${n(f.ci_runs_green)}  backlog closed ${n(f.backlog_closed)}`,
  ].join('\n');
}

export async function feature(cfg, { ref, all, json }) {
  let rows = await storeClient(cfg).get(`/v_feature_totals?${selector(ref)}&order=first_seen_at.desc`);
  // A reused branch name has several features: show the open one unless --all (FR-035).
  if (!all && !ref.includes('@') && !ref.startsWith('spec:')) {
    const open = rows.filter((r) => OPEN.has(r.pr_state));
    rows = open.length ? open : rows.slice(0, 1);
  }
  const hosts = configuredHosts();
  if (json) return { code: 0, out: renderTable(rows, [], { json, hosts }) };
  if (!rows.length) return { code: 0, out: `feature ${ref}: none in the store` };
  if (all && rows.length > 1) {
    return { code: 0, out: renderTable(rows.map((r) => ({ ...r, tokens: rowTotal(r) })), [
      { key: 'feature_id', label: 'feature' }, { key: 'pr_state', label: 'PR' }, { key: 'sessions', align: 'right' }, { key: 'turns', align: 'right' }, { key: 'tokens', align: 'right' },
    ], { hosts }) };
  }
  return { code: 0, out: rows.map((r) => redactLine(describe(r), { hosts })).join('\n\n') };
}

export async function features(cfg, { since, kind, state = 'open', json }) {
  const st = storeClient(cfg);
  const params = [
    since && `first_seen_at=gte.${sinceIso(since, cfg.now())}`,
    kind && `kind=eq.${encodeURIComponent(kind)}`,
    state === 'open' ? 'pr_state=in.(none,open)' : state === 'merged' ? 'pr_state=eq.merged' : null,
    'order=weighted_tokens.desc',
  ].filter(Boolean);
  const rows = (await st.get(`/v_feature_totals?${params.join('&')}`)).map((r) => ({
    feature: r.feature_id, kind: r.kind, pr: r.pr_state, sessions: Number(r.sessions ?? 0), turns: Number(r.turns ?? 0),
    tokens: rowTotal(r), weighted: Math.round(Number(r.weighted_tokens ?? 0)),
    tasks: r.tasks_total === null || r.tasks_total === undefined ? 'n/a' : `${r.tasks_done ?? 0}/${r.tasks_total}`,
  }));
  const none = (await st.get('/v_no_feature_totals'))[0] ?? {};
  const noRow = { feature: 'no feature', kind: null, pr: null, sessions: Number(none.sessions ?? 0), turns: Number(none.turns ?? 0), tokens: rowTotal(none), weighted: Math.round(Number(none.weighted_tokens ?? 0)), tasks: null };
  const cols = [{ key: 'feature' }, { key: 'kind' }, { key: 'pr', label: 'PR' }, { key: 'sessions', align: 'right' }, { key: 'turns', align: 'right' }, { key: 'tokens', align: 'right' }, { key: 'weighted', align: 'right' }, { key: 'tasks' }];
  const hosts = configuredHosts();
  if (json) return { code: 0, out: renderTable([...rows, noRow], cols, { json, hosts }) };
  // "no feature" stays the LAST line even when the list is cut at 10.
  const shown = rows.slice(0, 9);
  const more = rows.length - shown.length;
  const table = renderTable([...shown, noRow], cols, { hosts, limit: 10 }).split('\n');
  if (more > 0) table.splice(table.length - 1, 0, `… ${more} more`);
  return { code: 0, out: table.join('\n') };
}

export async function weights(cfg, { action }) {
  if (action !== 'push') return { code: 2, err: 'weights: the only action is `push`' };
  await pushWeights(cfg, { force: true });
  const row = weightsRow();
  return { code: 0, out: `weights ${row.as_of} pushed (output ${row.output}, cache read ${row.cache_read}, cache write 5m ${row.cache_write_5m} / 1h ${row.cache_write_1h})` };
}
