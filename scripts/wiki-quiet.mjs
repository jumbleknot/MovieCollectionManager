#!/usr/bin/env node
// Feature 078 research R19 / item #613 — has `main` gone quiet? Decides whether a scheduled
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
//   * the OLDEST is ≥ MAX_DEFERRAL       → run: a main that never goes quiet must not starve (SC-008b);
//   * the NEWEST is ≥ DEBOUNCE           → run: main is quiet;
//   * otherwise                          → not yet; the next fire looks again.
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

export const DEBOUNCE_SECONDS = 15 * 60;
export const MAX_DEFERRAL_SECONDS = 6 * 60 * 60;
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

/**
 * Generate now, or end and let the next scheduled fire look again?
 * At-or-above each threshold it RUNS: a strict `>` would let an age pinned exactly at it defer forever.
 */
export function maintenanceTrigger({
  commits,
  nowSeconds,
  dispatched = false,
  debounceSeconds = DEBOUNCE_SECONDS,
  maxDeferralSeconds = MAX_DEFERRAL_SECONDS,
}) {
  if (dispatched) return { run: true, reason: 'manually dispatched — the quiet period is bypassed (FR-009c)' };
  const real = commits.filter((c) => !isOwnCommit(c));
  if (real.length === 0) {
    const own = commits.length ? ` (${commits.length} of the job's own commit(s) ignored)` : '';
    return { run: false, reason: `nothing uncovered${own} — no run` };
  }
  const ages = real.map((c) => nowSeconds - c.time);
  const oldest = Math.max(...ages);
  const newest = Math.min(...ages);
  const min = (s) => Math.round(s / 60);
  if (oldest >= maxDeferralSeconds) {
    return { run: true, reason: `the oldest uncovered commit is ${min(oldest)} min old, at or past the ${min(maxDeferralSeconds)}-min maximum deferral — running now` };
  }
  if (newest >= debounceSeconds) {
    return { run: true, reason: `main is quiet: the newest of ${real.length} uncovered commit(s) is ${min(newest)} min old (≥ ${min(debounceSeconds)}) — running now` };
  }
  return { run: false, reason: `not yet — main is not quiet: the newest uncovered commit is ${min(newest)} min old (< ${min(debounceSeconds)}); the next scheduled fire looks again` };
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
  const d = maintenanceTrigger({ commits, nowSeconds: Math.floor(Date.now() / 1000), dispatched });
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
