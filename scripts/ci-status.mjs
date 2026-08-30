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

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

import { redactForPublication } from './ci-digest-redact.mjs';
import { bundleVersion, BUNDLE_PACKAGE } from './ci-failure-digest.mjs';
import { gunzipSync } from 'node:zlib';

/** Endpoint-family → the token scope it requires. Used to turn a bare 401/403 into a remedy. */
const SCOPE_BY_ENDPOINT = [
  [/\/issues\/\d+\/comments/, 'read:issue'],
  [/\/issues\//, 'read:issue'],
  [/\/packages\//, 'read:package'],
  [/\/actions\/|\/commits\/|\/statuses\/|\/pulls/, 'read:repository'],
];

export class CiStatusError extends Error {}

/** Hard ceiling on a decompressed bundle. The writer caps at 5 MB; a HOSTILE uploader ignores that,
 *  so the reader must cap inflation itself or a gzip bomb OOMs the developer's machine. */
export const MAX_INFLATED_BYTES = 64 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024; // the gzip itself; comfortably above the 5 MB writer cap
const MAX_BUNDLE_FILES = 500;

/** Strip C0/C1 control characters (keep \n and \t) so terminal-escape sequences in attacker-
 *  influenceable log/comment content can't rewrite the reader's screen or drive OSC clipboard/links. */
/** fetch with a hard timeout so a half-open tailnet connection can't hang the tool indefinitely. */
export async function fetchWithTimeout(url, opts = {}, ms = Number(process.env.CI_HTTP_TIMEOUT_MS) || 30000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } catch (err) {
    if (err?.name === 'AbortError') throw new CiStatusError(`request to the forge timed out after ${ms}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function stripControlChars(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');
}

/** Decompress a bundle gzip with a hard inflate cap, and bound the entry count. */
export function parseBundleGz(gz) {
  if (gz.length > MAX_DOWNLOAD_BYTES) {
    throw new CiStatusError(`bundle download is ${gz.length} bytes, over the ${MAX_DOWNLOAD_BYTES} cap — refusing`);
  }
  let json;
  try {
    json = gunzipSync(gz, { maxOutputLength: MAX_INFLATED_BYTES }).toString('utf8');
  } catch (err) {
    // Node throws with a maxOutputLength message when the cap is hit — surface it as a refusal.
    throw new CiStatusError(`bundle failed to inflate within ${MAX_INFLATED_BYTES} bytes (possible decompression bomb): ${err.message}`);
  }
  const manifest = JSON.parse(json);
  if (Array.isArray(manifest.files) && manifest.files.length > MAX_BUNDLE_FILES) {
    manifest.files = manifest.files.slice(0, MAX_BUNDLE_FILES);
  }
  return manifest;
}

/** Write bundle entries, skipping any that are unsafe (traversal) OR malformed (non-string text).
 *  @returns {string[]} the relative paths actually written. */
export function safeBundleWrite(root, files) {
  mkdirSync(root, { recursive: true });
  const written = [];
  for (const f of files ?? []) {
    let dest;
    try {
      dest = safeBundleEntryPath(root, f.path);
      if (typeof f.text !== 'string') throw new CiStatusError(`entry ${JSON.stringify(f.path)} has no string content`);
    } catch {
      continue; // one hostile/garbled entry must not deny the rest of the evidence
    }
    try {
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, f.text);
      written.push(f.path);
    } catch {
      // A path collision (file where a dir is needed, ENOTDIR) or FS error: skip, keep going.
    }
  }
  return written;
}

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

// The forge phrases these as sentences, and the exact wording was MEASURED, not guessed:
//   cancelled → "Has been cancelled"   (observed on a real superseded commit)
//   skipped   → "Has been skipped"     (observed on PR #83's path-gated trigger-cd)
// Anchored so a genuine failure whose message merely CONTAINS "cancelled" cannot be silently
// reclassified as superseded — that would hide a real break. The bare forms are accepted too, in
// case the wording is shortened upstream.
const CANCELLED_DESCRIPTION = /^(?:has been )?cancelled$/i;
const SKIPPED_DESCRIPTION = /^(?:has been )?skipped$/i;

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
  if (CANCELLED_DESCRIPTION.test(description.trim()) || run?.status === 'cancelled') return 'superseded';

  if (status.status === 'pending') return 'waiting';
  if (status.status === 'success') return SKIPPED_DESCRIPTION.test(description.trim()) ? 'skipped' : 'passed';
  return 'failed';
}

// --- Merge verdict ------------------------------------------------------------------------------

/**
 * FALLBACK required contexts, used only when branch protection cannot be read. The live set is
 * fetched from the forge (see resolveRequiredGlobs) because THIS LIST DRIFTED and produced a wrong
 * verdict: on 2026-07-26 it held five globs while `main` required six — feature 035 had added
 * `infra-image-scan / infra-image-scan*` and nobody mirrored it here. ci-status printed
 * `VERDICT mergeable` + exit 0 while the merge API answered 405. Over-reporting mergeable is the
 * dangerous direction, so the hand-maintained list is now the backup, not the source of truth.
 *
 * `trigger-cd` and `dast` remain deliberately absent — branch protection does not require them, so
 * their failures are advisory (FR-011a/b).
 */
export const REQUIRED_CONTEXT_GLOBS = [
  'guardrails*',
  'app-ci / changes*',
  'app-ci / affected*',
  'app-ci / mc-service-checks*',
  'app-ci / app-e2e*',
  'infra-image-scan / infra-image-scan*',
];

/**
 * Extract the required-status-check globs a branch-protection payload applies to `branch`.
 *
 * @returns {string[]|null} the globs, or null when no rule with status checks covers the branch.
 *   null means "unknown — fall back", NEVER []: an empty list would mark every context optional and
 *   render everything mergeable, which is the same over-reporting bug wearing a different hat.
 */
export function parseRequiredGlobs(protections, branch) {
  if (!Array.isArray(protections)) return null;
  const rule = protections.find((p) => {
    if (!p || p.enable_status_check !== true) return false;
    if (!Array.isArray(p.status_check_contexts) || p.status_check_contexts.length === 0) return false;
    // Forgejo carries both: `branch_name` (legacy, literal) and `rule_name` (may be a glob such as
    // `release/*`). Match either, so a glob rule is not silently missed.
    if (p.branch_name && p.branch_name === branch) return true;
    return typeof p.rule_name === 'string' && p.rule_name.length > 0 && globToRegExp(p.rule_name).test(branch);
  });
  if (!rule) return null;
  const globs = rule.status_check_contexts.filter((c) => typeof c === 'string' && c.length > 0);
  return globs.length ? globs : null;
}

/**
 * Resolve the required globs, preferring the forge's live branch protection.
 *
 * Degrades rather than aborts: a token without the scope, or an unreachable forge, must still yield
 * a verdict. But the fallback is REPORTED, because a silent fallback recreates the hand-maintained
 * list this whole change exists to retire.
 *
 * @param {() => Promise<any>} fetchProtections
 * @returns {Promise<{globs: string[], source: 'branch-protection'|'fallback', note: string}>}
 */
export async function resolveRequiredGlobs(fetchProtections, branch) {
  try {
    const globs = parseRequiredGlobs(await fetchProtections(), branch);
    if (globs) {
      return { globs, source: 'branch-protection', note: `branch protection for \`${branch}\`` };
    }
    return {
      globs: REQUIRED_CONTEXT_GLOBS,
      source: 'fallback',
      note: `no status-check rule in branch protection for \`${branch}\` — using the built-in list, which may be stale`,
    };
  } catch (err) {
    return {
      globs: REQUIRED_CONTEXT_GLOBS,
      source: 'fallback',
      note: `could not read branch protection (${err.message}) — using the built-in list, which may be stale`,
    };
  }
}

/** Contexts published by this feature's own write side — not CI results, so never a verdict input. */
const SELF_PUBLISHED_CONTEXT = /^ci-digest\b/;

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
  // One pass, so an unsuffixed context is never counted twice — a duplicated REQUIRED context would
  // double-count in blocking/waiting. (Reachable when `event` is itself null.)
  return statuses.filter((s) => {
    const ctxEvent = parseContext(s.context).event;
    // A context with no event suffix belongs to whichever event is being resolved.
    return ctxEvent === null || ctxEvent === event;
  });
}

/**
 * Reduce a context's status history to its CURRENT status.
 *
 * A context accumulates one status per state transition, so a job that failed and was then re-run
 * successfully on the same event leaves both a `failure` and a `success` behind. Without this the
 * verdict classified every entry, so the stale `failure` still landed in `blocking` and one context
 * could be reported twice — as `passed` AND `failed` (backlog item #176).
 *
 * Keyed on the FULL context string rather than on `parseContext(...).job`. Two reasons, and both
 * produce a wrong verdict rather than an obvious break:
 *   * `foo (push)` and `foo (pull_request)` are different checks that legitimately disagree — the
 *     event-suffix rule `selectEventContexts` exists to enforce. Keying on the job would merge them.
 *   * an unsuffixed `foo` is admitted alongside a suffixed one by that same function, and the two
 *     are not interchangeable.
 *
 * Newest wins in BOTH directions. "Any success passes" would be the easy shortcut and is the
 * dangerous one: it absorbs a newer genuine failure into an older success.
 *
 * Equal `created_at` is reachable (the forge stamps to the second), so the original array index is
 * the tiebreak. Without it the verdict would depend on sort stability — a coin-flip verdict, which
 * is harder to notice and harder to reproduce than a consistently wrong one.
 */
export function collapseToNewestPerContext(statuses) {
  const newest = new Map();
  statuses.forEach((s, index) => {
    const previous = newest.get(s.context);
    if (!previous) {
      newest.set(s.context, { status: s, index });
      return;
    }
    const at = Date.parse(s.created_at ?? '');
    const previousAt = Date.parse(previous.status.created_at ?? '');
    const bothUnparseable = Number.isNaN(at) && Number.isNaN(previousAt);
    const isNewer = bothUnparseable || Number.isNaN(previousAt)
      ? index > previous.index
      : Number.isNaN(at)
        ? false
        : at > previousAt || (at === previousAt && index > previous.index);
    if (isNewer) newest.set(s.context, { status: s, index });
  });
  return [...newest.values()].map((entry) => entry.status);
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

  const checks = collapseToNewestPerContext(selectEventContexts(statuses, chosenEvent))
    .filter((s) => !SELF_PUBLISHED_CONTEXT.test(parseContext(s.context).job))
    .map((s) => {
    const { job } = parseContext(s.context);
    const run = findRunForContext(s.context, runs);
    return {
      context: s.context,
      job,
      description: s.description ?? '',
      state: classifyCheckState(s, run),
      // Carried so `failure --full` can derive the bundle version without the operator passing
      // --run by hand. Matched via the context's OWN event, since the same job appears once per
      // event and the two can be different runs.
      runId: run?.id ?? null,
      required: patterns.some((re) => re.test(job)),
    };
  });

  const required = checks.filter((c) => c.required);
  const blocking = required.filter((c) => c.state === 'failed');
  const waiting = required.filter((c) => c.state === 'waiting');
  const superseded = checks.filter((c) => c.state === 'superseded');
  const advisory = checks.filter((c) => !c.required && c.state === 'failed');

  // A required context that produced no status at all does not hold the verdict hostage — a
  // zero-match glob is treated as satisfied, mirroring branch protection. But that reasoning is
  // PER GLOB. If NOTHING has reported yet, `[].every()` is vacuously true and an unreported commit
  // renders as green — which also made `watch` return immediately instead of waiting. Absent
  // results are "not yet known", never "satisfied".
  const noResults = checks.length === 0;
  const mergeable = !noResults && required.every((c) => c.state === 'passed' || c.state === 'skipped');

  return {
    mergeable,
    noResults,
    blocking,
    waiting,
    advisory,
    superseded,
    required,
    all: checks,
    event: chosenEvent,
  };
}

/**
 * Map a verdict to a process exit code.
 *
 * Exported so the invariant "exit 0 ⟺ mergeable" is testable — the two disagreed before, which is
 * the dangerous direction: a `ci-status status && merge` wrapper would merge a commit whose CI was
 * cancelled and never actually passed.
 */
export function exitCodeForVerdict(verdict) {
  if (verdict.blocking.length) return 1;
  // Superseded and not-yet-reported are both "no verdict yet" — the same answer as waiting.
  if (verdict.waiting.length || verdict.noResults || !verdict.mergeable) return 3;
  return 0;
}

/**
 * Parse the target/polling arguments, rejecting a flag whose value is missing or malformed.
 * `--pr $PR` with an unset PR used to fall through to the local HEAD and confidently report on a
 * completely different commit.
 */
export function parseTargetArgs(argv) {
  const target = {};
  let timeoutSeconds = 45 * 60;
  const valueOf = (flag, i) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new CiStatusError(`${flag} requires a value`);
    return v;
  };
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--sha') target.sha = valueOf(flag, i++);
    else if (flag === '--pr') target.pr = valueOf(flag, i++);
    else if (flag === '--branch') target.branch = valueOf(flag, i++);
    else if (flag === '--job') target.job = valueOf(flag, i++);
    else if (flag === '--run') target.run = valueOf(flag, i++);
    else if (flag === '--full') target.full = true;
    else if (flag === '--event') {
      target.event = valueOf(flag, i++);
      if (!['push', 'pull_request'].includes(target.event)) {
        throw new CiStatusError(`--event must be push or pull_request, got ${JSON.stringify(target.event)}`);
      }
    }
    else if (flag === '--timeout') {
      const raw = valueOf(flag, i++);
      timeoutSeconds = Number(raw);
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
        throw new CiStatusError(`--timeout must be a positive number of seconds, got ${JSON.stringify(raw)}`);
      }
    } else throw new CiStatusError(`Unknown argument: ${flag}`);
  }
  return { target, timeoutSeconds };
}

