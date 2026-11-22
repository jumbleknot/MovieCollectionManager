// Feature 105 US3 — feature outcomes (data-model.md `features`; research R15; FR-025, FR-034;
// US3-AC5, AC6). T045. git, the forge and the file system are injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectOutcomes, countTasks, resolveSpec } from '../lib/cc-usage/collect-feature-outcomes.mjs';

const NOW = Date.parse('2026-11-21T12:00:00Z');
const SPECS = ['specs/104-agent-billing-envelope', 'specs/105-cc-token-usage-capture', 'specs/feat-x'];

test('spec link: .specify/feature.json first, then a matching specs/* directory, then an NNN- prefix', () => {
  assert.equal(resolveSpec({ branch: 'fix/agent-billing-envelope', featureJson: { feature_directory: 'specs/104-agent-billing-envelope' }, specDirs: SPECS }), 'specs/104-agent-billing-envelope');
  assert.equal(resolveSpec({ branch: 'feat-x', featureJson: null, specDirs: SPECS }), 'specs/feat-x');
  assert.equal(resolveSpec({ branch: '105-us2-us4', featureJson: null, specDirs: SPECS }), 'specs/105-cc-token-usage-capture');
  assert.equal(resolveSpec({ branch: 'renovate/uv-pin', featureJson: null, specDirs: SPECS }), null);
  // an absolute feature_directory is reduced to its specs/ path
  assert.equal(resolveSpec({ branch: 'x', featureJson: { feature_directory: '/home/coder/worktrees/x/specs/105-cc-token-usage-capture' }, specDirs: SPECS }), 'specs/105-cc-token-usage-capture');
});

test('countTasks counts the task checkboxes of tasks.md', () => {
  const md = '## P\n- [x] T001 a\n- [ ] T002 b\n- [X] T003 c\n- [ ] **SC-001** not a task\n  - [ ] T004 nested still counts\n';
  assert.deepEqual(countTasks(md), { total: 4, done: 2 });
});

const fakes = ({ files = {}, prs = [], runs = [], stats = { commits: 3, added: 40, removed: 5 }, branchExists = true } = {}) => ({
  now: NOW,
  worktree: '/w/feat',
  specDirs: SPECS,
  readFile: (p) => (p in files ? files[p] : null),
  git: { stats: (range) => ({ ...stats, range }), branchExists: () => branchExists },
  forge: { prsForBranch: async () => prs, runs: async () => runs },
});

const base = (over = {}) => ({ feature_id: 'feat-x@2026-11-14', branch: 'feat-x', first_seen_at: '2026-11-14T09:00:00Z', pr_state: 'none', pr_number: null, merged_at: null, collected_at: null, ...over });

test('a no-spec feature has tasks_total and tasks_done NULL, never 0', async () => {
  const f = await collectOutcomes(base({ branch: 'renovate/uv-pin', feature_id: 'renovate/uv-pin@2026-11-14' }), fakes());
  assert.equal(f.kind, 'no-spec');
  assert.equal(f.spec_dir, null);
  assert.equal(f.tasks_total, null);
  assert.equal(f.tasks_done, null);
});

test('a spec feature counts tasks.md checkboxes, from the worktree', async () => {
  const f = await collectOutcomes(base(), fakes({ files: { '/w/feat/specs/feat-x/tasks.md': '- [x] T001 a\n- [ ] T002 b\n' } }));
  assert.deepEqual([f.kind, f.spec_dir, f.spec_number, f.tasks_total, f.tasks_done], ['spec', 'specs/feat-x', null, 2, 1]);
  const g = await collectOutcomes(base({ branch: '105-x', feature_id: '105-x@2026-11-14' }), fakes({ files: { '/w/feat/specs/105-cc-token-usage-capture/tasks.md': '- [x] T001 a\n' } }));
  assert.equal(g.spec_number, 105);
});

test('commits and lines come from origin/main..branch while open', async () => {
  const f = await collectOutcomes(base(), fakes());
  assert.deepEqual([f.commits, f.lines_added, f.lines_removed], [3, 40, 5]);
});

test('PR state, CI red/green, first_red_at and backlog closures map from the forge', async () => {
  const prs = [{ number: 12, state: 'closed', merged: true, merged_at: '2026-11-19T10:00:00Z', created_at: '2026-11-15T00:00:00Z', head_sha: 'abc', body: 'Closes #40, fixes #41 and refs #42' }];
  const runs = [
    { conclusion: 'failure', created_at: '2026-11-16T10:00:00Z' },
    { conclusion: 'success', created_at: '2026-11-17T10:00:00Z' },
    { conclusion: 'failure', created_at: '2026-11-15T10:00:00Z' },
    { conclusion: 'success', created_at: '2026-11-18T10:00:00Z' },
  ];
  const f = await collectOutcomes(base(), fakes({ prs, runs }));
  assert.deepEqual([f.pr_number, f.pr_state, f.merged_at], [12, 'merged', '2026-11-19T10:00:00Z']);
  assert.deepEqual([f.ci_runs_red, f.ci_runs_green, f.first_red_at], [2, 2, '2026-11-15T10:00:00Z']);
  assert.equal(f.backlog_closed, 2);
});

test('a PR from before the feature started belongs to an earlier feature of the same name', async () => {
  const prs = [{ number: 3, state: 'closed', merged: true, merged_at: '2026-11-02T00:00:00Z', created_at: '2026-11-01T00:00:00Z', head_sha: 'x', body: '' }];
  const f = await collectOutcomes(base(), fakes({ prs }));
  assert.deepEqual([f.pr_number, f.pr_state], [null, 'none']);
});

test('a deleted branch with no PR is abandoned', async () => {
  const f = await collectOutcomes(base(), fakes({ branchExists: false }));
  assert.equal(f.pr_state, 'abandoned');
});

test('collection is skipped when done less than 15 minutes ago', async () => {
  assert.equal(await collectOutcomes(base({ collected_at: new Date(NOW - 10 * 60_000).toISOString() }), fakes()), null);
  assert.ok(await collectOutcomes(base({ collected_at: new Date(NOW - 16 * 60_000).toISOString() }), fakes()));
});

test('collected_at is stamped', async () => {
  assert.equal((await collectOutcomes(base(), fakes())).collected_at, new Date(NOW).toISOString());
});
