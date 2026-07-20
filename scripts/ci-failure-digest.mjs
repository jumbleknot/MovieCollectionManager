#!/usr/bin/env node
// CI failure digest writer (feature 042, US2/US3).
//
// The forge API exposes no log or artifact endpoint, so this inverts the direction: each job PUSHES
// a small, redacted, tail-biased digest into a channel the API can already read — a PR comment on
// `pull_request`, a commit status otherwise — with the full evidence going to the generic package
// registry.
//
// Invoked as an `if: always()` + `continue-on-error: true` step in every job. Three rules are
// absolute:
//
//   FR-009  It must NEVER change a job's outcome. Every failure in here is caught, reported to the
//           job log, and swallowed. A broken digest must not mask a real failure.
//   FR-005  A PR comment is a far MORE visible surface than a run log. Everything published goes
//           through the fail-closed redactor first.
//   FR-001a A job belonging to a CANCELLED run publishes nothing. Its records read as `failure`
//           for a commit that was never broken, so publishing would upsert noise onto the PR on
//           every rapid re-push. The newer run publishes the truth.
//
// Auth is CI_DIGEST_TOKEN — a purpose-scoped Actions secret (write:issue + write:package +
// read:repository). Deliberately NOT CD_PUSH_TOKEN, which is a whitelisted-user PAT able to push
// protected `main`: spreading that across ~20 jobs to publish diagnostics would be a real privilege
// expansion. Read from env only, never argv.
//
// Authoritative tests: scripts/__tests__/ci-failure-digest.test.mjs (CI-enforced by the
// guardrails/naming `node --test scripts/__tests__/*.test.mjs` step, feature 041).

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';

import { redactExcerpt, redactForPublication } from './ci-digest-redact.mjs';

/** Per-source caps. Bounded on two sides: agent context, and the ~135 KB/s link (NFR-003). */
export const DEFAULT_CAPS = { lines: 200, bytes: 32 * 1024 };

// --- Distillation ---------------------------------------------------------------------------------

/** Take the LAST `n` lines. Failures surface at the end; a head-biased excerpt shows the banner. */
export function tailLines(text, n) {
  if (n <= 0) return ''; // slice(-0) is slice(0) — it would return the WHOLE string
  const lines = String(text).split('\n');
  return lines.length <= n ? String(text) : lines.slice(-n).join('\n');
}

/** Trim to a byte budget from the END, for a source with few but enormous lines. */
function tailBytes(text, maxBytes) {
  if (maxBytes <= 0) return '';
  // Measure BYTES, not UTF-16 code units: a 4-byte emoji has length 2, so a code-unit budget
  // overshoots the real one by up to 3x on non-ASCII log output.
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let out = text.slice(-maxBytes);
  while (Buffer.byteLength(out, 'utf8') > maxBytes) out = out.slice(Math.ceil(out.length / 8) || 1);
  return out;
}

/** The upsert key. Keyed by JOB, not run: a retry produces a new run but must edit one comment. */
export function digestMarker(job) {
  return `<!-- ci-digest:job=${String(job).trim()} -->`;
}

/** Locate this job's previous digest comment so a retry edits it instead of stacking a new one. */
export function findExistingComment(comments, job) {
  const marker = digestMarker(job);
  return comments.find((c) => typeof c.body === 'string' && c.body.includes(marker)) ?? null;
}

function distill(excerpt, caps) {
  const originalLines = String(excerpt.text).split('\n').length;
  let text = tailLines(excerpt.text, caps.lines);
  const byteTrimmed = Buffer.byteLength(text, 'utf8') > caps.bytes;
  text = tailBytes(text, caps.bytes);

  // Redact BEFORE publication, fail-closed: an excerpt still matching a detection rule after
  // redaction is dropped wholesale rather than published.
  const { text: safe, withheld } = redactExcerpt(text);
  return {
    source: excerpt.source,
    text: safe,
    withheld,
    truncated: originalLines > caps.lines || byteTrimmed,
    originalLines,
  };
}

/**
 * Build the publishable digest.
 * @returns {{markdown: string, excerpts: object[]}}
 */