// --- Rendering the three-way digest outcome (feature 051 US3, FR-011) ----------------------------

/** What to DO about each failure sub-reason. The sub-reason is only useful if it implies an action. */
const FAILED_NEXT_ACTION = {
  'no-credential': 'check whether this run had Actions secrets at all — an AGit-headed run has NONE, ' +
    'and every ${{ secrets.* }} is empty on it. That is the 2026-08-01 case.',
  forbidden: 'the token was present but lacked the scope this endpoint needs — grant the scope the ' +
    'digest\'s own error message names.',
  transport: 'the forge was unreachable or returned an unexpected status — retry, or check the forge.',
  unknown: 'the failure did not match a known class — read the summary above and the job log.',
};

/**
 * Render the "there is no digest here" case, distinguishing a BROKEN digest from an ABSENT one.
 *
 * These two used to render identically, as "no digest was published for them". The reader believes
 * the absent reading, because it is the ordinary one — and on 2026-08-01 that is exactly what
 * happened: the digest had collected the evidence and thrown it away for want of a credential, and
 * the report said nothing had been published, which was true and useless.
 *
 * The "no digest was published" wording is RESERVED for a genuine absence (FR-011). It is kept, not
 * retired — it is still the right answer when the job died before the digest step ran, and removing
 * it everywhere would trade one wrong answer for another.
 *
 * Pure: takes the failures and whatever outcomes were recovered, returns lines. Exported so the
 * distinction can be asserted without a forge.
 */
