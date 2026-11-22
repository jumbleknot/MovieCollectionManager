// Feature 105 US3 — feature identity (data-model.md `features`, identity rule and pr_state machine;
// FR-035; research R17). T044.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPr, reconcile, resolveFeature, transition } from '../lib/cc-usage/resolve-feature-identity.mjs';

const feature = (id, over = {}) => ({ feature_id: id, branch: id.split('@')[0], first_seen_at: `${id.split('@')[1]}T09:00:00Z`, pr_state: 'none', pr_number: null, merged_at: null, ...over });

test('a first turn on a new branch creates <branch>@<date>', () => {
  assert.deepEqual(resolveFeature('feat-a', '2026-11-14T10:00:00.000Z', []), { feature_id: 'feat-a@2026-11-14', created: true });
});

test('later turns join the open feature, whatever their date', () => {
  const open = [feature('feat-a@2026-11-14')];
  assert.deepEqual(resolveFeature('feat-a', '2026-11-20T10:00:00Z', open), { feature_id: 'feat-a@2026-11-14', created: false });
  assert.deepEqual(resolveFeature('feat-a', '2026-11-20T10:00:00Z', [feature('feat-a@2026-11-14', { pr_state: 'open', pr_number: 7 })]),
    { feature_id: 'feat-a@2026-11-14', created: false });
});

test('a PR found is recorded without changing the id; merge closes the feature', () => {
  const f = feature('feat-a@2026-11-14');
  const opened = applyPr(f, { number: 7, state: 'open', merged: false });
  assert.equal(opened.feature_id, 'feat-a@2026-11-14');
  assert.deepEqual([opened.pr_number, opened.pr_state], [7, 'open']);
  const merged = applyPr(opened, { number: 7, state: 'closed', merged: true, merged_at: '2026-11-18T12:00:00Z' });
  assert.deepEqual([merged.feature_id, merged.pr_state, merged.merged_at], ['feat-a@2026-11-14', 'merged', '2026-11-18T12:00:00Z']);
  const closed = applyPr(opened, { number: 7, state: 'closed', merged: false });
  assert.equal(closed.pr_state, 'closed');
});

test('after merged, the next turn on the same name creates a new feature; the merged one is untouched', () => {
  const merged = feature('renovate/uv-pin@2026-11-01', { pr_state: 'merged', pr_number: 3, merged_at: '2026-11-02T00:00:00Z' });
  const before = structuredClone(merged);
  assert.deepEqual(resolveFeature('renovate/uv-pin', '2026-11-20T08:00:00Z', [merged]), { feature_id: 'renovate/uv-pin@2026-11-20', created: true });
  assert.deepEqual(merged, before);
});

test('two ids minted offline for one branch with no PR between them reconcile to the earlier one', () => {
  const r = reconcile([feature('feat-a@2026-11-20'), feature('feat-a@2026-11-14'), feature('docs-b@2026-11-15')]);
  assert.deepEqual(r, { repoint: [{ from: 'feat-a@2026-11-20', to: 'feat-a@2026-11-14' }], close: ['feat-a@2026-11-20'] });
  // a merged feature between them keeps them apart: nothing to reconcile
  assert.deepEqual(reconcile([feature('feat-a@2026-11-20'), feature('feat-a@2026-11-14', { pr_state: 'merged' })]), { repoint: [], close: [] });
});

test('a deleted branch with no PR becomes abandoned; with a PR it follows the PR', () => {
  assert.equal(transition(feature('gone@2026-11-01'), { branchExists: false, pr: null }).pr_state, 'abandoned');
  assert.equal(transition(feature('gone@2026-11-01'), { branchExists: true, pr: null }).pr_state, 'none');
  assert.equal(transition(feature('gone@2026-11-01'), { branchExists: false, pr: { number: 2, state: 'closed', merged: true, merged_at: 'x' } }).pr_state, 'merged');
});