export function buildDigest(context, { excerpts = [], health = [], absent = [], caps = DEFAULT_CAPS } = {}) {
  const distilled = excerpts.map((e) => distill(e, caps));
  const safe = (s) => redactForPublication(String(s ?? ''));

  const rows = [
    ['Commit', `\`${safe(context.sha).slice(0, 8)}\``],
    context.pr ? ['PR', `#${context.pr}`] : null,
    ['Failing step', safe(context.step) || '_not reported_'],
    ['Run', `\`${context.runId}\``],
  ].filter(Boolean);

  const parts = [
    digestMarker(context.job),
    `### ❌ CI failure — \`${safe(context.workflow)}\` / \`${safe(context.job)}\``,
    '',
    '| | |',
    '|---|---|',
    ...rows.map(([k, v]) => `| **${k}** | ${v} |`),
    '',
  ];

  if (health.length) {
    parts.push('**Container health**', '', '```');
    for (const h of health) parts.push(safe(`${h.container}  ${h.status}  ${h.output ?? ''}`.trimEnd()));
    parts.push('```', '');
  }

  for (const e of distilled) {
    const label = e.truncated
      ? `\`${safe(e.source)}\` (tail, truncated ${e.originalLines.toLocaleString('en-US')} → ${caps.lines} lines)`
      : `\`${safe(e.source)}\``;
    parts.push(`**${label}**`, '');
    if (e.withheld) parts.push(e.text, '');
    else parts.push('```', e.text, '```', '');
  }

  if (absent.length) {
    parts.push('**Not collected**', '');
    for (const a of absent) parts.push(`- ${safe(a)}`);
    parts.push('');
  }

  if (context.bundleRef) {
    parts.push(
      `📦 Full evidence: \`${safe(context.bundleRef)}\` → ` +
        `\`node scripts/ci-status.mjs failure --run ${context.runId} --full\``,
    );
  }

  return { markdown: parts.join('\n'), excerpts: distilled };
}

// --- Publish guard (FR-001a) ------------------------------------------------------------------------

/**
 * Decide whether this job should publish at all.
 * The cancelled check MUST come first: a cancelled job DOES report `failure`, so testing the job
 * status first would publish a failure digest for a commit that was never broken.
 */
export function shouldPublish({ runStatus, jobStatus }) {
  if (runStatus === 'cancelled') {
    return { publish: false, reason: 'run was cancelled/superseded by a newer push — the newer run publishes the truth' };
  }
  if (jobStatus !== 'failure') return { publish: false, reason: `job status is ${jobStatus}, not a failure` };
  return { publish: true, reason: 'genuine job failure' };
}

// --- Publish routing ----------------------------------------------------------------------------

/**
 * Publish the digest through whichever channel the event allows.
 *
 *   pull_request → UPSERT a PR comment, matched by marker, so a retry edits rather than stacks.
 *   push / other → a commit status whose target_url points at the evidence bundle.
 *   cancelled    → nothing at all (FR-001a).
 *
 * NEVER throws (FR-009). A digest failure must not change the job's outcome, so every error is
 * caught, redacted and returned as a reason.
 *
 * @param api injected transport — {listComments, createComment, updateComment}
 */
export async function publishDigest({ context, digest }, api) {
  const gate = shouldPublish({ runStatus: context.runStatus, jobStatus: context.jobStatus ?? 'failure' });
  if (!gate.publish) return { published: false, reason: gate.reason };

  try {
    if (context.event === 'pull_request' && context.pr) {
      const existing = findExistingComment(await api.listComments(context.pr), context.job);
      if (existing) {
        await api.updateComment(existing.id, digest.markdown);
        return { published: true, channel: 'pr-comment', updated: existing.id };
      }
      const created = await api.createComment(context.pr, digest.markdown);
      return { published: true, channel: 'pr-comment', created: created?.id ?? null };
    }

    // NON-PR EVENTS PUBLISH NOTHING SEPARATELY (FR-008, amended by T040).
    //
    // This used to POST a commit status pointing at the bundle. Measured on smoke run 986, that
    // endpoint returns 403: it needs `write:repository`, which is most of the privilege that made
    // CD_PUSH_TOKEN unacceptable to spread across 16 jobs. The status was only ever a POINTER, and
    // the reader can derive it from (runId, job) — so it is dropped rather than paid for.
    //
    // The digest itself travels inside the bundle as digest.md, and is echoed to the job log for a
    // human reading the web UI.
    return { published: true, channel: 'bundle' };
  } catch (err) {
    // Redact before reporting: an error message can carry a URL, and therefore the forge host.
    return { published: false, reason: redactForPublication(String(err?.message ?? err)) };
  }
}

// --- Collection (T021) ------------------------------------------------------------------------------

const MAX_COLLECTED_SOURCES = 6;