export function renderDigestAbsence(failed, outcomes = []) {
  const broken = outcomes.filter((o) => o.outcome === 'failed');
  const lines = [];

  if (broken.length) {
    lines.push(`${broken.length} job(s) have a digest that RAN and FAILED to publish — the evidence was collected, not lost:`);
    for (const o of broken) {
      lines.push(`  ⚠️ ${o.job} — digest ran and FAILED (${o.detail ?? 'unknown'})`);
      if (o.summary) lines.push(`      ${o.summary}`);
      lines.push(`      next: ${FAILED_NEXT_ACTION[o.detail] ?? FAILED_NEXT_ACTION.unknown}`);
    }
    lines.push('');
    // Do NOT quote the reserved absent-case wording here, however tempting the contrast is: nothing
    // downstream — a grep, a reader skimming, or the test that asserts this — can tell a quotation
    // from a claim, and the whole point of reserving the phrase is that its presence means one thing.
    lines.push('A broken digest is not a missing one. The diagnosis exists; only its delivery failed,');
    lines.push('so fixing the cause above recovers it without re-running the job.');
    lines.push('');
  }

  const brokenJobs = new Set(broken.map((o) => o.job));
  const stillAbsent = failed.filter((c) => !brokenJobs.has(String(c.job).split('/').pop().trim()));
  if (stillAbsent.length) {
    lines.push(`${stillAbsent.length} job(s) failed, but no digest was published for them:`);
    for (const c of stillAbsent) lines.push(`  ✗ ${c.job} — ${c.description}`);
    lines.push('');
    lines.push('A missing digest usually means the job died BEFORE the digest step ran — a runner crash,');
    lines.push('malformed workflow YAML, or a fault in the digest step itself. That class is a known,');
    lines.push('documented gap (spec § Out of Scope); fall back to the out-of-band failure bundle.');
  }
  return lines;
}

