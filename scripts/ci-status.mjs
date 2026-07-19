#!/usr/bin/env node
// Self-serve CI status + failure diagnosis (feature 042, US1).
//
// The forge API exposes NO log, artifact, or per-run-jobs endpoint (measured — swagger.v1.json
// confirms the absence is by design in this build). This script therefore reads what IS exposed:
// run state, commit statuses, and — once the write side lands — the digest published into a PR
// comment or commit status.
//
// Three measured constraints shape every request (2026-07-19, dev container → homelab forge over a
// ~135 KB/s tailnet link). They are correctness rules, not optimizations:
//
//   * `?head_sha=<full-sha>` is a true server-side filter: 0.48 s / 15 KB. Unfiltered: 94 s / 12.4 MB.
//   * `?limit=N` ALONE is silently ignored. It is honoured only alongside `page`.
//   * `?status=`, `?event=`, `?branch=` are silently ignored — filter client-side instead.
//
// Auth is the dedicated READ-ONLY token in MCM_FORGE_TOKEN (read:repository + read:issue +
// read:package), delivered via the devcontainer ${localEnv} passthrough. It is deliberately NOT the
// credential `git credential fill` returns: that one is write-capable yet repository-scoped only
// (403 on issues/{n}/comments, 401 reqPackageAccess on packages), so it cannot read a digest or a
// bundle. Read from env ONLY, never argv (scripts/check-no-argv-secrets.mjs enforces that).
//
// Authoritative tests: scripts/__tests__/ci-status.test.mjs (CI-enforced by the guardrails/naming
// `node --test scripts/__tests__/*.test.mjs` step, feature 041).

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

import { redactForPublication } from './ci-digest-redact.mjs';