/** Read a file if it exists, else null. Never throws — collection must not fail a job. */
function readIfPresent(path) {
  try {
    return existsSync(path) && statSync(path).isFile() ? readFileSync(path, 'utf8') : null;
  } catch {
    return null;
  }
}

/**
 * Collect whatever evidence this runner actually has, and record what it does not.
 *
 * Degrades deliberately: container jobs (`ubuntu-latest` / node:22-bookworm) have NO Docker CLI, and
 * `~/mcm-ci-last-failure/` is written by exactly one job today (app-ci/app-e2e). Missing evidence is
 * the normal case, not an error.
 */
export function collectEvidence({ home = process.env.HOME ?? '', cwd = process.cwd() } = {}) {
  const excerpts = [];
  const health = [];
  const absent = [];

  const bundleDir = join(home, 'mcm-ci-last-failure');
  if (existsSync(bundleDir)) {
    let entries = [];
    try {
      entries = readdirSync(bundleDir);
    } catch {
      absent.push('the failure bundle directory could not be read');
    }
    for (const name of entries.filter((n) => n.endsWith('.health.json'))) {
      const raw = readIfPresent(join(bundleDir, name));
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        health.push({
          container: name.replace(/\.health\.json$/, ''),
          status: parsed?.Status ?? 'unknown',
          output: (parsed?.Log?.at(-1)?.Output ?? '').trim().split('\n').at(-1) ?? '',
        });
      } catch {
        /* a malformed health file is not worth failing over */
      }
    }
    for (const name of entries.filter((n) => n.endsWith('.log')).slice(0, MAX_COLLECTED_SOURCES)) {
      const text = readIfPresent(join(bundleDir, name));
      if (text) excerpts.push({ source: name, text });
    }
    if (!entries.length) absent.push('the failure bundle directory was empty');
  } else {
    absent.push(
      'container logs + health — no ~/mcm-ci-last-failure bundle on this runner ' +
        '(container jobs have no Docker CLI; only app-ci/app-e2e writes one today)',
    );
  }

  for (const [label, rel] of [
    ['playwright report', 'frontend/mcm-app/playwright-report/index.html'],
    ['maestro debug output', 'maestro-debug'],
  ]) {
    if (!existsSync(join(cwd, rel))) absent.push(`${label} — not present`);
  }

  if (!excerpts.length && !health.length) absent.push('no log output was captured for this job');
  return { excerpts, health, absent };
}

// --- Evidence bundle (US3) --------------------------------------------------------------------------

/** 5 MB ≈ 40 s to retrieve at the measured ~135 KB/s link — the ceiling for `--full` to stay usable. */
export const BUNDLE_CAP_BYTES = 5 * 1024 * 1024;

/** Matches the repository's existing general log-retention standard. */
export const RETENTION_DAYS = 30;

export const BUNDLE_PACKAGE = 'ci-failures';

/**
 * Bundle identity: per run AND job.
 *
 * Keying by run alone would let two jobs failing in the same run overwrite each other — and jobs
 * fail together routinely, most notably when a cancelled run fails every context at once (SC-010).
 * The `--` separator keeps numeric run ids unambiguous against hyphenated job names.
 */