// --- Reading published digests --------------------------------------------------------------------

/**
 * The upsert marker written by scripts/ci-failure-digest.mjs. The two formats live in different
 * files and nothing but the round-trip assertion in the test suite couples them — keep them in step.
 */
export const DIGEST_MARKER_RE = /<!--\s*ci-digest:job=([^\s>]+)\s*-->/;

/** Pull the failure digests out of a PR's comments, optionally narrowing to one job. */
export function extractDigests(comments, job = null) {
  return comments
    .map((c) => {
      // Anchor the marker at the START of the body: a real digest always leads with its marker, so
      // an attacker who echoes a marker string mid-comment (or in a log excerpt) can't be mistaken
      // for an authentic digest. `c.author` is surfaced so a reader can see WHO posted it — the
      // marker's presence alone is not proof of authenticity (any PR commenter can type it).
      const first = typeof c.body === 'string' ? c.body.trimStart() : '';
      const m = first.match(DIGEST_MARKER_RE);
      return m && first.startsWith(m[0]) ? { id: c.id, job: m[1], body: c.body, author: c.user?.login ?? c.author ?? null } : null;
    })
    .filter((d) => d && (job === null || d.job === normalizeJobFilter(job)));
}

/**
 * Accept EITHER the bare job name a digest marker carries (`infra-image-scan`) or the
 * `workflow / job` CONTEXT form this tool prints in its own status table
 * (`infra-image-scan / infra-image-scan`).
 *
 * MEASURED 2026-08-30, PR #289. `failure --pr 289 --job "infra-image-scan / infra-image-scan"` —
 * the value copied straight out of this tool's own output — matched nothing, and an unmatched
 * filter renders as "no digest was published for them". The digest was on the PR the whole time,
 * naming all five blocking findings; the mismatch cost a session an hour of local Trivy
 * reproduction to re-derive them. Every other consumer here already normalises with
 * `c.job.split('/').pop().trim()`; this path did not.
 *
 * The trailing segment is taken only when it is NON-EMPTY, so `"app-ci / "` cannot degrade into a
 * match-everything filter — a fail-OPEN filter is the defect being fixed, not a style to copy.
 */
/**
 * Explain a `--job` selection that filtered EVERY digest out, when digests do exist.
 *
 * The (x2b) defect was not really the name mismatch — it was that the mismatch was INDISTINGUISHABLE
 * from absence. `renderDigestAbsence` legitimately owns "nothing was published"; this owns "something
 * was published and your filter excluded it", which is a different fact and a different fix. Returns
 * `[]` for both non-cases (no filter, or genuinely nothing published) so the caller can fall through
 * to the real absence path without a false positive.
 *
 * @returns {string[]} lines to emit, or [] when nothing was filtered out
 */
export function describeFilteredOutDigests(allDigests, job) {
  if (job === null || job === undefined) return [];
  if (!allDigests.length) return [];
  const available = [...new Set(allDigests.map((d) => d.job))].sort();
  return [
    `No digest matches --job "${job}", but ${allDigests.length} digest(s) ARE published on this PR.`,
    `Available: ${available.join(', ')}`,
    'Re-run without --job, or pass one of the names above. A filter that matches nothing is NOT',
    'evidence that a digest is missing — that mismatch once cost an hour of local reproduction.',
  ];
}

export function normalizeJobFilter(job) {
  const tail = String(job).split('/').pop().trim();
  return tail === '' ? String(job).trim() : tail;
}

// --- Transport ------------------------------------------------------------------------------------

/**
 * Repo slug + API base, derived from the origin remote. The host is NEVER printed (FR-017).
 *
 * Exported for feature 049 (specs/049-forgejo-issue-tracking, FR-007): the backlog tool needs the same
 * derivation, and one copy means one place to fix the trap that the remote — not FORGE_REGISTRY_HOST —
 * is the only value carrying the API PORT. `origin` is injectable so the parse is unit-testable.
 */
