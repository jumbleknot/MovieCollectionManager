// Feature 105 US3 — which feature each TURN worked on (data-model.md "Feature attribution"; FR-036;
// research R16, R17). Paths are used here, in the container, only to find the git worktree a tool
// call touched; they never ship. Rules, in order, first match wins:
//   worktree           every path-bearing call resolves to one worktree → its branch
//   worktree-majority  several worktrees → the most calls; ties to the one touched last
//   inherited          no usable path and an earlier turn exists → the previous turn's feature
//   session-branch     no usable path and no earlier turn → the transcript's gitBranch
//   main               the decided branch is the main branch → no feature (null)

export const MAIN_BRANCHES = new Set(['main', 'master']);

/** The git worktree a path lives in, or null: `/…/worktrees/<name>`, or the session's checkout. */
export function worktreeRoot(path, cwd) {
  if (typeof path !== 'string' || path === '') return null;
  const abs = path.startsWith('/') ? path : (cwd ? `${cwd.replace(/\/+$/, '')}/${path.replace(/^\.\//, '')}` : null);
  if (!abs) return null;
  const wt = abs.match(/^(.*\/worktrees\/[^/]+)(?:\/|$)/);
  if (wt) return wt[1];
  const ws = abs.match(/^(\/workspaces\/[^/]+)(?:\/|$)/);
  if (ws) return ws[1];
  if (cwd && (abs === cwd || abs.startsWith(`${cwd}/`))) return cwd;
  return null;
}

/** Directories a Bash command names as its working tree: `cd <dir> && …` and `git -C <dir>`. */
export function bashPaths(command) {
  const s = String(command ?? '');
  const out = [];
  const cd = s.match(/^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*&&/);
  if (cd) out.push(cd[1].replace(/^["']|["']$/g, ''));
  for (const m of s.matchAll(/\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)/g)) out.push(m[1].replace(/^["']|["']$/g, ''));
  return out;
}

/**
 * @param {{turn_seq: number, roots: Record<string, {calls: number, last: number}>, startBranch?: string|null}[]} turns
 *   in order; `roots` counts path-bearing calls per worktree, `last` is the index of the latest one
 * @param {{resolveBranch: (root: string) => string|null, prevBranch?: string|null, hasEarlierTurn?: boolean}} opts
 *   prevBranch: the feature branch of the turn before `turns[0]` (from an earlier ship), null for none
 * @returns {{turn_seq: number, branch: string|null, attribution_rule: string}[]}
 */
export function attributeTurns(turns, { resolveBranch, prevBranch = null, hasEarlierTurn = false }) {
  const out = [];
  let prev = prevBranch;
  let earlier = hasEarlierTurn;
  for (const t of turns) {
    const resolved = Object.entries(t.roots ?? {})
      .map(([root, v]) => ({ root, ...v, branch: resolveBranch(root) }))
      .filter((r) => r.branch && r.branch !== 'HEAD');
    let branch;
    let rule;
    if (resolved.length > 0) {
      const branches = new Set(resolved.map((r) => r.branch));
      if (branches.size === 1) {
        branch = resolved[0].branch;
        rule = 'worktree';
      } else {
        resolved.sort((a, b) => b.calls - a.calls || b.last - a.last);
        branch = resolved[0].branch;
        rule = 'worktree-majority';
      }
    } else if (earlier) {
      branch = prev;
      rule = 'inherited';
    } else {
      // A detached checkout records gitBranch "HEAD": no branch, so no feature (T078).
      branch = t.startBranch && t.startBranch !== 'HEAD' ? t.startBranch : null;
      rule = 'session-branch';
    }
    if (branch === null || MAIN_BRANCHES.has(branch)) {
      // The decided branch is the main branch (directly, or inherited from a main turn): no feature.
      out.push({ turn_seq: t.turn_seq, branch: null, attribution_rule: 'main' });
      prev = null;
    } else {
      out.push({ turn_seq: t.turn_seq, branch, attribution_rule: rule });
      prev = branch;
    }
    earlier = true;
  }
  return out;
}