export function bundleVersion(runId, job) {
  const slug = String(job).trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${runId}--${slug}`;
}

/**
 * Assemble the bundle manifest, enforcing the size cap largest-source-first.
 * A bundle must never silently misrepresent itself as complete, so any trimming is recorded.
 */
export function buildBundleManifest(files, { cap = BUNDLE_CAP_BYTES, absent = [], context = {}, digestMarkdown = null } = {}) {
  // digest.md first: for a non-PR failure the bundle is the ONLY place the digest exists, so it must
  // survive the size cap. It is small, and the cap trims the largest source first.
  const kept = [...(digestMarkdown ? [{ path: 'digest.md', text: String(digestMarkdown) }] : []), ...files].map((f) => ({ ...f }));
  const truncatedSources = [];
  const size = (f) => Buffer.byteLength(f.text, 'utf8');
  const total = () => kept.reduce((n, f) => n + size(f), 0);

  // Trim the biggest source first — one runaway log should not evict every other piece of evidence.
  //
  // Each pass trims the largest source to AT MOST half its size (never to zero via `slice(-0)`,
  // which returns the whole string and used to let an over-cap bundle through while stamping
  // meta.truncated: true). Halving guarantees progress and terminates, and it converges on trimming
  // every source proportionally rather than annihilating one.
  let guard = 0;
  while (total() > cap && kept.length && guard++ < 10_000) {
    const largest = kept.reduce((a, b) => (size(a) >= size(b) ? a : b));
    const excess = total() - cap;
    const target = Math.max(0, Math.min(size(largest) - excess, Math.floor(size(largest) / 2)));
    largest.text = target === 0 ? '' : tailBytes(largest.text, target);
    if (!truncatedSources.includes(largest.path)) truncatedSources.push(largest.path);
    if (size(largest) === 0 && total() > cap && kept.every((f) => size(f) === 0)) break;
  }

  return {
    files: kept,
    meta: {
      ...context,
      truncated: truncatedSources.length > 0,
      truncatedSources,
      absent,
      cap,
      collector: 'ci-failure-digest',
    },
  };
}

/**
 * Pick the bundle versions past the retention window.
 * A version whose timestamp cannot be parsed is KEPT — deleting evidence on a parse failure is the
 * destructive direction.
 */
export function selectExpiredVersions(versions, { now = Date.now(), retentionDays = RETENTION_DAYS } = {}) {
  const cutoff = now - retentionDays * 86_400_000;
  return versions.filter((v) => {
    const at = Date.parse(v.created_at ?? v.createdAt ?? '');
    return Number.isFinite(at) && at < cutoff;
  });
}

// --- Runner context -----------------------------------------------------------------------------------

/** Read the job context from the runner environment. */
export function readJobContext(env = process.env) {
  const eventPath = env.GITHUB_EVENT_PATH;
  let pr = null;
  if (eventPath) {
    try {
      pr = JSON.parse(readFileSync(eventPath, 'utf8'))?.pull_request?.number ?? null;
    } catch {
      /* no PR context available */
    }
  }
  return {
    workflow: env.GITHUB_WORKFLOW ?? 'unknown-workflow',
    job: env.GITHUB_JOB ?? 'unknown-job',
    step: env.CI_DIGEST_FAILING_STEP ?? '',
    sha: env.GITHUB_SHA ?? '',
    runId: env.GITHUB_RUN_ID ?? '',
    event: env.GITHUB_EVENT_NAME ?? 'push',
    pr,
    jobStatus: env.CI_DIGEST_JOB_STATUS ?? 'failure',
    runStatus: env.CI_DIGEST_RUN_STATUS ?? env.CI_DIGEST_JOB_STATUS ?? 'failure',
  };
}

// --- Selftest ------------------------------------------------------------------------------------------

/** Thin smoke check. The authoritative suite is scripts/__tests__/ci-failure-digest.test.mjs. */
function selftest() {
  const failures = [];
  const d = buildDigest(
    { workflow: 'app-ci', job: 'app-e2e', step: 'x', sha: 'a'.repeat(40), pr: 1, runId: 9 },
    { excerpts: [{ source: 'a.log', text: 'boot\nfail at the end' }] },
  );
  if (!d.markdown.startsWith(digestMarker('app-e2e'))) failures.push('digest does not lead with its upsert marker');
  if (!d.markdown.includes('fail at the end')) failures.push('tail of the excerpt was lost');
  if (shouldPublish({ runStatus: 'cancelled', jobStatus: 'failure' }).publish) {
    failures.push('a cancelled run would publish a digest');
  }
  if (tailLines('a\nb\nc\nd', 2) !== 'c\nd') failures.push('tail selection is not tail-biased');

  if (failures.length) {
    console.error('✗ [ci-failure-digest --selftest] FAILED:\n  - ' + failures.join('\n  - '));
    process.exit(1);
  }
  console.log('✓ [ci-failure-digest --selftest] tail-biased, marker-keyed, suppressed on cancelled.');
}

// --- Real transport -------------------------------------------------------------------------------

/** Repo slug + API base from the runner env, falling back to the origin remote. Host never printed. */
function forgeEndpoint(env = process.env) {
  const server = env.GITHUB_SERVER_URL;
  const slug = env.GITHUB_REPOSITORY;
  if (server && slug) {
    const [owner, repo] = slug.split('/');
    return { base: `${server}/api/v1`, owner, repo };
  }
  const origin = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  const m = origin.replace(/\.git$/, '').match(/^(https?:\/\/[^/]+)\/([^/]+)\/([^/]+)$/);
  if (!m) throw new Error('could not resolve the forge API base');
  return { base: `${m[1]}/api/v1`, owner: m[2], repo: m[3] };
}

/**
 * Name the scope an endpoint actually needs. FR-020: a 401/403 must name the MISSING scope, never a
 * plausible-sounding wrong one. The first version tested only for `/issues/` and defaulted everything
 * else to `write:package`, so a 403 on the statuses endpoint reported `write:package` — which is
 * granted and working. That message sends the reader after the wrong fix, which is worse than a bare
 * status code.
 */
export function scopeHintForTest(pathOrUrl) {
  return scopeHintFor(pathOrUrl);
}

function scopeHintFor(pathOrUrl) {
  const p = String(pathOrUrl);
  const scope = /\/issues\//.test(p)
    ? 'write:issue'
    : /\/api\/packages\//.test(p)
      ? 'write:package'
      : /\/statuses\//.test(p)
        ? 'write:repository'
        : 'write:repository';
  return ` — CI_DIGEST_TOKEN is missing the \`${scope}\` scope for this endpoint`;
}

