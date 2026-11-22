// Feature 105 US3 — a feature's outcomes (data-model.md `features`; research R15; FR-025, FR-034),
// computed in the container where git and the worktrees are. git, the forge and the file system are
// injected (tests), and in production come from `outcomeReaders()` below. At most once per 15 minutes
// per feature (`collected_at`).
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseOrigin, readOrigin } from '../forge-credential.mjs';
import { transition } from './resolve-feature-identity.mjs';
import { timedFetch } from './timed-fetch.mjs';

export const COLLECT_INTERVAL_MS = 15 * 60 * 1000;

/** The spec directory: `.specify/feature.json` first, then `specs/<branch>`, then the branch's NNN- prefix. */
export function resolveSpec({ branch, featureJson, specDirs }) {
  const fd = featureJson?.feature_directory;
  if (typeof fd === 'string' && fd) {
    const m = fd.match(/(?:^|\/)(specs\/[^/]+)\/?$/);
    if (m) return m[1];
  }
  const leaf = String(branch).split('/').pop();
  const exact = specDirs.find((d) => d === `specs/${branch}` || d === `specs/${leaf}`);
  if (exact) return exact;
  const n = leaf.match(/^(\d{3})-/);
  if (n) return specDirs.find((d) => d.startsWith(`specs/${n[1]}-`)) ?? null;
  return null;
}

/** Task checkboxes of a tasks.md: `- [ ] T001 …` / `- [x] T001 …` at any indent. */
export function countTasks(text) {
  let total = 0;
  let done = 0;
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\s*- \[( |x|X)\] T\d{3}\b/);
    if (!m) continue;
    total += 1;
    if (m[1] !== ' ') done += 1;
  }
  return { total, done };
}

const CLOSES = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi;

/**
 * @param {object} feature   the features row (at least feature_id, branch, first_seen_at, pr_state, collected_at)
 * @param {{now: number, worktree: string|null, specDirs: string[], readFile: (p: string) => string|null,
 *          git: {stats: (range: string) => {commits: number, added: number, removed: number}, branchExists: (b: string) => boolean},
 *          forge: {prsForBranch: (b: string) => Promise<object[]>, runs: (pr: object) => Promise<{conclusion: string, created_at: string}[]>}}} deps
 * @returns {Promise<object|null>} the row to upsert, or null when collected less than 15 min ago
 */
export async function collectOutcomes(feature, deps) {
  const { now, worktree, specDirs, readFile, git, forge } = deps;
  if (feature.collected_at && now - Date.parse(feature.collected_at) < COLLECT_INTERVAL_MS) return null;
  const fjText = worktree ? readFile(join(worktree, '.specify', 'feature.json')) : null;
  let featureJson = null;
  try { featureJson = fjText ? JSON.parse(fjText) : null; } catch { /* malformed: ignore */ }
  const spec_dir = resolveSpec({ branch: feature.branch, featureJson, specDirs });
  const row = { ...feature, kind: spec_dir ? 'spec' : 'no-spec', spec_dir, spec_number: spec_dir ? (Number(spec_dir.match(/^specs\/(\d{3})-/)?.[1]) || null) : null };

  // Tasks only for a spec feature; null (not applicable), never 0, without one (FR-025).
  row.tasks_total = null;
  row.tasks_done = null;
  if (spec_dir) {
    const text = (worktree && readFile(join(worktree, spec_dir, 'tasks.md'))) ?? null;
    if (text !== null) {
      const t = countTasks(text);
      row.tasks_total = t.total;
      row.tasks_done = t.done;
    }
  }

  // The PR for THIS feature: opened after the feature started (an older one belongs to an earlier
  // feature of a reused name).
  const prs = (await forge.prsForBranch(feature.branch).catch(() => [])) ?? [];
  const since = Date.parse(feature.first_seen_at ?? 0) - 24 * 3600_000;
  const pr = prs.filter((p) => Date.parse(p.created_at) >= since).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] ?? null;
  Object.assign(row, transition(row, { branchExists: git.branchExists(feature.branch), pr }));

  const range = pr?.merged && pr.merge_base && pr.merge_commit_sha ? `${pr.merge_base}..${pr.merge_commit_sha}` : `origin/main..${feature.branch}`;
  const st = git.stats(range);
  if (st) Object.assign(row, { commits: st.commits, lines_added: st.added, lines_removed: st.removed });

  // Every outcome column is always set, so all outcome rows share one key set (one bulk upsert).
  Object.assign(row, { ci_runs_red: 0, ci_runs_green: 0, first_red_at: null, backlog_closed: 0, pr_number: row.pr_number ?? null, merged_at: row.merged_at ?? null });
  row.commits ??= 0;
  row.lines_added ??= 0;
  row.lines_removed ??= 0;
  if (pr) {
    const runs = (await forge.runs(pr).catch(() => [])) ?? [];
    const red = runs.filter((r) => r.conclusion === 'failure');
    row.ci_runs_red = red.length;
    row.ci_runs_green = runs.filter((r) => r.conclusion === 'success').length;
    row.first_red_at = red.map((r) => r.created_at).sort()[0] ?? null;
    row.backlog_closed = pr.merged ? new Set([...String(pr.body ?? '').matchAll(CLOSES)].map((m) => m[1])).size : 0;
  }
  row.collected_at = new Date(now).toISOString();
  return row;
}

