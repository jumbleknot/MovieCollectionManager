#!/usr/bin/env node
// Item #879 — delete remote branches that are fully merged into main and that nothing is using.
//
// WHY THIS EXISTS. A merged branch left on `origin` is not harmless. A surviving `renovate/*` branch
// makes Renovate REUSE the stale commit instead of regenerating: the 2026-10-30 window opened PRs
// #874–#877 on the four `lock-file-maintenance*` branches the 2026-10-23/24 merges left behind — each
// head an ancestor of main, so each PR was empty, and all four went red on `sast` against a week-old
// allowlist. `default_delete_branch_after_merge` (item #290) covers the web UI merge button ONLY; an API
// merge leaves the head unless the request passes `delete_branch_after_merge: true`. The rule "always
// pass the flag" did not hold — 33 merged branches had accumulated by that day — so this does not rely
// on anyone remembering anything.
//
// A branch is deleted only when EVERY one of these holds (selectReapable):
//   - its tip is an ancestor of origin/main             — nothing unreachable is ever lost
//   - it is not the head of an OPEN pull request         — that is hand-closing by another route, and for
//                                                          a lockFileMaintenance branch it marks the
//                                                          channel rejected (renovate.md §4)
//   - it is not exempt (main, automation-owned branches) — openwiki-maintenance is recreated by its job
//   - its tip commit is older than the grace period      — a concurrent session's just-merged branch is
//                                                          left alone until a later run
//
// FAIL CLOSED. An open-PR listing that errors or comes back short of its own x-total-count deletes
// NOTHING: "I could not read the open PRs" must never read as "there are no open PRs". Ancestry that
// cannot be answered keeps the branch.
//
// THE DELETE IS LEASED to the exact sha that was classified: `git push --force-with-lease=<ref>:<sha>`.
// A session that pushes a new (unmerged) commit between classification and deletion makes the push
// fail rather than destroying that commit. The forge's DELETE /branches endpoint has no such
// precondition, which is why this goes through git.
//
// DRY-RUN IS THE DEFAULT; --apply is required to delete (the inverted-flag lesson from
// prune-bff-runtime-modules.mjs, item #500).

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { partitionArgs, wantsHelp, dieOnArgvError } from './lib/argv-contract.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_BRANCH = 'main';
/** Branches an automation owns and recreates. Deleting one is churn at best, a lost run at worst. */
export const EXEMPT = new Set([DEFAULT_BRANCH, 'openwiki-maintenance']);
export const GRACE_MS = 6 * 60 * 60 * 1000;
const PAGE = 50; // the forge's page cap (backlog skill, measured)

/**
 * Decide, for every remote branch, whether it may be deleted — and if not, why not.
 *
 * @param {{name: string, sha: string, tipDate: Date}[]} branches
 * @param {{openPrHeads: Set<string>, isAncestor: (name: string) => boolean|null,
 *          exempt?: Set<string>, now?: Date, graceMs?: number}} ctx
 * @returns {{reap: {name: string, sha: string}[], keep: {name: string, reason: string}[]}}
 */
export function selectReapable(branches, { openPrHeads, isAncestor, exempt = EXEMPT, now = new Date(), graceMs = GRACE_MS }) {
  const reap = [];
  const keep = [];
  for (const b of branches) {
    if (exempt.has(b.name)) {
      keep.push({ name: b.name, reason: 'exempt' });
      continue;
    }
    if (openPrHeads.has(b.name)) {
      keep.push({ name: b.name, reason: 'head of an open PR' });
      continue;
    }
    const anc = isAncestor(b.name);
    if (anc === null || anc === undefined) {
      keep.push({ name: b.name, reason: 'ancestry unanswerable' });
      continue;
    }
    if (!anc) {
      keep.push({ name: b.name, reason: 'not merged into main' });
      continue;
    }
    if (!(b.tipDate instanceof Date) || Number.isNaN(b.tipDate.getTime())) {
      keep.push({ name: b.name, reason: 'tip date unreadable' });
      continue;
    }
    if (now.getTime() - b.tipDate.getTime() < graceMs) {
      keep.push({ name: b.name, reason: 'inside grace period' });
      continue;
    }
    reap.push({ name: b.name, sha: b.sha });
  }
  return { reap, keep };
}

/**
 * Collect EVERY open PR head, or throw. A short read is an error, not a smaller answer.
 *
 * @param {(page: number) => Promise<{rows: object[], total: number|null}>} fetchPage
 * @returns {Promise<Set<string>>}
 */
export async function collectOpenPrHeads(fetchPage) {
  const rows = [];
  let total = null;
  for (let page = 1; ; page++) {
    const res = await fetchPage(page);
    if (!Array.isArray(res?.rows)) throw new Error(`open-PR page ${page} was not a list`);
    if (res.total === null || res.total === undefined || Number.isNaN(Number(res.total))) {
      throw new Error(`open-PR page ${page} carried no x-total-count — cannot prove the listing is complete`);
    }
    total = Number(res.total);
    rows.push(...res.rows);
    if (res.rows.length < PAGE || rows.length >= total) break;
  }
  if (rows.length !== total) {
    throw new Error(`open-PR listing returned ${rows.length} rows against x-total-count ${total}`);
  }
  return new Set(rows.map((pr) => pr?.head?.ref).filter(Boolean));
}