function httpApi({ base, owner, repo, token }) {
  const call = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const scopeHint = res.status === 401 || res.status === 403 ? scopeHintFor(path) : '';
      throw new Error(`forge returned ${res.status} for ${method} ${path}${scopeHint}`);
    }
    return res.status === 204 ? null : res.json();
  };
  // The generic package registry lives outside /api/v1, so it needs the bare server root.
  const packagesRoot = base.replace(/\/api\/v1$/, '/api/packages');
  const rawCall = async (method, url, body, contentType) => {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `token ${token}`,
        ...(contentType ? { 'Content-Type': contentType } : {}),
      },
      body,
    });
    if (!res.ok && res.status !== 404) {
      const hint = res.status === 401 || res.status === 403 ? scopeHintFor(url) : '';
      throw new Error(`forge returned ${res.status} for ${method} ${url.replace(/^https?:\/\/[^/]+/, '')}${hint}`);
    }
    return res;
  };

  return {
    listComments: (pr) => call('GET', `/repos/${owner}/${repo}/issues/${pr}/comments`),
    uploadBundle: (version, filename, buffer) =>
      rawCall('PUT', `${packagesRoot}/${owner}/generic/${BUNDLE_PACKAGE}/${version}/${filename}`, buffer, 'application/octet-stream'),
    listBundleVersions: async () => {
      // PAGINATED, deliberately. Forgejo defaults to page 1 at 30 items and orders packages by
      // name, not age — so an unpaginated call silently stops seeing expired bundles once more
      // than 30 exist, degrading retention to a no-op with no error. This is the same pagination
      // trap the read side documents at length; the write side must not fall into it.
      const out = [];
      for (let page = 1; page <= 100; page++) {
        const res = await rawCall('GET', `${base}/packages/${owner}?type=generic&q=${BUNDLE_PACKAGE}&page=${page}&limit=50`);
        if (res.status === 404) break;
        const batch = await res.json();
        if (!Array.isArray(batch) || batch.length === 0) break;
        out.push(...batch.filter((x) => x.name === BUNDLE_PACKAGE));
        if (batch.length < 50) break;
      }
      return out;
    },
    deleteBundleVersion: (version) =>
      rawCall('DELETE', `${base}/packages/${owner}/generic/${BUNDLE_PACKAGE}/${version}`),
    createComment: (pr, body) => call('POST', `/repos/${owner}/${repo}/issues/${pr}/comments`, { body }),
    updateComment: (id, body) => call('PATCH', `/repos/${owner}/${repo}/issues/comments/${id}`, { body }),
  };
}