/** Endpoint-family → the token scope it requires. Used to turn a bare 401/403 into a remedy. */
const SCOPE_BY_ENDPOINT = [
  [/\/issues\/\d+\/comments/, 'read:issue'],
  [/\/issues\//, 'read:issue'],
  [/\/packages\//, 'read:package'],
  [/\/actions\/|\/commits\/|\/statuses\/|\/pulls/, 'read:repository'],
];

export class CiStatusError extends Error {}

/** A short sha silently matches nothing upstream, which reads as "no CI ran". Reject it loudly. */
export function assertFullSha(sha) {
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/i.test(sha)) {
    throw new CiStatusError(
      `\`${sha}\` is not a full 40-character commit sha. The forge's head_sha filter is exact-match, ` +
        'so an abbreviated sha returns zero runs and looks like "no CI ran". Use `git rev-parse <ref>`.',
    );
  }
  return sha;
}

/**
 * Build a runs query that the forge will actually honour.
 * Filters the API silently ignores (status/event/branch) are accepted but deliberately NOT emitted —
 * callers apply them client-side after the fetch.
 */
export function buildRunsQuery({ sha, page, limit } = {}) {
  const q = new URLSearchParams();
  if (sha) {
    q.set('head_sha', assertFullSha(sha));
    return q;
  }
  // `limit` without `page` is silently dropped upstream and returns the full 12.4 MB listing, so a
  // page is always emitted alongside it.
  q.set('page', String(page ?? 1));
  q.set('limit', String(limit ?? 30));
  return q;
}

/** Read the token from env. No fallback literal — an unset credential must fail, never degrade. */
export function requireToken(env = process.env) {
  const token = env.MCM_FORGE_TOKEN;
  if (!token) {
    throw new CiStatusError(
      'MCM_FORGE_TOKEN is not set. It is the dedicated read-only forge token ' +
        '(read:repository + read:issue + read:package), passed into the dev container from the host ' +
        'via ${localEnv}. Set it on the host with `setx MCM_FORGE_TOKEN …`, then FULLY QUIT VS Code ' +
        '(setx only affects newly-launched processes; a reload is not enough) and rebuild.',
    );
  }
  return token;
}

/**
 * Turn a bare 401/403 into a message naming the scope that is missing.
 * A bare status code is indistinguishable from an expired credential and cost this design a full
 * revision cycle to diagnose — never surface one on its own.
 */
export function describeAuthFailure(status, endpoint) {
  const hit = SCOPE_BY_ENDPOINT.find(([re]) => re.test(endpoint));
  const scope = hit ? hit[1] : 'read:repository';
  return (
    `Forge returned ${status} for ${endpoint} — the token is missing the \`${scope}\` scope. ` +
    'This is granular scope, not expiry: the same token can return 200 on other endpoints in the ' +
    'same second. Mint a token with read:repository + read:issue + read:package and set it as ' +
    'MCM_FORGE_TOKEN.'
  );
}

/** Write a raw payload to disk and return its path. Raw payloads must never reach stdout (FR-016). */
export function cacheRawPayload(dir, name, text) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.json`);
  writeFileSync(path, text);
  return path;
}

// --- Check state classification -----------------------------------------------------------------
//
// Two of the five states are reported WRONG by the raw API and must be derived, never read directly:
//
//   skipped     A path-gated job settles to `success` with description "Skipped". Counting it as
//               pending makes a green PR look blocked forever. Fails SAFE (an unnecessary wait).
//   superseded  A cancelled run's contexts report status="failure" for a commit that was never
//               broken — measured 13/16 on a real superseded commit. Fails LOUD (it announces a
//               broken build that isn't), so it is the worse of the two. The tell: every job dies
//               together on a change that could not have affected them all.

const CANCELLED_DESCRIPTION = 'Has been cancelled';

/** Split `app-ci / app-e2e (pull_request)` into its job and event halves. */
export function parseContext(context) {
  const m = String(context).match(/^(.*?)\s*\((push|pull_request|workflow_dispatch|schedule)\)\s*$/);
  return m ? { job: m[1], event: m[2] } : { job: String(context).trim(), event: null };
}

/**
 * Find the run that produced a context, matching on BOTH workflow file and event — the same job
 * appears once per event and the two can disagree, so matching on workflow alone picks the wrong run.
 */
export function findRunForContext(context, runs = []) {
  const { job, event } = parseContext(context);
  const workflow = job.split('/')[0].trim();
  return (
    runs.find(
      (r) => r.workflow_id === `${workflow}.yml` && (event === null || r.event === event),
    ) ?? null
  );
}

/**
 * Classify one commit status into a `CheckState`.
 * @param {{status: string, description?: string}} status
 * @param {{status?: string}|null} [run] the owning run, when available
 * @returns {'passed'|'failed'|'skipped'|'waiting'|'superseded'}
 */
export function classifyCheckState(status, run = null) {
  const description = status.description ?? '';

  // Cancelled FIRST: these arrive as status="failure" and would otherwise classify as failed.
  // Two independent signals — the description is direct but is a UI string that could be reworded;
  // the run's own status is structural but depends on the context→run match being right. Either
  // alone suffices, so a wording change cannot silently turn superseded back into failed.
  if (description === CANCELLED_DESCRIPTION || run?.status === 'cancelled') return 'superseded';

  if (status.status === 'pending') return 'waiting';
  if (status.status === 'success') return /^skipped/i.test(description) ? 'skipped' : 'passed';
  return 'failed';
}

// --- Merge verdict ------------------------------------------------------------------------------

/**
 * Branch-protection required contexts. `trigger-cd` and `dast` are deliberately absent — they are
 * not required, so their failures are advisory (FR-011a/b).
 */
export const REQUIRED_CONTEXT_GLOBS = [
  'guardrails*',
  'app-ci / changes*',
  'app-ci / affected*',
  'app-ci / mc-service-checks*',
  'app-ci / app-e2e*',
];

const globToRegExp = (glob) =>
  new RegExp('^' + glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');

/**
 * Keep only the contexts belonging to one event.
 *
 * THE EVENT-SUFFIX RULE (measured 2026-07-19): a job produces one context PER EVENT, and the two
 * can disagree — on a real superseded commit `guardrails / secret-scan` was push=success but
 * pull_request=failure. A glob like `guardrails*` matches both, so a verdict that does not select
 * an event reports failure for a commit whose push run was entirely green.
 */
export function selectEventContexts(statuses, event) {
  const matching = statuses.filter((s) => parseContext(s.context).event === event);
  // Contexts with no event suffix belong to whichever event is being resolved.
  const unsuffixed = statuses.filter((s) => parseContext(s.context).event === null);
  return [...matching, ...unsuffixed];
}

/** Infer which event to resolve when the caller did not say: a PR's own contexts win if present. */
function inferEvent(statuses) {
  return statuses.some((s) => parseContext(s.context).event === 'pull_request') ? 'pull_request' : 'push';
}

/**
 * Roll up commit statuses into the signal that actually gates merging.
 * Computed over REQUIRED contexts only — "no job failed" is a different, weaker question.
 *
 * @returns {{mergeable: boolean, blocking: object[], waiting: object[], advisory: object[],
 *            superseded: object[], required: object[], all: object[]}}
 */
export function computeMergeVerdict(statuses, { requiredGlobs = REQUIRED_CONTEXT_GLOBS, event, runs = [] } = {}) {
  const chosenEvent = event ?? inferEvent(statuses);
  const patterns = requiredGlobs.map(globToRegExp);

  const checks = selectEventContexts(statuses, chosenEvent).map((s) => {
    const { job } = parseContext(s.context);
    return {
      context: s.context,
      job,
      description: s.description ?? '',
      state: classifyCheckState(s, findRunForContext(s.context, runs)),
      // The glob is matched against the job with its event suffix stripped.
      required: patterns.some((re) => re.test(job)),
    };
  });

  const required = checks.filter((c) => c.required);
  const blocking = required.filter((c) => c.state === 'failed');
  const waiting = required.filter((c) => c.state === 'waiting');
  const superseded = checks.filter((c) => c.state === 'superseded');
  const advisory = checks.filter((c) => !c.required && c.state === 'failed');

  // A required context that produced no status at all does not hold the verdict hostage — a
  // zero-match glob is treated as satisfied, mirroring branch protection.
  const mergeable = required.every((c) => c.state === 'passed' || c.state === 'skipped');

  return { mergeable, blocking, waiting, advisory, superseded, required, all: checks, event: chosenEvent };
}

// --- Transport ------------------------------------------------------------------------------------

/** Repo slug + API base, derived from the origin remote. The host is NEVER printed (FR-017). */
function forgeEndpoint() {
  const origin = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  const m = origin.replace(/\.git$/, '').match(/^(https?:\/\/[^/]+)\/([^/]+)\/([^/]+)$/);
  if (!m) throw new CiStatusError(`could not parse the origin remote into a forge API base`);
  return { base: `${m[1]}/api/v1`, owner: m[2], repo: m[3] };
}

async function forgeGet(pathAndQuery, { token, base }) {
  const res = await fetch(`${base}${pathAndQuery}`, { headers: { Authorization: `token ${token}` } });
  if (res.status === 401 || res.status === 403) throw new CiStatusError(describeAuthFailure(res.status, pathAndQuery));
  if (!res.ok) throw new CiStatusError(`Forge returned ${res.status} for ${pathAndQuery}`);
  return { text: await res.text() };
}

const CACHE_DIR = process.env.CI_STATUS_CACHE_DIR ?? join(tmpdir(), 'mcm-ci-status');

/** Fetch, cache the raw payload to disk, return the parsed object. Raw text never reaches stdout. */
async function fetchCached(pathAndQuery, conn, cacheName) {
  const { text } = await forgeGet(pathAndQuery, conn);
  const path = cacheRawPayload(CACHE_DIR, cacheName, text);
  return { data: JSON.parse(text), path };
}

// --- Ref resolution -------------------------------------------------------------------------------

async function resolveSha({ sha, pr, branch }, conn) {
  if (sha) return { sha: assertFullSha(sha), pr: null };
  if (pr) {
    const { data } = await fetchCached(`/repos/${conn.owner}/${conn.repo}/pulls/${pr}`, conn, `pull-${pr}`);
    return { sha: assertFullSha(data.head?.sha), pr: Number(pr) };
  }
  const ref = branch ?? 'HEAD';
  return { sha: execFileSync('git', ['rev-parse', ref], { encoding: 'utf8' }).trim(), pr: null };
}

// --- Rendering ------------------------------------------------------------------------------------

const SYMBOL = { passed: '✓', failed: '✗', skipped: '○', waiting: '⏳', superseded: '➖' };
const ANNOTATION = {
  skipped: '(path-gated → satisfied)',
  waiting: '(queued or running)',
  superseded: '(newer push — not a failure)',
};

/** Every emitted line goes through redaction, so the forge host is `<forge>` by construction. */
const emit = (line) => console.log(redactForPublication(line));

function renderVerdict(verdict, { sha, pr, cachePaths }) {
  const width = Math.max(...verdict.all.map((c) => c.job.length), 20);
  emit('');
  emit(`commit ${sha.slice(0, 8)}${pr ? `  (PR #${pr})` : ''}   [${verdict.event} contexts]`);
  emit('');

  const required = verdict.all.filter((c) => c.required);
  if (required.length) {
    emit('REQUIRED');
    for (const c of required) {
      emit(`  ${SYMBOL[c.state]} ${c.job.padEnd(width)}  ${c.state.padEnd(10)} ${ANNOTATION[c.state] ?? ''}`.trimEnd());
    }
  }

  const nonRequired = verdict.all.filter((c) => !c.required);
  if (nonRequired.length) {
    emit('');
    emit('ADVISORY (non-blocking)');
    for (const c of nonRequired) {
      emit(`  ${SYMBOL[c.state]} ${c.job.padEnd(width)}  ${c.state.padEnd(10)} ${ANNOTATION[c.state] ?? ''}`.trimEnd());
    }
  }

  emit('');
  emit(`VERDICT  ${verdictLine(verdict)}`);
  emit(`         raw payload cached: ${cachePaths.join(', ')}`);
  emit('');
}

function verdictLine(v) {
  if (v.superseded.length && !v.blocking.length && !v.waiting.length) {
    return `superseded — this run was cancelled by a newer push (${v.superseded.length} context(s)). Not a failure.`;
  }
  if (v.blocking.length) return `NOT mergeable — ${v.blocking.length} required context(s) failed`;
  if (v.waiting.length) return `not yet mergeable — ${v.waiting.length} required context(s) still waiting`;
  const advisory = v.advisory.length ? `; ${v.advisory.length} advisory failure(s) — not blocking` : '';
  return `mergeable — all required contexts satisfied${advisory}`;
}

// --- Subcommands ----------------------------------------------------------------------------------

/** Exit codes: 0 mergeable · 1 required failure · 2 bad args/auth · 3 still waiting at timeout. */
const EXIT = { OK: 0, FAILED: 1, USAGE: 2, WAITING: 3 };

async function loadVerdict(target, conn) {
  const { sha, pr } = await resolveSha(target, conn);
  const statuses = await fetchCached(
    `/repos/${conn.owner}/${conn.repo}/commits/${sha}/status`, conn, `status-${sha.slice(0, 8)}`,
  );
  // head_sha is a true server-side filter — 0.48 s / 15 KB vs 94 s / 12.4 MB unfiltered.
  const runs = await fetchCached(
    `/repos/${conn.owner}/${conn.repo}/actions/runs?${buildRunsQuery({ sha })}`, conn, `runs-${sha.slice(0, 8)}`,
  );
  const verdict = computeMergeVerdict(statuses.data.statuses ?? [], {
    event: target.pr ? 'pull_request' : undefined,
    runs: runs.data.workflow_runs ?? [],
  });
  return { verdict, sha, pr, cachePaths: [statuses.path, runs.path] };
}

function exitCodeFor(verdict) {
  if (verdict.blocking.length) return EXIT.FAILED;
  if (verdict.waiting.length) return EXIT.WAITING;
  return EXIT.OK;
}

async function cmdStatus(target, conn) {
  const { verdict, sha, pr, cachePaths } = await loadVerdict(target, conn);
  renderVerdict(verdict, { sha, pr, cachePaths });
  return exitCodeFor(verdict);
}

async function cmdWatch(target, conn, { timeoutSeconds, intervalSeconds }) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    const { verdict, sha, pr, cachePaths } = await loadVerdict(target, conn);
    if (!verdict.waiting.length) {
      renderVerdict(verdict, { sha, pr, cachePaths });
      return exitCodeFor(verdict);
    }
    if (Date.now() >= deadline) {
      renderVerdict(verdict, { sha, pr, cachePaths });
      // Exit 3, NOT 1. Under a saturated capacity-1 runner, pending is starvation — a poller that
      // fails on it reports a queue as a broken build.
      emit(`still waiting after ${timeoutSeconds}s — runner starvation, not failure (exit ${EXIT.WAITING}).`);
      return EXIT.WAITING;
    }
    emit(`waiting on ${verdict.waiting.map((c) => c.job).join(', ')} — re-checking in ${intervalSeconds}s`);
    await new Promise((r) => setTimeout(r, intervalSeconds * 1000));
  }
}

/** Thin smoke check. The authoritative suite is scripts/__tests__/ci-status.test.mjs. */
function selftest() {
  const failures = [];
  const cancelled = { status: 'failure', description: 'Has been cancelled', context: 'app-ci / app-e2e (pull_request)' };
  if (classifyCheckState(cancelled) !== 'superseded') failures.push('cancelled context not classified as superseded');
  if (classifyCheckState({ status: 'success', description: 'Skipped' }) !== 'skipped') failures.push('skip not satisfied');
  if (!redactForPublication('http://box.tailz9x8w7.ts.net:3000/x').includes('<forge>')) failures.push('host not redacted');
  try { assertFullSha('c2c3c29'); failures.push('an abbreviated sha was accepted'); } catch { /* expected */ }

  if (failures.length) {
    console.error('✗ [ci-status --selftest] FAILED:\n  - ' + failures.join('\n  - '));
    process.exit(1);
  }
  console.log('✓ [ci-status --selftest] traps classified, host redacted, short sha rejected.');
}

const USAGE = `Usage:
  node scripts/ci-status.mjs status [--sha <full-sha> | --pr <n> | --branch <name>]
  node scripts/ci-status.mjs watch  [--sha … | --pr … | --branch …] [--timeout <seconds>]
  node scripts/ci-status.mjs --selftest

Exit: 0 mergeable · 1 required context failed · 2 bad args/auth · 3 still waiting (NOT a failure).`;

async function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  const command = argv[0];
  if (!command || command.startsWith('-')) { console.error(USAGE); return EXIT.USAGE; }

  const target = {};
  let timeoutSeconds = 45 * 60;
  let intervalSeconds = Number(process.env.CI_STATUS_POLL_SECONDS ?? 30);
  for (let i = 1; i < argv.length; i++) {
    const next = () => argv[++i];
    if (argv[i] === '--sha') target.sha = next();
    else if (argv[i] === '--pr') target.pr = next();
    else if (argv[i] === '--branch') target.branch = next();
    else if (argv[i] === '--timeout') timeoutSeconds = Number(next());
    else { console.error(`Unknown argument: ${argv[i]}\n\n${USAGE}`); return EXIT.USAGE; }
  }

  const conn = { ...forgeEndpoint(), token: requireToken() };
  if (command === 'status') return cmdStatus(target, conn);
  if (command === 'watch') return cmdWatch(target, conn, { timeoutSeconds, intervalSeconds });
  if (command === 'failure') { console.error('`failure` lands with the write side (T026).'); return EXIT.USAGE; }
  console.error(`Unknown command: ${command}\n\n${USAGE}`);
  return EXIT.USAGE;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      // Redact before printing: an error message can carry a URL, and therefore the forge host.
      console.error(`✗ ${redactForPublication(err instanceof CiStatusError ? err.message : String(err?.stack ?? err))}`);
      process.exit(EXIT.USAGE);
    });
}