// ── The I/O shell ─────────────────────────────────────────────────────────────────────────────────

function git(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function gitIsAncestor(branch) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', `refs/remotes/origin/${branch}`, `refs/remotes/origin/${DEFAULT_BRANCH}`], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
    });
    return true;
  } catch (err) {
    if (err?.status === 1) return false; // a real answer: not an ancestor
    return null; // could not answer (missing ref, shallow clone) — the branch is kept
  }
}

function listRemoteBranches() {
  const out = git(['for-each-ref', '--format=%(refname:strip=3)%09%(objectname)%09%(committerdate:iso-strict)', 'refs/remotes/origin']);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, sha, date] = line.split('\t');
      return { name, sha, tipDate: new Date(date) };
    })
    .filter((b) => b.name !== 'HEAD');
}

async function main({ apply }) {
  const token = process.env.GITHUB_TOKEN?.trim() || process.env.MCM_FORGE_TOKEN?.trim();
  if (!token) throw new Error('no GITHUB_TOKEN (or MCM_FORGE_TOKEN) — cannot read open pull requests');
  const server = (process.env.GITHUB_SERVER_URL ?? '').replace(/\/$/, '') || git(['remote', 'get-url', 'origin']).trim().replace(/^(https?:\/\/)(?:[^@/]*@)?([^/]+).*$/, '$1$2');
  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? 'jumbleknot/mcm').split('/');

  git(['fetch', '--prune', '--quiet', 'origin']);
  const openPrHeads = await collectOpenPrHeads(async (page) => {
    const res = await fetch(`${server}/api/v1/repos/${owner}/${repo}/pulls?state=open&limit=${PAGE}&page=${page}`, {
      headers: { Authorization: `token ${token}`, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`GET open pulls page ${page} → ${res.status} ${(await res.text()).slice(0, 200)}`);
    return { rows: await res.json(), total: res.headers.get('x-total-count') };
  });

  const { reap, keep } = selectReapable(listRemoteBranches(), { openPrHeads, isAncestor: gitIsAncestor });
  for (const k of keep) console.log(`keep  ${k.name}  (${k.reason})`);
  for (const r of reap) console.log(`${apply ? 'reap ' : 'would reap'}  ${r.name}  ${r.sha.slice(0, 8)}`);
  console.log(`[reap-merged-branches] open PRs=${openPrHeads.size} keep=${keep.length} ${apply ? 'reap' : 'would reap'}=${reap.length}${apply ? '' : '  (dry run — pass --apply to delete)'}`);
  if (!apply) return 0;

  let failed = 0;
  for (const r of reap) {
    try {
      git(['push', '--quiet', `--force-with-lease=refs/heads/${r.name}:${r.sha}`, 'origin', `:refs/heads/${r.name}`]);
      console.log(`deleted  ${r.name}`);
    } catch (err) {
      failed++;
      console.error(`FAILED to delete ${r.name}: ${String(err.stderr ?? err.message).trim()}`);
    }
  }
  if (failed) console.error(`[reap-merged-branches] ${failed} deletion(s) failed`);
  return failed ? 1 : 0;
}

// ── The argument contract (item #500) ────────────────────────────────────────────────────────────

export const ACCEPTED_FLAGS = ['--apply', '--help', '-h'];

export const USAGE = `reap-merged-branches.mjs — delete remote branches already merged into main (item #879).

  node scripts/reap-merged-branches.mjs           list what WOULD be deleted, and why everything else is kept
  node scripts/reap-merged-branches.mjs --apply   delete them (leased to the classified sha)
  node scripts/reap-merged-branches.mjs --help    this text

A bare invocation deletes NOTHING. .forgejo/workflows/branch-reaper.yml runs it with --apply.`;

/** @returns {{command: 'help'|'dry-run'|'apply'}} @throws {ArgvError} on anything not in ACCEPTED_FLAGS */
export function resolveCommand(argv = []) {
  const args = (argv ?? []).filter((a) => a !== '');
  if (wantsHelp(args)) return { command: 'help' };
  const { flags } = partitionArgs(args, { accepted: ACCEPTED_FLAGS, maxPositionals: 0, usage: USAGE });
  return { command: flags.has('--apply') ? 'apply' : 'dry-run' };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let command;
  try {
    ({ command } = resolveCommand(process.argv.slice(2)));
  } catch (err) {
    dieOnArgvError(err);
  }
  if (command === 'help') {
    console.log(USAGE);
  } else {
    main({ apply: command === 'apply' })
      .then((code) => {
        process.exitCode = code;
      })
      .catch((err) => {
        // Exit non-zero, unlike the comment-only jobs: a reaper that silently stopped reaping is the
        // exact absence this item exists to end, and the failure digest only fires on a red job.
        console.error(`[reap-merged-branches] FAILED, nothing (further) deleted: ${err.message}`);
        process.exitCode = 1;
      });
  }
}
