// Feature 105 US3 — feature identity and its PR state (data-model.md `features`: identity rule and the
// pr_state machine; FR-035; research R17). Pure functions; the store and the forge are the caller's.
//
//   A turn on branch b joins b's OPEN feature (pr_state none|open); with none, `b@<date>` is created.
//   The PR, once found, is recorded on that row — the id never changes, so turns never re-key.
//   merged / closed / abandoned close a feature to new turns; the next turn on b opens a new one.

export const OPEN_STATES = new Set(['none', 'open']);

const dateOf = (iso) => new Date(iso).toISOString().slice(0, 10);

/**
 * @param {string} branch
 * @param {string} turnIso   the turn's start, which dates a new feature
 * @param {{feature_id: string, branch: string, pr_state: string, first_seen_at?: string}[]} known
 * @returns {{feature_id: string, created: boolean}}
 */
export function resolveFeature(branch, turnIso, known) {
  const open = known
    .filter((f) => f.branch === branch && OPEN_STATES.has(f.pr_state))
    .sort((a, b) => String(a.first_seen_at ?? a.feature_id).localeCompare(String(b.first_seen_at ?? b.feature_id)));
  if (open.length) return { feature_id: open[0].feature_id, created: false };
  return { feature_id: `${branch}@${dateOf(turnIso)}`, created: true };
}

/** Record a PR on a feature (forge shape: number, state open|closed, merged, merged_at). */
export function applyPr(feature, pr) {
  if (!pr) return { ...feature };
  const pr_state = pr.merged ? 'merged' : pr.state === 'open' ? 'open' : 'closed';
  return { ...feature, pr_number: pr.number, pr_state, merged_at: pr.merged ? (pr.merged_at ?? null) : null };
}

/** The state transition at collection time: a PR decides; with none, a deleted branch is abandoned. */
export function transition(feature, { branchExists, pr }) {
  if (pr) return applyPr(feature, pr);
  if (!branchExists && feature.pr_state === 'none') return { ...feature, pr_state: 'abandoned' };
  return { ...feature };
}

/**
 * Two OPEN features on one branch with no PR (ids minted offline by two sessions) reconcile to the
 * earlier: its turns are re-pointed and the later row closed. A closed or merged feature between them
 * would mean a reused name, which is not reconciled — but then only one is open, so nothing pairs.
 */
export function reconcile(features) {
  const byBranch = new Map();
  for (const f of features) {
    if (f.pr_state !== 'none') continue;
    (byBranch.get(f.branch) ?? byBranch.set(f.branch, []).get(f.branch)).push(f);
  }
  const repoint = [];
  const close = [];
  for (const [branch, list] of byBranch) {
    if (features.some((f) => f.branch === branch && !OPEN_STATES.has(f.pr_state) && list.length > 1)) {
      // a merged/closed feature of the same name: only reconcile ids minted AFTER it
      const closedAt = features.filter((f) => f.branch === branch && !OPEN_STATES.has(f.pr_state)).map((f) => f.first_seen_at ?? '').sort().at(-1);
      const after = list.filter((f) => (f.first_seen_at ?? '') > closedAt);
      if (after.length < 2) continue;
      list.splice(0, list.length, ...after);
    }
    if (list.length < 2) continue;
    list.sort((a, b) => String(a.first_seen_at).localeCompare(String(b.first_seen_at)));
    for (const later of list.slice(1)) {
      repoint.push({ from: later.feature_id, to: list[0].feature_id });
      close.push(later.feature_id);
    }
  }
  return { repoint, close };
}
