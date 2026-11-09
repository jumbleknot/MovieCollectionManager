#!/usr/bin/env node
// Feature 078 research R19 / item #613, amended by US7 (2026-11-09) — is anything uncovered? Decides whether the daily
// wiki-maintain fire generates now or ends.
//
// WHY THIS IS OUTSIDE THE JOB. The debounce used to be a `sleep 900` inside the merge-triggered job:
// 15 of its 60 minutes spent waiting, ~37 left for generation, against a measured worst invocation of
// 49 min. Operator option A (2026-11-01): the schedule does the waiting. This check runs on every fire,
// BEFORE any install — node built-ins only, so a "not yet" costs a checkout and one node process.
//
// THE RULE, over main's first-parent commits past the run record's `coveredCommit`:
//   * the job's own commits never count — `[skip ci]` (the record marker, CD's digest promotes) and
//     `openwiki/`-only changes (a merged proposal). Neither ever started a push run (FR-009a, SC-005a);
//   * none left                          → no run;
//   * any left, of any age               → run.
// The schedule fires ONCE A DAY (078 FR-024, amendment 2026-11-09, research R21), and that is the
// batching: a page changed by ten merges is paid for once. The 15-minute debounce and the 6-hour
// maximum deferral this replaced existed to batch a fire every 30 minutes; a daily fire cannot starve,
// and a debounce would only push a merge that landed just before it to the next day.
// A dispatch runs regardless (FR-009c).
//
// A GIT FAILURE IS LOUD. An unknown `coveredCommit` (a history rewrite) or a missing run record exits 1.
// Read as "nothing uncovered" it would end maintenance silently, for ever.
//
//   node scripts/wiki-quiet.mjs [--dispatched] [--root <dir>]
//   stdout: run=true | run=false     stderr: the reason     exit: 0 decided · 1 git/record failure · 2 usage

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArgvError, dieOnArgvError, partitionArgsWithValues, wantsHelp } from './lib/argv-contract.mjs';

/** Same path as wiki-maintain.mjs's STATE_FILE; not imported, because that module needs `yaml`. */
export const STATE_FILE = 'openwiki/.maintenance-state.json';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'usage: node scripts/wiki-quiet.mjs [--dispatched] [--root <dir>]';

/** The job's own work: the record marker / CD promotes (`[skip ci]`), or a merged bundle-only proposal. */
export function isOwnCommit({ message = '', files = [] }) {
  if (message.includes('[skip ci]')) return true;
  // An empty list is NOT bundle-only: a commit whose diff could not be read counts as real work.
  return files.length > 0 && files.every((f) => f.startsWith('openwiki/'));
}

/** Generate now, or end and let the next daily fire look again? */
export function maintenanceTrigger({ commits, dispatched = false }) {
  if (dispatched) return { run: true, reason: 'manually dispatched — runs whatever is uncovered (FR-009c)' };
  const real = commits.filter((c) => !isOwnCommit(c));
  if (real.length === 0) {
    const own = commits.length ? ` (${commits.length} of the job's own commit(s) ignored)` : '';
    return { run: false, reason: `nothing uncovered${own} — no run` };
  }
  const own = commits.length - real.length;
  return { run: true, reason: `${real.length} real uncovered commit(s)${own ? ` (${own} of the job's own ignored)` : ''} — running now` };
}

function git(root, args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/**
 * main's first-parent commits past `coveredCommit`, newest first: one per merge or direct push — the
 * granularity a push trigger used to see. Raises on any git failure.
 */
export function uncoveredCommits({ root = REPO_ROOT, coveredCommit }) {
  if (!coveredCommit || git(root, ['rev-parse', '--verify', '--quiet', `${coveredCommit}^{commit}`]).status !== 0) {
    throw new Error(`coveredCommit ${coveredCommit || '(none)'} is not a commit in this history — refusing to guess`);
  }
  const log = git(root, ['log', '--first-parent', '-z', '--format=%H%x1f%ct%x1f%B', `${coveredCommit}..HEAD`]);
  if (log.status !== 0) throw new Error(`git log ${coveredCommit}..HEAD failed: ${log.stderr.trim()}`);
  return log.stdout.split('\0').filter((r) => r.trim()).map((rec) => {
    const [sha, ct, message] = rec.replace(/^\n+/, '').split('\x1f');
    // The first-parent diff: for a merge commit, what the merge brought into main.
    const diff = git(root, ['diff', '--name-only', `${sha}^1`, sha]);
    if (diff.status !== 0) throw new Error(`git diff ${sha.slice(0, 8)}^1 failed: ${diff.stderr.trim()}`);
    return { sha, time: Number(ct), message: message.trim(), files: diff.stdout.split('\n').filter(Boolean) };
  });
}

/** The run record's `coveredCommit`, read without `yaml`. A missing or unreadable record raises. */
export function readCoveredCommit(root = REPO_ROOT) {
  const p = join(root, STATE_FILE);
  if (!existsSync(p)) throw new Error(`${STATE_FILE} does not exist — cannot tell what is uncovered`);
  const record = JSON.parse(readFileSync(p, 'utf8'));
  return record?.coveredCommit ?? null;
}

function main(argv) {
  if (wantsHelp(argv)) {
    console.log(USAGE);
    return 0;
  }
  const { flags, values } = partitionArgsWithValues(argv, { accepted: ['--dispatched'], withValues: ['--root'], usage: USAGE });
  const root = resolve(values.get('--root') ?? REPO_ROOT);
  const dispatched = flags.has('--dispatched');
  let commits = [];
  if (!dispatched) {
    try {
      commits = uncoveredCommits({ root, coveredCommit: readCoveredCommit(root) });
    } catch (err) {
      console.error(`[wiki-quiet] ${err.message}`);
      return 1;
    }
  }
  const d = maintenanceTrigger({ commits, dispatched });
  console.log(`run=${d.run}`);
  console.error(`[wiki-quiet] ${d.reason}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    if (err instanceof ArgvError) dieOnArgvError(err);
    else throw err;
  }
}
