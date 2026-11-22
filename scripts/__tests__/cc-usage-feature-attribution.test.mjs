// Feature 105 US3 — feature attribution per TURN (data-model.md "Feature attribution"; FR-036, FR-037;
// research R16, R17; US3-AC3, AC4, AC7; SC-011). T043. Paths are used in the container to find the
// worktree, then dropped; only the feature id and the rule name ship.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { attributeTurns, bashPaths, worktreeRoot } from '../lib/cc-usage/attribute-feature.mjs';
import { initialState, parseTranscript } from '../lib/cc-usage/parse-transcript.mjs';
import { FIXTURES, PROJECT, SESSION } from './cc-usage-test-support.mjs';

const WT = JSON.parse(readFileSync(join(FIXTURES, 'worktrees.json'), 'utf8')).worktrees;
const resolveBranch = (root) => WT[root]?.branch ?? null;
const parseC = () => parseTranscript(readFileSync(join(FIXTURES, 'projects', PROJECT.C, `${SESSION.C}.jsonl`)), initialState(), { sessionId: SESSION.C, projectDir: PROJECT.C });

test('the main-checkout session C is split between feat-a and docs-b, nothing dropped', () => {
  const r = parseC();
  const turns = r.records.turns.map((t) => ({ turn_seq: t.turn_seq, ...r.signals[t.turn_seq] }));
  const got = attributeTurns(turns, { resolveBranch }).map((a) => [a.turn_seq, a.branch, a.attribution_rule]);
  assert.deepEqual(got, [
    [1, 'feat-a', 'worktree'],            // Edit in feat-a
    [2, 'docs-b', 'worktree'],            // git -C docs-b, Edit in docs-b
    [3, 'docs-b', 'inherited'],           // node scripts/forge-pr.mjs open: path-less → the current feature
    [4, 'docs-b', 'inherited'],           // no tool call at all
    [5, 'feat-a', 'worktree-majority'],   // two reads in feat-a, one in docs-b
  ]);
});

test('per-feature tokens plus no-feature equal the session total (conservation, unit level)', () => {
  const r = parseC();
  const turns = r.records.turns.map((t) => ({ turn_seq: t.turn_seq, ...r.signals[t.turn_seq] }));
  const by = new Map(attributeTurns(turns, { resolveBranch }).map((a) => [a.turn_seq, a.branch]));
  const tok = (c) => c.input_tokens + c.output_tokens + c.cache_read_tokens + c.cache_write_5m_tokens + c.cache_write_1h_tokens;
  const sums = new Map();
  for (const c of r.records.modelCalls) sums.set(by.get(c.turn_seq) ?? null, (sums.get(by.get(c.turn_seq) ?? null) ?? 0) + tok(c));
  const total = r.records.modelCalls.reduce((n, c) => n + tok(c), 0);
  assert.ok(sums.get('feat-a') > 0 && sums.get('docs-b') > 0);
  assert.equal([...sums.values()].reduce((a, b) => a + b, 0), total);
});

test('a first turn with no path uses the transcript branch; a main decision means no feature', () => {
  assert.deepEqual(attributeTurns([{ turn_seq: 1, roots: {}, startBranch: 'fix/x' }], { resolveBranch }),
    [{ turn_seq: 1, branch: 'fix/x', attribution_rule: 'session-branch' }]);
  assert.deepEqual(attributeTurns([{ turn_seq: 1, roots: {}, startBranch: 'main' }], { resolveBranch }),
    [{ turn_seq: 1, branch: null, attribution_rule: 'main' }]);
  assert.deepEqual(attributeTurns([{ turn_seq: 1, roots: { '/workspaces/mcm': { calls: 2, last: 1 } }, startBranch: 'main' }], { resolveBranch }),
    [{ turn_seq: 1, branch: null, attribution_rule: 'main' }]);
});

test('a later path-less turn inherits from the previous ship (prevBranch), never the transcript branch', () => {
  assert.deepEqual(attributeTurns([{ turn_seq: 7, roots: {}, startBranch: 'main' }], { resolveBranch, prevBranch: 'feat-a', hasEarlierTurn: true }),
    [{ turn_seq: 7, branch: 'feat-a', attribution_rule: 'inherited' }]);
});