async function run() {
  const context = readJobContext();
  const gate = shouldPublish({ runStatus: context.runStatus, jobStatus: context.jobStatus });
  if (!gate.publish) {
    console.log(`[ci-failure-digest] nothing to publish — ${gate.reason}`);
    return;
  }

  const evidence = collectEvidence();
  const digest = buildDigest(context, evidence);

  const token = process.env.CI_DIGEST_TOKEN;
  if (!token) {
    // Still surface the digest inline so the run log carries it, then stop. Never fail the job.
    console.log('[ci-failure-digest] CI_DIGEST_TOKEN is not set — printing the digest inline instead.');
    console.log(digest.markdown);
    return;
  }

  const api = httpApi({ ...forgeEndpoint(), token });

  const version = bundleVersion(context.runId, context.job);
  context.bundleRef = `${BUNDLE_PACKAGE}:${version}`;
  // The human-facing package page, surfaced in the digest so a reader can click through from the
  // job log. No longer used as a commit-status target_url — that status is gone (T040).
  const { base, owner } = forgeEndpoint();
  context.bundleUrl = `${base.replace(/\/api\/v1$/, '')}/${owner}/-/packages/generic/${BUNDLE_PACKAGE}/${version}`;
  const withBundle = buildDigest(context, evidence);

  // Publish FIRST, then upload — so the bundle can record whether publication actually reached its
  // channel. The bundle is readable over the API while the job log is not, so without this the
  // outcome of a failed publish is only visible to a human in the web UI. That is exactly the
  // bootstrap gap that made T040's cause un-diagnosable from here.
  const result = await publishDigest({ context, digest: withBundle }, api);
  await publishBundle(api, version, evidence, context, result, withBundle.markdown).catch((err) =>
    console.error(`[ci-failure-digest] bundle upload suppressed: ${redactForPublication(String(err?.message ?? err))}`),
  );
  console.log(
    result.published
      ? `[ci-failure-digest] published via ${result.channel} (bundle ${version})`
      : `[ci-failure-digest] NOT PUBLISHED — ${result.reason}`,
  );
  // The digest also goes to the job log unconditionally. The run log is readable by a HUMAN in the
  // forge UI even though no API exposes it, so this keeps a failure diagnosable from the browser
  // even when publication fails — and makes the publish failure itself diagnosable, which the first
  // smoke run was not.
  console.log('::group::ci-failure-digest (inline copy)');
  console.log(withBundle.markdown);
  console.log('::endgroup::');

  // Opportunistic retention (FR-021a): no scheduled pipeline exists for this, so each publish
  // prunes. A pruning failure must never fail the publish or the job (FR-021b).
  await pruneExpiredBundles(api).catch((err) =>
    console.error(`[ci-failure-digest] prune suppressed: ${redactForPublication(String(err?.message ?? err))}`),
  );
}

/** Upload the full evidence as one gzipped manifest, size-capped and self-describing. */
async function publishBundle(api, version, evidence, context, publishResult = null, digestMarkdown = null) {
  const files = [
    ...evidence.excerpts.map((e) => ({ path: `logs/${e.source}`, text: e.text })),
    ...evidence.health.map((h) => ({ path: `health/${h.container}.json`, text: JSON.stringify(h, null, 2) })),
  ];
  const manifest = buildBundleManifest(files, {
    digestMarkdown: digestMarkdown ?? null,
    absent: evidence.absent,
    context: {
      workflow: context.workflow, job: context.job, step: context.step,
      sha: context.sha, pr: context.pr, runId: context.runId,
      // Whether the digest reached its channel, and if not, why. Readable over the API even when
      // the job log is not.
      publish: publishResult
        ? { published: publishResult.published, channel: publishResult.channel ?? null, reason: publishResult.reason ?? null }
        : null,
    },
  });
  // Redact the bundle too — it is as publishable as the digest (FR-005).
  for (const f of manifest.files) f.text = redactExcerpt(f.text).text;
  const payload = gzipSync(Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
  await api.uploadBundle(version, 'bundle.json.gz', payload);
  console.log(`[ci-failure-digest] bundle uploaded: ${version} (${payload.length} bytes gzipped)`);
}

/** Delete bundle versions past the retention window. Never throws at the caller's expense. */
async function pruneExpiredBundles(api) {
  const packages = await api.listBundleVersions();
  const expired = selectExpiredVersions(packages);
  for (const p of expired) {
    try {
      await api.deleteBundleVersion(p.version);
      console.log(`[ci-failure-digest] pruned expired bundle ${p.version}`);
    } catch (err) {
      console.error(`[ci-failure-digest] prune of ${p.version} suppressed: ${redactForPublication(String(err?.message ?? err))}`);
    }
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--selftest')) selftest();
  else {
    // FR-009: this step must NEVER change a job's outcome. Every error is caught and swallowed,
    // and the exit code is always 0 — `continue-on-error` in the workflow is belt to this braces.
    // FR-009: always exit 0. Set exitCode rather than calling process.exit(), which discards
    // queued stdout writes — and stdout to a pipe (which is exactly what a CI log capture is) is
    // asynchronous in Node. The no-token fallback prints the whole digest to stdout, so exiting
    // hard would truncate the very output that fallback exists to preserve.
    run()
      .catch((err) => console.error(`[ci-failure-digest] suppressed error: ${redactForPublication(String(err?.message ?? err))}`))
      .finally(() => {
        process.exitCode = 0;
      });
  }
}
