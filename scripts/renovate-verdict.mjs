#!/usr/bin/env node
// Items #1125, #1124, #1123 — what a Renovate run ACTUALLY did, read from Renovate's own log.
//
// WHY THE EXIT CODE IS NOT ENOUGH. Renovate exits non-zero on a logged ERROR, but it exits 0 having
// done nothing useful in every shape this repository has already met: a channel whose toolchain is
// missing dies to a suppressed WARN (#218), a lockFileMaintenance branch starved by the PR budget
// never appears (#218 again), a window run that is not in the window defers everything (#153). Each
// was discovered by incident. Renovate already writes the answer — the `Repository finished` result
// and a `branches info extended` entry carrying every branch's `result` — to its JSON log file
// (RENOVATE_LOG_FILE, debug level). This reads it.
//
//   preflight            BEFORE the run: the token can read the user, the repository, its pulls and
//                        its issues. A missing scope fails here, naming it, instead of as a 403 deep
//                        inside a run that then "succeeds". Write scopes cannot be probed without
//                        writing, so they are not; the run's own result covers them.
//   verdict --log <f>    AFTER the run. Fails on: no `Repository finished`, a result other than
//                        `done`, any ERROR/FATAL entry, and — on a LIVE run inside the
//                        lockFileMaintenance window — a lock-file channel that was not scheduled,
//                        starved by a limit, rejected (closed PR), errored, or absent. On a scheduled
//                        run it also fails when item #311's newest health digest is older than 8 days:
//                        the digest is comment-only, so its silence is noticed HERE or not at all.
//
// Usage:  node scripts/renovate-verdict.mjs preflight
//         node scripts/renovate-verdict.mjs verdict --log renovate-log.ndjson

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArgvError, partitionArgsWithValues, wantsHelp, dieOnArgvError } from './lib/argv-contract.mjs';
import { isMain } from './lib/is-main.mjs';
import { parseWindow, inWindow } from './lib/renovate-window.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DIGEST_ITEM = 311;
export const DIGEST_MAX_AGE_DAYS = 8;

// ── Lock-file branch results → states ─────────────────────────────────────────────────────────────
// Renovate's BranchResult (lib/workers/types.ts, 44.x), grouped by what each means for the channel.
const REFRESHED = new Set(['pr-created', 'pr-edited', 'done', 'rebase', 'automerged', 'pending']);
const NOTHING = new Set(['no-work']);
const NOT_SCHEDULED = new Set(['not-scheduled', 'update-not-scheduled']);
const STARVED = new Set(['pr-limit-reached', 'branch-limit-reached', 'commit-per-run-limit-reached', 'commit-hourly-limit-reached']);
const REJECTED = new Set(['already-existed']); // a closed lock-file PR: Renovate will not reopen it
const ERRORED = new Set(['error']);

/** One lock-file branch's state: refreshed | nothing | not-scheduled | starved | rejected | error | other. */
export function lockFileState(result) {
  if (REFRESHED.has(result)) return 'refreshed';
  if (NOTHING.has(result)) return 'nothing';
  if (NOT_SCHEDULED.has(result)) return 'not-scheduled';
  if (STARVED.has(result)) return 'starved';
  if (REJECTED.has(result)) return 'rejected';
  if (ERRORED.has(result)) return 'error';
  return 'other';
}

/** The states that mean the channel is DEAD for this window — the ones a live window run fails on. */
export const DEAD_STATES = new Set(['not-scheduled', 'starved', 'rejected', 'error', 'absent']);

/** Parse an ndjson log; unparseable lines are counted, not fatal (Renovate can interleave stack text). */
export function parseLog(text) {
  const entries = [];
  let unparseable = 0;
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      unparseable += 1;
    }
  }
  return { entries, unparseable };
}

/**
 * The verdict on one run.
 *
 * @param {object[]} entries the parsed JSON log
 * @param {{window: object|null, dryRun: boolean}} ctx  window = parseWindow(renovate.json)
 * @returns {{failures: string[], report: string[], lockFile: {state: string, branches: object[]}|null, inWindow: boolean|null}}
 */