test('a two-worktree tie goes to the one touched last', () => {
  const roots = { '/home/coder/worktrees/feat-a': { calls: 1, last: 4 }, '/home/coder/worktrees/docs-b': { calls: 1, last: 9 } };
  assert.deepEqual(attributeTurns([{ turn_seq: 1, roots, startBranch: 'main' }], { resolveBranch }),
    [{ turn_seq: 1, branch: 'docs-b', attribution_rule: 'worktree-majority' }]);
});

test('a worktree whose branch cannot be resolved falls back to inheritance', () => {
  const roots = { '/home/coder/worktrees/gone': { calls: 3, last: 1 } };
  assert.deepEqual(attributeTurns([{ turn_seq: 2, roots, startBranch: 'main' }], { resolveBranch, prevBranch: 'docs-b', hasEarlierTurn: true }),
    [{ turn_seq: 2, branch: 'docs-b', attribution_rule: 'inherited' }]);
});

test('worktreeRoot and bashPaths find the worktree a path or command names', () => {
  assert.equal(worktreeRoot('/home/coder/worktrees/feat-a/frontend/x.ts', '/workspaces/mcm'), '/home/coder/worktrees/feat-a');
  assert.equal(worktreeRoot('/workspaces/mcm/docs/a.md', '/workspaces/mcm'), '/workspaces/mcm');
  assert.equal(worktreeRoot('docs/a.md', '/home/coder/worktrees/feat-a'), '/home/coder/worktrees/feat-a');
  assert.equal(worktreeRoot('/etc/hosts', '/workspaces/mcm'), null);
  assert.deepEqual(bashPaths('git -C /home/coder/worktrees/docs-b status'), ['/home/coder/worktrees/docs-b']);
  assert.deepEqual(bashPaths('cd /home/coder/worktrees/feat-a && pnpm nx test x'), ['/home/coder/worktrees/feat-a']);
  assert.deepEqual(bashPaths('node scripts/forge-pr.mjs open'), []);
});

test('wired into capture: shipped turns carry feature_id, attribution_rule and activity; features ship first', async () => {
  const { envFor, hookEvent, runCli, startFakeStore, tempConfigDir } = await import('./cc-usage-test-support.mjs');
  const store = await startFakeStore();
  const cfg = tempConfigDir();
  try {
    const env = envFor(cfg.dir, store, { CC_USAGE_TEST_WORKTREES: join(FIXTURES, 'worktrees.json') });
    const r = await runCli(['hook'], { env, stdin: hookEvent('SessionEnd', 'C', cfg.dir) });
    assert.equal(r.code, 0);
    const turns = store.rows('turns').filter((t) => t.session_id === SESSION.C).sort((a, b) => a.turn_seq - b.turn_seq);
    assert.deepEqual(turns.map((t) => [t.turn_seq, t.feature_id, t.attribution_rule]), [
      [1, 'feat-a@2026-11-14', 'worktree'], [2, 'docs-b@2026-11-14', 'worktree'], [3, 'docs-b@2026-11-14', 'inherited'],
      [4, 'docs-b@2026-11-14', 'inherited'], [5, 'feat-a@2026-11-14', 'worktree-majority'],
    ]);
    assert.ok(turns.every((t) => typeof t.activity === 'string' && typeof t.activity_rule === 'string'));
    assert.equal(turns[0].activity, 'implement', 'an Edit under frontend/');
    const paths = store.requests.filter((q) => q.method === 'POST').map((q) => q.path);
    assert.ok(paths.indexOf('/features') !== -1 && paths.indexOf('/features') < paths.indexOf('/turns'), paths.join(' '));
    assert.deepEqual(store.rows('features').map((f) => f.feature_id).sort(), ['docs-b@2026-11-14', 'feat-a@2026-11-14']);
    const batch = store.requests.find((q) => q.method === 'POST' && q.path === '/features').rows;
    for (const f of batch) assert.deepEqual(Object.keys(f).sort(), ['branch', 'feature_id', 'first_seen_at'], 'the batch carries minimal rows only');
    // SessionEnd then collected outcomes, in their own upsert: no forge credential here, so no PR facts.
    assert.ok(store.rows('features').every((f) => f.kind === 'no-spec' || f.kind === 'spec'));
  } finally {
    cfg.cleanup();
    await store.close();
  }
});

test('T078: a first turn in a detached-HEAD checkout is no feature, never a "HEAD" feature', () => {
  assert.deepEqual(attributeTurns([{ turn_seq: 1, roots: {}, startBranch: 'HEAD' }], { resolveBranch }),
    [{ turn_seq: 1, branch: null, attribution_rule: 'main' }]);
});