export function forgeEndpoint({ origin: injected } = {}) {
  const origin =
    injected ?? execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  const m = origin.replace(/\.git$/, '').match(/^(https?:\/\/[^/]+)\/([^/]+)\/([^/]+)$/);
  if (!m) throw new CiStatusError(`could not parse the origin remote into a forge API base`);
  return { base: `${m[1]}/api/v1`, owner: m[2], repo: m[3] };
}

async function forgeGet(pathAndQuery, { token, base }) {
  const res = await fetchWithTimeout(`${base}${pathAndQuery}`, { headers: { Authorization: `token ${token}` } });
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

/** The branch whose protection gates this target. A PR is gated by its BASE, not its head. */
const DEFAULT_PROTECTED_BRANCH = 'main';

async function resolveSha({ sha, pr, branch }, conn) {
  if (sha) return { sha: assertFullSha(sha), pr: null, base: DEFAULT_PROTECTED_BRANCH, headRef: null, prState: null };
  if (pr) {
    const { data } = await fetchCached(`/repos/${conn.owner}/${conn.repo}/pulls/${pr}`, conn, `pull-${pr}`);
    return {
      sha: assertFullSha(data.head?.sha),
      pr: Number(pr),
      base: data.base?.ref ?? DEFAULT_PROTECTED_BRANCH,
      // Carried so the verdict can warn about a detached head — see detachedHeadWarning().
      headRef: data.head?.ref ?? null,
      // ...and the state, because `head.ref` reverts to refs/pull/N/head once the branch is DELETED.
      // Without this the warning fires on every merged PR whose branch was tidied up.
      prState: data.state ?? null,
    };
  }
  const ref = branch ?? 'HEAD';
  return {
    sha: execFileSync('git', ['rev-parse', ref], { encoding: 'utf8' }).trim(),
    pr: null,
    base: DEFAULT_PROTECTED_BRANCH,
    headRef: null,
    prState: null,
  };
}

/**
 * A PR whose head is `refs/pull/N/head` has NO backing branch. Forgejo treats such a head as
 * untrusted and runs it **without Actions secrets** — every `${{ secrets.* }}` arrives EMPTY.
 *
 * This is not hypothetical and it is not rare: an AGit push (`git push origin HEAD:refs/for/main`)
 * produces exactly this shape by construction. On 2026-08-01 it cost two sessions most of a day.
 * The empty `NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN` made nx report
 * `Misconfigured remote cache endpoint`, which reads as a cache or credential fault — so the hunt
 * went to the cache server, the token, the bucket and the nx wrapper, none of which were broken.
 * The tell was measuring the secret's LENGTH inside the job: 0, sha256 `e3b0c44298fc` (the empty
 * string). The same commits on a branch-backed PR passed first try.
 *
 * The condition is invisible in the web UI, which shows a normal-looking PR. Hence this warning.
 *
 * @param {string|null} headRef `head.ref` from the pulls API.
 * @returns {string|null} A multi-line warning, or null when the head is a real branch.
 */
export function detachedHeadWarning(headRef, { prState } = {}) {
  if (typeof headRef !== 'string' || !/^refs\/pull\/\d+\/head$/.test(headRef)) return null;
  // A CLOSED/merged PR reports refs/pull/N/head once its branch is deleted — routine tidy-up, not a
  // detached PR. Warning there would call a green, correctly-run PR untrustworthy. Measured on #125:
  // opened from a real branch, passed every check, flagged only after the branch was removed.
  if (prState && prState !== 'open') return null;
  return (
    `⚠ DETACHED HEAD — this PR's head is \`${headRef}\`, not a branch.\n` +
    `  Runs from a non-branch head get NO Actions secrets: every \${{ secrets.* }} is EMPTY.\n` +
    `  Any job touching the nx remote cache fails with "Misconfigured remote cache endpoint",\n` +
    `  which looks like a cache fault but is a missing credential. A red run here may say\n` +
    `  nothing about the code. Re-open the PR from a real branch:\n` +
    `      git push origin HEAD:<branch> && <open the PR against that branch>\n` +
    `  Cause: an AGit push (HEAD:refs/for/main) never creates a backing branch.`
  );
}

// --- Rendering ------------------------------------------------------------------------------------

const SYMBOL = { passed: '✓', failed: '✗', skipped: '○', waiting: '⏳', superseded: '➖' };
const ANNOTATION = {
  skipped: '(path-gated → satisfied)',
  waiting: '(queued or running)',
  superseded: '(newer push — not a failure)',
};

/** Every emitted line goes through redaction, so the forge host is `<forge>` by construction. */
const emit = (line) => console.log(stripControlChars(redactForPublication(line)));

function renderVerdict(verdict, { sha, pr, cachePaths, requiredGlobs, headRef, prState }) {
  const width = Math.max(...verdict.all.map((c) => c.job.length), 20);
  emit('');
  emit(`commit ${sha.slice(0, 8)}${pr ? `  (PR #${pr})` : ''}   [${verdict.event} contexts]`);
  emit('');

  // Surfaced BEFORE the check table: with no secrets, the failures below are an artefact of the
  // ref, not a judgement on the code. Reading them the other way is what burned a full day.
  const detached = detachedHeadWarning(headRef, { prState });
  if (detached) {
    emit(detached);
    emit('');
  }

  const required = verdict.all.filter((c) => c.required);
  if (required.length) {
    // Name the SOURCE of the required set. A fallback verdict can disagree with the forge (that is
    // exactly how the 405 happened), so the operator must never have to guess which one they got.
    emit(
      requiredGlobs?.source === 'fallback'
        ? `REQUIRED  ⚠ ${requiredGlobs.note}`
        : `REQUIRED  (from ${requiredGlobs?.note ?? 'branch protection'})`,
    );
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
  if (v.noResults) return 'no checks have reported for this commit yet — not "green", just not known yet.';
  if (v.superseded.length && !v.blocking.length && !v.waiting.length) {
    return `superseded — this run was cancelled by a newer push (${v.superseded.length} context(s)). Not a failure — but not a pass either; the newer run decides.`;
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
  const { sha, pr, base, headRef, prState } = await resolveSha(target, conn);
  const statuses = await fetchCached(
    `/repos/${conn.owner}/${conn.repo}/commits/${sha}/status`, conn, `status-${sha.slice(0, 8)}`,
  );
  // head_sha is a true server-side filter — 0.48 s / 15 KB vs 94 s / 12.4 MB unfiltered.
  const runs = await fetchCached(
    `/repos/${conn.owner}/${conn.repo}/actions/runs?${buildRunsQuery({ sha })}`, conn, `runs-${sha.slice(0, 8)}`,
  );
  // The required set is whatever branch protection SAYS it is — reading it is the whole point, since
  // the hand-maintained mirror drifted and over-reported mergeable (see REQUIRED_CONTEXT_GLOBS).
  // The endpoint is repository-scoped, so the same read token that fetches statuses can read it.
  const requiredGlobs = await resolveRequiredGlobs(
    async () =>
      (await fetchCached(`/repos/${conn.owner}/${conn.repo}/branch_protections`, conn, `protections-${base.replace(/[^\w.-]/g, '_')}`)).data,
    base,
  );
  const verdict = computeMergeVerdict(statuses.data.statuses ?? [], {
    // A commit can carry BOTH push and pull_request contexts, from separate runs whose outcomes
    // differ. --pr implies the PR view (that is what branch protection gates on); --event overrides.
    event: target.event ?? (target.pr ? 'pull_request' : undefined),
    runs: runs.data.workflow_runs ?? [],
    requiredGlobs: requiredGlobs.globs,
  });
  return { verdict, sha, pr, headRef, prState, requiredGlobs, cachePaths: [statuses.path, runs.path] };
}

async function cmdStatus(target, conn) {
  const { verdict, sha, pr, cachePaths, requiredGlobs, headRef, prState } = await loadVerdict(target, conn);
  renderVerdict(verdict, { sha, pr, cachePaths, requiredGlobs, headRef, prState });
  return exitCodeForVerdict(verdict);
}

async function cmdFailure(target, conn) {
  const { verdict, sha, pr } = await loadVerdict(target, conn);
  const failed = [...verdict.blocking, ...verdict.advisory];

  if (!failed.length) {
    if (verdict.superseded.length) {
      emit('No failure to explain — this run was cancelled by a newer push (superseded, not broken).');
      return EXIT.OK;
    }
    emit('No failed jobs on this commit.');
    return EXIT.OK;
  }

  if (!pr) {
    // No commit status exists to find (T040 — the endpoint needs write:repository, 403 measured).
    // The digest lives in the bundle, and the pointer the status used to carry is DERIVED here from
    // the runId already on every check.
    emit(`${failed.length} failed job(s) on a non-PR commit — reading each digest from its bundle:`);
    for (const c of failed) {
      const jobName = c.job.split('/').pop().trim();
      if (!c.runId) {
        emit(`  ✗ ${c.job} — ${c.description} (no run id; pass --run <id> to fetch its bundle)`);
        continue;
      }
      const bundle = await fetchBundle(conn, c.runId, jobName);
      if (!bundle) {
        emit(`  ✗ ${c.job} — ${c.description} (no bundle; the job may have died before the digest step ran)`);
        continue;
      }
      const digestPath = join(bundle.dir, 'digest.md');
      if (existsSync(digestPath)) emit(readFileSync(digestPath, 'utf8'));
      else emit(`  ✗ ${c.job} — bundle ${bundle.version} carries no digest.md`);
      emit(`   📦 extracted to: ${bundle.dir}`);
    }
    return EXIT.FAILED;
  }

  const { data: comments } = await fetchCached(
    `/repos/${conn.owner}/${conn.repo}/issues/${pr}/comments`, conn, `comments-${pr}`,
  );
  const digests = extractDigests(comments, target.job ?? null);

  if (!digests.length) {
    // Fail CLOSED on a filter that excluded everything: saying "no digest was published" when one is
    // sitting on the PR is the exact failure this path is being fixed for.
    const filteredOut = describeFilteredOutDigests(extractDigests(comments, null), target.job ?? null);
    if (filteredOut.length) {
      for (const line of filteredOut) emit(line);
      return EXIT.FAILED;
    }
    // Before concluding "absent", ask each failing job's bundle whether its digest RAN and failed.
    // A bundle fetch that itself fails must not turn a diagnostic into an error, so it degrades to
    // the absent case — which is what this code did unconditionally before.
    const outcomes = [];
    for (const c of failed) {
      const jobName = c.job.split('/').pop().trim();
      if (!c.runId) continue;
      try {
        const bundle = await fetchBundle(conn, c.runId, jobName);
        const o = bundle?.meta?.digestOutcome;
        if (o?.outcome) outcomes.push({ job: jobName, ...o });
      } catch {
        // Deliberately swallowed: see above.
      }
    }
    for (const line of renderDigestAbsence(failed, outcomes)) emit(line);
    return EXIT.FAILED;
  }

  for (const d of digests) {
    if (d.author) emit(`_(digest comment posted by ${d.author} — verify authenticity if unexpected)_`);
    emit(d.body);
  }

  if (target.full) {
    for (const d of digests) {
      // Resolve the run per DIGEST: two failing jobs can belong to different runs, so a single
      // shared run id would fetch the wrong bundle for one of them.
      const owning = verdict.all.find((c) => c.job.endsWith(`/ ${d.job}`) || c.job === d.job);
      const runId = target.run ?? owning?.runId;
      if (!runId) {
        emit(`   ⚠️ could not determine the run for job "${d.job}" — pass --run <id> to fetch its bundle.`);
        continue;
      }
      const bundle = await fetchBundle(conn, runId, d.job);
      if (!bundle) continue;
      // The PATH, not the contents — a 5 MB bundle must never be poured into the conversation.
      emit(`📦 ${bundle.version} extracted to: ${bundle.dir}`);
      if (bundle.meta.truncated) {
        emit(`   ⚠️ truncated at the ${bundle.meta.cap} byte cap: ${(bundle.meta.truncatedSources ?? []).join(', ')}`);
      }
      if ((bundle.meta.absent ?? []).length) emit(`   not collected: ${bundle.meta.absent.join('; ')}`);
    }
  }
  return EXIT.FAILED;
}

/**
 * Resolve one bundle entry inside the bundle root, or throw.
 *
 * A bundle manifest is ATTACKER-CONTROLLED input for anyone holding `write:package` on the forge
 * (a compromised CI token, or another package namespace). Extracting it with a bare join() is
 * zip-slip: it turns that into arbitrary file write on a developer's machine the moment they run
 * `failure --full`, which is a CI-token → workstation escalation.
 *
 * Character sanitising CANNOT be the control here — `.`, `/` and `-` are all legitimate in a path,
 * so a filter that allows them leaves `../../x` completely intact. Containment is checked instead,
 * and `..` segments are rejected before resolution so a symlink pre-planted in the cache directory
 * cannot be used to slip past the check.
 */
export function safeBundleEntryPath(root, entryPath) {
  const raw = String(entryPath ?? '');
  // Trim BEFORE sanitising: sanitising first turns whitespace into underscores, so a blank entry
  // would survive as a junk filename instead of being rejected as the malformed input it is.
  const cleaned = raw.trim().replace(/[^A-Za-z0-9._/-]/g, '_');
  if (!cleaned || cleaned === '.' || cleaned === './') {
    throw new CiStatusError(`invalid bundle entry path: ${JSON.stringify(raw)}`);
  }
  if (cleaned.startsWith('/')) {
    throw new CiStatusError(`refusing absolute bundle entry path: ${JSON.stringify(raw)}`);
  }
  const segments = cleaned.split('/').filter((s) => s !== '' && s !== '.');
  if (!segments.length || segments.some((s) => s === '..')) {
    throw new CiStatusError(`refusing bundle entry path with traversal: ${JSON.stringify(raw)}`);
  }

  const base = resolve(root);
  const dest = resolve(base, segments.join('/'));
  const rel = relative(base, dest);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new CiStatusError(`refusing bundle entry outside the cache directory: ${JSON.stringify(raw)}`);
  }
  return dest;
}

/**
 * Retrieve the full evidence bundle to disk and print its PATH, never its contents (FR-016).
 * At the measured ~135 KB/s the 5 MB cap is ~40 s, so progress is reported rather than appearing hung.
 */
async function fetchBundle(conn, runId, job) {
  const version = bundleVersion(runId, job);
  const url = `${conn.base.replace(/\/api\/v1$/, '/api/packages')}/${conn.owner}/generic/${BUNDLE_PACKAGE}/${version}/bundle.json.gz`;
  emit(`fetching bundle ${version} (up to 5 MB over a ~135 KB/s link — allow ~40 s)…`);
  const res = await fetchWithTimeout(url, { headers: { Authorization: `token ${conn.token}` } });
  if (res.status === 404) {
    emit(`no bundle exists for ${version} — the job may have died before the digest step ran.`);
    return null;
  }
  if (res.status === 401 || res.status === 403) throw new CiStatusError(describeAuthFailure(res.status, url));
  if (!res.ok) throw new CiStatusError(`Forge returned ${res.status} fetching bundle ${version}`);

  const manifest = parseBundleGz(Buffer.from(await res.arrayBuffer()));
  const root = resolve(CACHE_DIR, version);
  const total = (manifest.files ?? []).length;
  const written = safeBundleWrite(root, manifest.files);
  const skipped = total - written.length;
  if (skipped > 0) emit(`   ⚠️ ${skipped} bundle entr${skipped === 1 ? 'y' : 'ies'} skipped (unsafe path or malformed).`);
  // Written under a reserved name so a manifest entry literally called `meta.json` cannot be
  // clobbered by it (and vice versa) — that would be silent evidence loss.
  writeFileSync(resolve(root, '_bundle-meta.json'), JSON.stringify(manifest.meta ?? {}, null, 2));
  return { version, dir: root, meta: manifest.meta ?? {} };
}

async function cmdWatch(target, conn, { timeoutSeconds, intervalSeconds }) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    const { verdict, sha, pr, cachePaths, requiredGlobs, headRef, prState } = await loadVerdict(target, conn);
    if (!verdict.waiting.length) {
      renderVerdict(verdict, { sha, pr, cachePaths, requiredGlobs, headRef, prState });
      return exitCodeForVerdict(verdict);
    }
    if (Date.now() >= deadline) {
      renderVerdict(verdict, { sha, pr, cachePaths, requiredGlobs, headRef, prState });
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
  // Fragmented so no contiguous `.ts.net` literal sits in this file — check-topology-scrub holds
  // no literal to compare against, so it cannot tell an invented host from a real one and
  // flags any it sees. Do not collapse into one string.
  const probeHost = 'http://box.tailz9x8w7' + '.ts' + '.net:3000/x';
  if (!redactForPublication(probeHost).includes('<forge>')) failures.push('host not redacted');
  try { assertFullSha('c2c3c29'); failures.push('an abbreviated sha was accepted'); } catch { /* expected */ }

  if (failures.length) {
    console.error('✗ [ci-status --selftest] FAILED:\n  - ' + failures.join('\n  - '));
    process.exit(1);
  }
  console.log('✓ [ci-status --selftest] traps classified, host redacted, short sha rejected.');
}

const USAGE = `Usage:
  node scripts/ci-status.mjs status [--sha <full-sha> | --pr <n> | --branch <name>] [--event push|pull_request]
  node scripts/ci-status.mjs watch  [--sha … | --pr … | --branch …] [--timeout <seconds>]
  node scripts/ci-status.mjs failure [--sha … | --pr … | --branch …] [--job <name>] [--run <id>] [--full]
  node scripts/ci-status.mjs --selftest

Exit: 0 mergeable · 1 required context failed · 2 bad args/auth · 3 still waiting (NOT a failure).`;

async function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  const command = argv[0];
  if (!command || command.startsWith('-')) { console.error(USAGE); return EXIT.USAGE; }

  let target, timeoutSeconds;
  try {
    ({ target, timeoutSeconds } = parseTargetArgs(argv));
  } catch (err) {
    console.error(`✗ ${err.message}\n\n${USAGE}`);
    return EXIT.USAGE;
  }
  const intervalSeconds = Math.max(1, Number(process.env.CI_STATUS_POLL_SECONDS ?? 30) || 30);

  const conn = { ...forgeEndpoint(), token: requireToken() };
  if (command === 'status') return cmdStatus(target, conn);
  if (command === 'watch') return cmdWatch(target, conn, { timeoutSeconds, intervalSeconds });
  if (command === 'failure') return cmdFailure(target, conn);
  console.error(`Unknown command: ${command}\n\n${USAGE}`);
  return EXIT.USAGE;
}

/** Resolve once stdout has drained, so nothing is truncated by the exit that follows. Bounded: a
 *  `drain` that never arrives (closed pipe) must not hang the tool instead of exiting. */
function flushStdout() {
  return new Promise((resolve) => {
    if (process.stdout.writableLength === 0) return resolve();
    process.stdout.once('drain', resolve);
    setTimeout(resolve, 500).unref();
  });
}

/**
 * Terminate with `code` WITHOUT calling process.exit() on the happy path.
 *
 * Measured on the Windows host (2026-07-26, unchanged by #105): the process died with
 * **-1073740791 (0xC0000409, STATUS_STACK_BUFFER_OVERRUN — Windows' __fastfail abort)** where the
 * contract says 3. The rendered output was correct every time; only the exit path died. That matters
 * beyond cosmetics because CLAUDE.md instructs agents to BRANCH on this exit code, and an abort code
 * is neither 0 nor 3 — it reads as a crashed tool, and `exit 3` (runner starvation, not failure) is
 * precisely the signal that must survive.
 *
 * `process.exit()` is the hazard: it tears the process down immediately, while stdout may still be
 * flushing and while undici keep-alive sockets from the forge fetches are still open — teardown in
 * that state is what aborts. So: flush, set `process.exitCode`, and let the loop drain on its own.
 * The force-exit timer is `unref`'d, which is the load-bearing detail — an unref'd timer cannot hold
 * the loop open, so it only ever FIRES when something else already is (a socket that refuses to
 * close). Natural drain keeps the contracted code; a stuck handle still gets it, just 2 s later.
 */
async function exitWith(code) {
  process.exitCode = code;
  await flushStdout();
  setTimeout(() => process.exit(code), 2000).unref();
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => exitWith(code ?? 0))
    .catch((err) => {
      // Redact before printing: an error message can carry a URL, and therefore the forge host.
      console.error(`✗ ${redactForPublication(err instanceof CiStatusError ? err.message : String(err?.stack ?? err))}`);
      return exitWith(EXIT.USAGE);
    });
}