export function judgeRun(entries, { window, dryRun }) {
  const failures = [];
  const report = [];

  if (!entries.length) {
    return { failures: ['the Renovate log is EMPTY — the run wrote nothing, so nothing it did can be verified'], report, lockFile: null, inWindow: null };
  }

  // 1. Did the repository finish, and how?
  const finished = entries.filter((e) => e?.msg === 'Repository finished');
  if (finished.length !== 1) {
    failures.push(`expected exactly one "Repository finished" entry, found ${finished.length} — the run did not process jumbleknot/mcm to completion`);
  } else {
    const f = finished[0];
    report.push(`repository: result=${f.result} status=${f.status} (${Math.round((f.durationMs ?? 0) / 1000)} s)`);
    if (f.result !== 'done') failures.push(`the repository result is "${f.result}" (status ${f.status}), not "done"`);
  }

  // 2. Any ERROR or FATAL — bunyan levels 50 and 60.
  const errors = entries.filter((e) => Number(e?.level) >= 50);
  if (errors.length) {
    failures.push(`${errors.length} ERROR/FATAL log entr${errors.length === 1 ? 'y' : 'ies'}: ${[...new Set(errors.map((e) => e.msg))].slice(0, 5).map((m) => `"${m}"`).join(', ')}`);
  }

  // 3. The branches, and the lock-file channel among them.
  const info = entries.findLast?.((e) => e?.msg === 'branches info extended') ?? [...entries].reverse().find((e) => e?.msg === 'branches info extended');
  const branches = Array.isArray(info?.branchesInformation) ? info.branchesInformation : null;
  const startedAt = entries.find((e) => e?.time)?.time ?? null;
  const runInWindow = window && startedAt ? inWindow(startedAt, window) : null;
  report.push(`started ${startedAt ?? '<unknown>'} — ${runInWindow === null ? 'window unknown' : runInWindow ? 'INSIDE the lockFileMaintenance window' : 'outside the lockFileMaintenance window'}${dryRun ? ' (DRY RUN)' : ''}`);

  let lockFile = null;
  if (!branches) {
    report.push('branches: no "branches info extended" entry (the log level must be debug)');
  } else {
    const counts = {};
    for (const b of branches) counts[b.result ?? '<none>'] = (counts[b.result ?? '<none>'] ?? 0) + 1;
    report.push(`branches: ${branches.length} — ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    const lf = branches.filter((b) => (b.upgrades ?? []).some((u) => u?.updateType === 'lockFileMaintenance'));
    const states = lf.map((b) => ({ branch: b.branchName, result: b.result, state: lockFileState(b.result) }));
    // Worst state wins: one dead lock-file branch is a dead channel for that ecosystem.
    const order = ['error', 'rejected', 'starved', 'not-scheduled', 'other', 'nothing', 'refreshed'];
    const state = states.length ? order.find((s) => states.some((x) => x.state === s)) : 'absent';
    lockFile = { state, branches: states };
    report.push(`lock-file maintenance: ${state}${states.length ? ` — ${states.map((s) => `${s.branch}=${s.result}`).join(', ')}` : ' (no lockFileMaintenance branch in this run)'}`);
  }

  // A live run inside the window is the only run whose lock-file channel MUST have worked.
  if (runInWindow && !dryRun) {
    if (!lockFile) failures.push('inside the lockFileMaintenance window but the log carries no branch information, so the channel cannot be verified');
    else if (DEAD_STATES.has(lockFile.state)) {
      failures.push(`inside the lockFileMaintenance window the lock-file channel is ${lockFile.state.toUpperCase()} — ${{
        'not-scheduled': 'Renovate considered it outside its schedule; the window and the cron no longer intersect (#153)',
        starved: 'a PR/branch/commit limit was spent before it (#218 — it sorts last)',
        rejected: 'its PR was closed, so Renovate will not reopen the branch (runbook §4)',
        error: 'its branch errored',
        absent: 'no lockFileMaintenance branch exists at all — a missing toolchain or a disabled channel (#218)',
      }[lockFile.state]}`);
    }
  }
  return { failures, report, lockFile, inWindow: runInWindow };
}

/** Is the newest health-digest comment older than the limit? Returns a failure string or null. */
export function digestStaleness(item, comments, now = new Date(), maxAgeDays = DIGEST_MAX_AGE_DAYS) {
  if (item?.state !== 'open') return null; // closing #311 is the digest's kill switch — no digest is expected
  const newest = (comments ?? []).map((c) => Date.parse(c?.created_at)).filter(Number.isFinite).sort((a, b) => b - a)[0];
  if (newest === undefined) {
    return `item #${DIGEST_ITEM} is open but carries no health digest from the last ${maxAgeDays} days — renovate-health.yml has stopped reporting`;
  }
  const ageDays = (now.getTime() - newest) / 864e5;
  if (ageDays > maxAgeDays) {
    return `the newest health digest on item #${DIGEST_ITEM} is ${ageDays.toFixed(1)} days old (limit ${maxAgeDays}) — renovate-health.yml has stopped reporting`;
  }
  return null;
}

/**
 * The token preflight. Each probe names the scope a 401/403 means is missing.
 * @param {(path: string) => Promise<{status: number}>} get
 */
export async function preflight(get, repo) {
  const probes = [
    ['/user', 'read:user'],
    [`/repos/${repo}`, 'read:repository'],
    [`/repos/${repo}/pulls?state=open&page=1&limit=1`, 'read:repository'],
    [`/repos/${repo}/issues?type=issues&state=open&page=1&limit=1`, 'read:issue'],
  ];
  const problems = [];
  for (const [path, scope] of probes) {
    let status;
    try {
      status = (await get(path)).status;
    } catch (err) {
      problems.push(`GET ${path} did not answer (${err.message}) — the forge is unreachable from this job`);
      continue;
    }
    if (status === 401) problems.push(`GET ${path} → 401: RENOVATE_TOKEN is missing, expired or wrong`);
    else if (status === 403) problems.push(`GET ${path} → 403: RENOVATE_TOKEN lacks the ${scope} scope`);
    else if (status >= 400) problems.push(`GET ${path} → ${status}`);
  }
  return problems;
}

// ── I/O ──────────────────────────────────────────────────────────────────────────────────────────

function forge() {
  const server = (process.env.GITHUB_SERVER_URL ?? '').replace(/\/$/, '');
  if (!server) throw new Error('GITHUB_SERVER_URL is not set');
  return { base: `${server}/api/v1`, repo: process.env.GITHUB_REPOSITORY ?? 'jumbleknot/mcm' };
}

async function runPreflight() {
  const token = process.env.RENOVATE_TOKEN?.trim();
  if (!token) {
    console.error('✗ RENOVATE_TOKEN is empty — the Actions secret is missing, or this run has no secrets (an AGit head)');
    return 1;
  }
  const { base, repo } = forge();
  const problems = await preflight((path) => fetch(`${base}${path}`, { headers: { Authorization: `token ${token}` } }), repo);
  for (const p of problems) console.error(`✗ ${p}`);
  if (!problems.length) console.log('✓ RENOVATE_TOKEN reads the user, the repository, its pulls and its issues');
  return problems.length ? 1 : 0;
}

async function runVerdict(logPath) {
  let text;
  try {
    text = readFileSync(resolve(logPath), 'utf8');
  } catch (err) {
    console.error(`✗ cannot read the Renovate log ${logPath}: ${err.message} — RENOVATE_LOG_FILE was not written`);
    return 1;
  }
  const config = JSON.parse(readFileSync(resolve(REPO_ROOT, 'renovate.json'), 'utf8'));
  const { entries, unparseable } = parseLog(text);
  const dryRun = Boolean(process.env.RENOVATE_DRY_RUN?.trim());
  const { failures, report } = judgeRun(entries, { window: parseWindow(config), dryRun });
  if (unparseable) report.push(`(${unparseable} non-JSON line(s) in the log were skipped)`);

  // Item #1123: the health digest's silence, noticed by the one job guaranteed to run nightly.
  if (process.env.GITHUB_EVENT_NAME === 'schedule') {
    const token = process.env.CI_DIGEST_TOKEN?.trim();
    if (!token) {
      failures.push('CI_DIGEST_TOKEN is empty, so the health digest\'s age on item #311 cannot be checked');
    } else {
      try {
        const { base, repo } = forge();
        const get = async (path) => {
          const res = await fetch(`${base}${path}`, { headers: { Authorization: `token ${token}` } });
          if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
          return res.json();
        };
        const item = await get(`/repos/${repo}/issues/${DIGEST_ITEM}`);
        // Newest first needs the LAST page; `since` bounds it to the window that matters instead.
        const since = new Date(Date.now() - (DIGEST_MAX_AGE_DAYS + 1) * 864e5).toISOString();
        const comments = await get(`/repos/${repo}/issues/${DIGEST_ITEM}/comments?since=${encodeURIComponent(since)}`);
        const stale = digestStaleness(item, comments);
        report.push(`health digest (item #${DIGEST_ITEM}): ${stale ? 'STALE' : item.state === 'open' ? 'fresh' : `item is ${item.state} — not expected`}`);
        if (stale) failures.push(stale);
      } catch (err) {
        failures.push(`could not read item #${DIGEST_ITEM} to check the health digest's age: ${err.message}`);
      }
    }
  }

  console.log('── Renovate run verdict ──');
  for (const r of report) console.log(`  ${r}`);
  if (failures.length) {
    console.error(`✗ ${failures.length} problem(s):`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    return 1;
  }
  console.log('✓ the run did what it was scheduled to do');
  return 0;
}

// ── The argument contract (item #500) ────────────────────────────────────────────────────────────

export const USAGE = `renovate-verdict.mjs — what a Renovate run actually did (items #1125, #1124, #1123).

  node scripts/renovate-verdict.mjs preflight               probe RENOVATE_TOKEN's read scopes before the run
  node scripts/renovate-verdict.mjs verdict --log <file>    judge the run from Renovate's JSON log file
  node scripts/renovate-verdict.mjs --help                  this text

Both are read-only. .forgejo/workflows/renovate.yml runs them around the Renovate step.`;

/** @returns {{command: 'help'|'preflight'|'verdict', log?: string}} @throws {ArgvError} */
export function resolveCommand(argv = []) {
  const args = (argv ?? []).filter((a) => a !== '');
  if (wantsHelp(args)) return { command: 'help' };
  const { positionals, values } = partitionArgsWithValues(args, { withValues: ['--log'], maxPositionals: 1, usage: USAGE });
  const [command] = positionals;
  if (command === 'preflight') {
    if (values.has('--log')) throw new ArgvError(`--log applies to verdict only\n\n${USAGE}`);
    return { command };
  }
  if (command === 'verdict') {
    const log = values.get('--log');
    if (!log) throw new ArgvError(`verdict needs --log <file>\n\n${USAGE}`);
    return { command, log };
  }
  throw new ArgvError(`expected 'preflight' or 'verdict', got ${command === undefined ? 'nothing' : `'${command}'`}\n\n${USAGE}`);
}

if (isMain(import.meta.url)) {
  let cmd;
  try {
    cmd = resolveCommand(process.argv.slice(2));
  } catch (err) {
    dieOnArgvError(err);
  }
  if (cmd.command === 'help') console.log(USAGE);
  else {
    (cmd.command === 'preflight' ? runPreflight() : runVerdict(cmd.log))
      .then((code) => {
        process.exitCode = code;
      })
      .catch((err) => {
        console.error(`[renovate-verdict] FAILED: ${err.message}`);
        process.exitCode = 1;
      });
  }
}