// --- production readers -------------------------------------------------------------------------------

function gitIn(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

/** Readers over local git and the forge API (MCM_FORGE_TOKEN, read only). `repo` is any checkout. */
export function outcomeReaders({ repo, env = process.env, fetch = globalThis.fetch }) {
  let api = null;
  try {
    const o = parseOrigin(readOrigin());
    api = { base: `${o.apiBase}/repos/${o.owner}/${o.repo}`, token: env.MCM_FORGE_TOKEN };
  } catch { /* no usable origin: forge facts stay unset */ }
  const get = async (path) => {
    if (!api?.token) return [];
    const r = await timedFetch(fetch, `${api.base}${path}`, { headers: { authorization: `token ${api.token}`, accept: 'application/json' } });
    if (!r.ok) return [];
    try { return JSON.parse(r.body); } catch { return []; }
  };
  const specsDir = join(repo, 'specs');
  return {
    specDirs: existsSync(specsDir) ? readdirSync(specsDir).map((d) => `specs/${d}`) : [],
    readFile: (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } },
    git: {
      branchExists: (b) => gitIn(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]) !== null || gitIn(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${b}`]) !== null,
      stats: (range) => {
        const out = gitIn(repo, ['log', '--no-merges', '--numstat', '--format=%H', range]);
        if (out === null) return null;
        let commits = 0; let added = 0; let removed = 0;
        for (const l of out.split('\n')) {
          if (/^[0-9a-f]{40}$/.test(l)) commits += 1;
          const m = l.match(/^(\d+)\t(\d+)\t/);
          if (m) { added += Number(m[1]); removed += Number(m[2]); }
        }
        return { commits, added, removed };
      },
    },
    forge: {
      prsForBranch: async (b) => (await get(`/pulls?state=all&limit=50&sort=recentupdate`)).filter((p) => p?.head?.ref === b)
        .map((p) => ({ number: p.number, state: p.state, merged: Boolean(p.merged), merged_at: p.merged_at ?? null, created_at: p.created_at, body: p.body ?? '', head_sha: p.head?.sha ?? null, merge_commit_sha: p.merge_commit_sha ?? null, merge_base: p.merge_base ?? null })),
      // One "run" per pushed commit of the PR (the most recent 10): red when any status failed, green
      // when every status passed; pending commits count as neither.
      runs: async (pr) => {
        const commits = (await get(`/pulls/${pr.number}/commits?limit=10`)).map((c) => c?.sha).filter(Boolean);
        const out = [];
        for (const sha of commits.slice(-10)) {
          const statuses = await get(`/commits/${sha}/statuses?limit=50`);
          const latest = new Map();
          for (const st of statuses) if (!latest.has(st.context)) latest.set(st.context, st);
          const v = [...latest.values()];
          if (!v.length) continue;
          const at = v.map((x) => x.created_at).sort()[0];
          if (v.some((x) => x.status === 'failure' || x.status === 'error')) out.push({ conclusion: 'failure', created_at: at });
          else if (v.every((x) => x.status === 'success')) out.push({ conclusion: 'success', created_at: at });
        }
        return out;
      },
    },
  };
}
