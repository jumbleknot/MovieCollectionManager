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

/** How many sources the digest itself shows. The bundle always carries all of them. */
export const DIGEST_MAX_SOURCES = 3;

/**
 * A PR comment / commit status is a size-limited channel. Forgejo's comment body limit is ~65,535
 * bytes; a full app-e2e digest measured 90 KB (run 1000). The BUNDLE keeps every log as its own
 * file, so trimming the digest MARKDOWN loses nothing — the pointer to the bundle is preserved.
 */
export const COMMENT_MAX_BYTES = 60_000;

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

/** Choose a code-fence longer than any backtick run in the content, so attacker-printed ``` in a
 *  log excerpt cannot close the fence early and inject live markdown into the PR comment. */
export function fenceFor(text) {
  let longest = 0;
  for (const m of String(text).matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return '`'.repeat(Math.max(3, longest + 1));
}

/** Defang ci-digest markers embedded in attacker-controlled content: a log line echoing another
 *  job's `<!-- ci-digest:job=X -->` must not inject a second marker or enable a cross-job overwrite.
 *  A zero-width space after `<!--` breaks the literal token without changing what a human reads. */
export function neutralizeMarkers(text) {
  return String(text).replace(/<!--(\s*ci-digest:)/gi, '<!--\u200b$1');
}

/** The upsert key. Keyed by JOB, not run: a retry produces a new run but must edit one comment. */
export function digestMarker(job) {
  return `<!-- ci-digest:job=${String(job).trim()} -->`;
}

/** Locate this job's previous digest comment so a retry edits it instead of stacking a new one. */
export function findExistingComment(comments, job) {
  const marker = digestMarker(job);
  // Anchor at the START of the body: a real digest always leads with its marker. Matching anywhere
  // (`.includes`) let a log excerpt that echoed the marker string hijack another job's upsert.
  return comments.find((c) => typeof c.body === 'string' && c.body.trimStart().startsWith(marker)) ?? null;
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
  // The BUNDLE carries every source; the DIGEST carries only the most diagnostic few. Fixing the
  // collector took sources from 6 to 13, and 13 x 200 lines is an unreadable PR comment. Sources
  // arrive already ranked by selectSources (status table, then unhealthy containers, then the rest).
  const shown = excerpts.slice(0, DIGEST_MAX_SOURCES);
  const heldBack = excerpts.length - shown.length;
  const distilled = shown.map((e) => distill(e, caps));
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
    for (const h of health) {
      const line = `${h.container}  ${h.status}  ${h.output ?? ''}`.trimEnd();
      const { text: safeLine, withheld } = redactExcerpt(line);
      parts.push(withheld ? safeLine : neutralizeMarkers(safeLine));
    }
    parts.push('```', '');
  }

  for (const e of distilled) {
    const label = e.truncated
      ? `\`${safe(e.source)}\` (tail, truncated ${e.originalLines.toLocaleString('en-US')} → ${caps.lines} lines)`
      : `\`${safe(e.source)}\``;
    parts.push(`**${label}**`, '');
    if (e.withheld) parts.push(e.text, '');
    else {
      const body = neutralizeMarkers(e.text);
      const fence = fenceFor(body);
      parts.push(fence, body, fence, '');
    }
  }

  if (heldBack > 0) {
    parts.push(
      `_${heldBack} more source(s) held back from this summary — all of them are in the evidence bundle._`,
      '',
    );
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

  let markdown = parts.join('\n');
  if (Buffer.byteLength(markdown, 'utf8') > COMMENT_MAX_BYTES) {
    // Trim from the END (the last, lowest-ranked excerpt bodies) until it fits, then say so. The
    // bundle still carries the full logs as separate files, so nothing is actually lost.
    const notice =
      '\n\n_Digest truncated for comment size — the full content is in the evidence bundle._';
    const budget = COMMENT_MAX_BYTES - Buffer.byteLength(notice, 'utf8');
    while (Buffer.byteLength(markdown, 'utf8') > budget && markdown.length > 0) {
      markdown = markdown.slice(0, Math.floor(markdown.length * 0.9));
    }
    // Never cut mid-line — back up to the last newline so a code fence or table row is not orphaned.
    const lastNl = markdown.lastIndexOf('\n');
    if (lastNl > 0) markdown = markdown.slice(0, lastNl);
    markdown += notice;
  }

  return { markdown, excerpts: distilled };
}

// --- Publish guard (FR-001a) ------------------------------------------------------------------------

/**
 * Decide whether this job should publish, and in which MODE.
 *
 * The cancelled check MUST come first: a cancelled job DOES report `failure`, so testing the job
 * status first would publish a failure digest for a commit that was never broken.
 *
 * `counts` mode exists because a green run left no bundle at all, so a passing app-e2e's counts and
 * retry churn could not be read without making the job fail (backlog item #167). It publishes a
 * small counts-only bundle and no PR comment.
 *
 * `counts` is gated on an EXPLICIT `success`, not on "anything that is not a failure". That
 * asymmetry is deliberate: a job that loses `CI_DIGEST_JOB_STATUS` once published a spurious digest
 * on a green run, which is why an unknown status publishes nothing. Treating unknown as
 * publishable-in-a-cheaper-mode would resurrect that bug in a new costume.
 */
export function shouldPublish({ runStatus, jobStatus }) {
  if (runStatus === 'cancelled') {
    return { publish: false, mode: null, reason: 'run was cancelled/superseded by a newer push — the newer run publishes the truth' };
  }
  if (jobStatus === 'failure') return { publish: true, mode: 'digest', reason: 'genuine job failure' };
  if (jobStatus === 'success') {
    return { publish: true, mode: 'counts', reason: 'job passed — publishing counts only, so a green run is readable' };
  }
  return { publish: false, mode: null, reason: `job status is ${jobStatus}, neither a failure nor a success` };
}

/**
 * The step logs a `counts` publication carries — and nothing else.
 *
 * Self-limiting BY CONSTRUCTION rather than by a job allowlist: only app-e2e produces these steps,
 * so every other job's counts publication finds nothing and uploads nothing. An allowlist would be a
 * second place to forget to update, and forgetting it fails silently in the direction of publishing
 * a version per green job per run.
 *
 * `e2e-turn-tally` is listed here before the step exists (054 T013 adds it). An absent source is
 * simply not collected, so naming it early costs nothing and cannot be forgotten later.
 */
/** The web-E2E step log — carried only as its `[global-setup]` lines. See selectCountsSources. */
export const WEB_E2E_SOURCE = 'step:web-e2e';

export const COUNTS_SOURCES = Object.freeze([
  'step:e2e-result-gate',
  'step:e2e-contention-tally',
  'step:e2e-turn-tally',
]);

/**
 * The web-E2E step log, reduced to the lines that say HOW the run was set up.
 *
 * Measured on app-ci run #1681: the counts bundle proved the suite was green and the contention
 * zero, and could not say whether per-worker identities actually engaged — that line lives in the
 * `web-e2e` log, collected only on failure. Global setup warns loudly when it falls back to a shared
 * identity, and on a green run that warning was unreachable. A green run that cannot say WHICH
 * identity model produced it has the same gap as one that cannot say how many tests ran.
 *
 * Filtered, not whole: `web-e2e` is thousands of lines and counts mode exists to stay small.
 */
const SETUP_LINE = /^\s*\[global-setup\]/;

export function selectCountsSources(excerpts = []) {
  const named = excerpts.filter((e) => COUNTS_SOURCES.includes(e.source));
  const web = excerpts.find((e) => e.source === WEB_E2E_SOURCE);
  if (!web) return named;
  const setupLines = web.text.split('\n').filter((l) => SETUP_LINE.test(l));
  return setupLines.length ? [...named, { source: WEB_E2E_SOURCE, text: setupLines.join('\n') }] : named;
}

// --- Outcome signal (feature 051 US3, FR-010/011/012) --------------------------------------------
//
// This step is `if: always()` + `continue-on-error: true` and ends in an unconditional exit 0. All
// three are right — a broken reporter must never fail a build — but together they erase the
// difference between NOTHING TO REPORT and THE REPORTER IS BROKEN. Downstream, `ci-status failure`
// then says "no digest was published" for both, and the reader believes the first one.
//
// Measured 2026-08-01: on an AGit-headed run every Actions secret was empty, so CI_DIGEST_TOKEN was
// blank. This script collected its evidence, could not publish it, printed the digest to stdout —
// which the forge API cannot expose — and exited 0. Zero comments on the PR, no error, no signal.
// An evening went into looking for a CI fault that had already been diagnosed and thrown away.
//
// The vocabulary deliberately mirrors the `absent` field this file already uses to separate "looked
// and found nothing" from "did not look", rather than inventing a second one for the same idea.

export const OUTCOME = Object.freeze({
  NOT_NEEDED: 'not-needed',
  PUBLISHED: 'published',
  FAILED: 'failed',
});

/**
 * Classify a publication failure into a sub-reason, because each one implies a DIFFERENT next
 * action: check whether the run had secrets at all / grant a scope / retry the forge. Collapsing
 * them into a bare "failed" would leave the reader as stuck as an absent digest does.
 *
 * Fails CLOSED on an unrecognised reason: `unknown` is still `failed`. Guessing `transport` for,
 * say, a 401 would send the reader to the wrong place, but reporting `published` would recreate the
 * original bug — so an unclassifiable failure keeps the outcome and admits the sub-reason is a guess.
 */
function classifyFailure(reason) {
  const r = String(reason ?? '');
  if (/\b40[13]\b|forbidden|unauthori[sz]ed|permission|scope/i.test(r)) return 'forbidden';
  if (/timed out|timeout|ECONN|ENOTFOUND|EAI_AGAIN|socket|network|fetch failed|\b5\d\d\b/i.test(r)) return 'transport';
  return 'unknown';
}

/**
 * The three-way outcome of this digest run.
 *
 * @param gate          the `shouldPublish` verdict — !publish means no digest was ever needed
 * @param tokenPresent  whether a usable credential existed at all
 * @param publishResult the `publishDigest` result, when one was attempted
 * @returns {{outcome: string, detail: string|null, channel: string|null, summary: string, signal: string}}
 *
 * Everything it returns is redacted, exactly as the digest body is (contract obligation 4) — a
 * transport error can carry a URL and therefore the forge host.
 *
 * Note it needs NO credential to say `failed:no-credential` (obligation 3). If naming that state
 * required the token, the one state that matters most could never be reported — which is precisely
 * what happened.
 */
/**
 * Which credential publishes this digest.
 *
 * `CI_DIGEST_TOKEN` is an Actions secret, and it is empty exactly when a run is most confusing: on
 * the AGit-headed run of 2026-08-01 every `secrets.*` arrived blank, so the digest collected its
 * evidence and had nothing to publish it with.
 *
 * Feature 051 T034 MEASURED (guardrails run #1627) that the run's automatically-provisioned token
 * can write `POST /repos/{owner}/{repo}/statuses/{sha}` — it left a real `probe-051-t034` status
 * behind. So falling back to it is worth doing.
 *
 * ⚠️ What T034 could NOT establish is whether that token is *populated* on a secretless run; proving
 * that needs an AGit-headed push, which CLAUDE.md forbids. `both absent` therefore stays a
 * first-class outcome rather than a theoretical one.
 *
 * The empty-STRING check is load-bearing: 2026-08-01 presented as `${{ secrets.CI_DIGEST_TOKEN }}`
 * expanding to `''`, not as an unset variable. A test for `undefined` alone sails past it and fails
 * later at the transport with a confusing 401.
 */
export function selectCredential(env = process.env) {
  const usable = (v) => (typeof v === 'string' && v.trim() !== '' ? v : null);
  const purposeScoped = usable(env.CI_DIGEST_TOKEN);
  if (purposeScoped) return { token: purposeScoped, source: 'purpose-scoped' };
  const auto = usable(env.GITHUB_TOKEN) ?? usable(env.ACTIONS_RUNTIME_TOKEN);
  if (auto) return { token: auto, source: 'auto' };
  return { token: null, source: null };
}

export function describeOutcome({ gate = { publish: true }, tokenPresent = true, publishResult = null, credentialSource = 'purpose-scoped' } = {}) {
  // A publication that went out through the FALLBACK is `published`, not `failed`.
  //
  // contracts/digest-outcome.md literally says the fallback records `failed:no-credential`. That
  // wording would make `published` and `failed` simultaneously true and break Story 3's own
  // vocabulary, in which `failed` means the evidence did NOT reach a channel. The reader's question
  // is "did the diagnosis get to me?", and via the fallback the answer is yes — in a degraded form.
  // So both facts are carried (`published` + `degraded`) instead of collapsed into a misleading one.
  // Deliberate deviation, recorded here and in T036 rather than applied silently.
  const degraded = credentialSource === 'auto';
  const done = (outcome, detail, channel, summary) => ({
    outcome,
    detail: detail ?? null,
    channel: channel ?? null,
    degraded: degraded && outcome === OUTCOME.PUBLISHED,
    summary: redactForPublication(summary),
    // A stable, greppable line. The bundle is the API-readable channel, but on the no-credential
    // path NO bundle can exist — so this is what a human reading the web UI has, and it must be
    // searchable rather than buried in prose.
    signal: `digest-outcome=${outcome}${detail ? `:${detail}` : ''}`,
  });

  if (!gate?.publish) {
    return done(OUTCOME.NOT_NEEDED, null, null, `no digest was needed — ${gate?.reason ?? 'the job did not fail'}`);
  }
  if (!tokenPresent) {
    return done(
      OUTCOME.FAILED,
      'no-credential',
      null,
      'the digest ran and collected evidence, but no usable credential was available to publish it. ' +
        'Check whether this run had Actions secrets at all — an AGit-headed run has none.',
    );
  }
  if (publishResult?.published) {
    const via = publishResult.channel ?? 'unknown channel';
    return done(
      OUTCOME.PUBLISHED,
      null,
      publishResult.channel ?? null,
      degraded
        ? `digest published via ${via} using the run's automatically-provisioned token — the `
          + 'purpose-scoped CI_DIGEST_TOKEN was absent, so this is the DEGRADED channel: the failing '
          + "step's name and a short excerpt, not the full bundle. Check whether this run had Actions "
          + 'secrets at all.'
        : `digest published via ${via}`,
    );
  }
  const detail = classifyFailure(publishResult?.reason);
  return done(
    OUTCOME.FAILED,
    detail,
    null,
    `the digest ran and FAILED to publish (${detail}) — ${publishResult?.reason ?? 'no reason reported'}`,
  );
}

// --- Fallback channel: the commit status (US4, FR-014) -------------------------------------------

/** A commit-status description is short. Measured Forgejo limit is 255; stay under it. */
export const STATUS_DESCRIPTION_MAX = 255;

/**
 * Truncate to `max`, visibly, and NEVER inside a redaction placeholder.
 *
 * The placeholder rule has teeth. `<redacted-anthropic-key>` cut at `<redacted-anth` is merely
 * noise, but the reason to forbid it is structural: a future placeholder that WRAPS a value rather
 * than replacing it would leak its tail when severed, and "half a redaction" is worse than none
 * because it still looks redacted. So the cut is pulled back to before any unterminated `<redacted…`.
 *
 * Truncation must also never *fail* the publication (FR-014) — losing the whole signal to protect a
 * size limit is the wrong trade.
 */
export function truncateForStatus(text, max = STATUS_DESCRIPTION_MAX) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const ellipsis = '…';
  let cut = max - ellipsis.length;
  // If the cut lands inside an unterminated placeholder, pull back to before it opened.
  const head = s.slice(0, cut);
  const lastOpen = head.lastIndexOf('<redacted');
  if (lastOpen !== -1 && !/^<redacted[a-z-]*>/.test(head.slice(lastOpen))) cut = lastOpen;
  return s.slice(0, Math.max(0, cut)) + ellipsis;
}

/**
 * Choose the excerpt the fallback carries: the one belonging to the FAILING STEP.
 *
 * MEASURED IN CI (guardrails run #1628, the SC-004/SC-005 rehearsal). The first implementation took
 * `excerpts.at(-1)` and published:
 *
 *   ci-digest/okf  "CI failure: okf / okf-deliberate-breakage — ! Corepack is about to download …"
 *
 * The step name was right and the excerpt came from a different step entirely. A reader sees install
 * output offered as the evidence for a named failure and concludes the install broke. That is worse
 * here than in the digest, because the fallback carries exactly ONE excerpt and there is no bundle to
 * check it against.
 *
 * When the failing step has NO captured log, this returns '' rather than someone else's tail —
 * attributing another step's output to it is actively misleading, and silence is the honest answer.
 * Only when the failing step is genuinely UNKNOWN does it degrade to the last excerpt.
 */
export function selectFallbackExcerpt(excerpts = [], step = '') {
  if (!excerpts.length) return '';
  if (!step) return String(excerpts.at(-1)?.text ?? '');
  const mine = excerpts.find((e) => String(e.source) === `step:${step}`);
  return mine ? String(mine.text ?? '') : '';
}

/**
 * The fallback status body. The failing STEP is the single most useful fact — an excerpt without it
 * sends the reader hunting — so it leads, and the excerpt fills whatever room is left.
 *
 * Never returns empty: a blank description is indistinguishable from no status at all, which is the
 * exact ambiguity this whole story removes.
 */
export function buildStatusDescription({ job = '', step = '', excerpt = '' } = {}, max = STATUS_DESCRIPTION_MAX) {
  const where = step ? `${job} / ${step}` : `${job || 'job'} (failing step not reported)`;
  const head = `CI failure: ${where}`;
  const body = String(excerpt ?? '').replace(/\s+/g, ' ').trim();
  if (!body) return truncateForStatus(head, max);
  return truncateForStatus(`${head} — ${body}`, max);
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
  const gate = shouldPublish({ runStatus: context.runStatus, jobStatus: context.jobStatus ?? '' });
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

/**
 * Choose and ORDER the evidence files to collect.
 *
 * The first version took `.slice(0, 6)` of an alphabetically-sorted `.log` list. On run 992 that
 * kept keycloak and mongo and dropped mc-service, mcm-bff-service-nonsecure and every
 * movie-assistant-* log — precisely the services that were unhealthy. It also never collected
 * `_ps.txt`, the one table showing which containers exited.
 *
 * Now: collect everything, ordered so the most diagnostic sources win the fair-share allocation —
 * the container status table, then unhealthy containers, then compose-level logs, then the rest.
 */
export function selectSources(names, unhealthyContainers = []) {
  const rank = (n) => {
    // Step output FIRST. What the failing step actually printed — the assertion, the stack trace,
    // the pytest summary — outranks any container log. Three consecutive app-e2e failures were
    // undiagnosable from a digest precisely because nothing collected it (T041).
    if (n.startsWith('step:')) return 0;
    if (n === '_ps.txt') return 1;
    const base = n.replace(/\.log$/, '');
    if (unhealthyContainers.includes(base)) return 2;
    if (n.startsWith('_')) return 3;
    return 4;
  };
  return names
    .filter((n) => n.endsWith('.log') || n === '_ps.txt')
    .map((name) => ({ name, rank: rank(name) }))
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
}

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
/** The per-run directory scripts/ci-log-step.sh mirrors step output + the failing-step marker to. */
function stepLogDir(env = process.env, home = env.HOME ?? '') {
  return join(env.CI_STEP_LOG_ROOT || join(home, 'mcm-ci-step-logs'), env.GITHUB_RUN_ID || 'local');
}

/** The first wrapped step that failed, recorded by ci-log-step.sh — or null if none was wrapped. */
export function readFailingStep(env = process.env, home = env.HOME ?? '') {
  const marker = join(stepLogDir(env, home), '_failed-step');
  try {
    return existsSync(marker) ? (readFileSync(marker, 'utf8').trim() || null) : null;
  } catch {
    return null;
  }
}

export function collectEvidence({ home = process.env.HOME ?? '', cwd = process.cwd(), env = process.env } = {}) {
  const excerpts = [];
  const health = [];
  const absent = [];

  // Per-step output written by scripts/ci-log-step.sh, scoped by run id so a PERSISTENT runner
  // cannot leak a previous run's logs into this digest.
  const stepDir = stepLogDir(env, home);
  if (existsSync(stepDir)) {
    let stepFiles = [];
    try {
      stepFiles = readdirSync(stepDir).filter((n) => n.endsWith('.log'));  // _failed-step is not a .log
    } catch {
      absent.push('step output directory could not be read');
    }
    for (const name of stepFiles) {
      const text = readIfPresent(join(stepDir, name));
      if (text) excerpts.push({ source: `step:${name.replace(/\.log$/, '')}`, text });
    }
    if (!stepFiles.length) absent.push('step output — the directory exists but is empty');
  } else {
    absent.push(
      'step output — no step in this job was wrapped with scripts/ci-log-step.sh ' +
        '(only instrumented steps mirror their output; see docs/runbooks/ci-diagnostics.md)',
    );
  }

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
    const unhealthy = health.filter((h) => h.status !== 'healthy').map((h) => h.container);
    for (const { name } of selectSources(entries, unhealthy)) {
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
/**
 * Max-min fair allocation of `cap` bytes across sources of the given sizes.
 * Sources under their fair share keep everything and donate the surplus; only the greedy ones are
 * trimmed. Guarantees no source receives zero while another retains content.
 */
export function allocateFairly(sizes, cap) {
  const order = sizes.map((s, i) => ({ s, i })).sort((a, b) => a.s - b.s);
  const out = new Array(sizes.length).fill(0);
  let remaining = cap;
  let left = order.length;
  for (const { s, i } of order) {
    const share = Math.floor(remaining / left);
    const give = Math.min(s, share);
    out[i] = give;
    remaining -= give;
    left -= 1;
  }
  return out;
}

export function buildBundleManifest(files, { cap = BUNDLE_CAP_BYTES, absent = [], context = {}, digestMarkdown = null } = {}) {
  // digest.md first: for a non-PR failure the bundle is the ONLY place the digest exists, so it must
  // survive the size cap. It is small, and the cap trims the largest source first.
  const kept = [...(digestMarkdown ? [{ path: 'digest.md', text: String(digestMarkdown) }] : []), ...files].map((f) => ({ ...f }));
  const truncatedSources = [];
  const size = (f) => Buffer.byteLength(f.text, 'utf8');

  // MAX-MIN FAIR allocation. The previous version trimmed the largest source by half each pass,
  // which terminated but was not fair: `min(size - excess, size/2)` goes negative once the excess
  // exceeds a file's size, so the target became 0 and the file was ZEROED. Measured on run 992 —
  // mongo's 20 MB crowded the 5 MB cap and `_mcm-stack.log`, the most useful source in the bundle,
  // was trimmed to nothing while mongo kept megabytes of noise.
  //
  // Max-min fair: every source is guaranteed an equal share; anything under its share keeps ALL of
  // its content and donates the remainder to the greedy ones. A small log is never sacrificed for a
  // large one.
  const shares = allocateFairly(kept.map(size), cap);
  kept.forEach((f, i) => {
    if (size(f) > shares[i]) {
      f.text = tailBytes(f.text, shares[i]); // keep the TAIL — failures surface last
      if (!truncatedSources.includes(f.path)) truncatedSources.push(f.path);
    }
  });

  return {
    files: kept,
    meta: {
      ...context,
      truncated: truncatedSources.length > 0,
      truncatedSources,
      absent: absent.map((a) => redactExcerpt(String(a)).text),
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
    step: env.CI_DIGEST_FAILING_STEP || readFailingStep(env) || '',
    sha: env.GITHUB_SHA ?? '',
    runId: env.GITHUB_RUN_ID ?? '',
    event: env.GITHUB_EVENT_NAME ?? 'push',
    pr,
    // Default to '' (unknown), NOT 'failure'. If the env is dropped, an unknown status must NOT
    // trigger a publish — a spurious failure digest on a GREEN run is worse than a missing one, and
    // the coverage gate (check-ci-digest-coverage.mjs) now REQUIRES CI_DIGEST_JOB_STATUS so a real
    // failure always carries it. cancelled-run suppression rides on job.status: act_runner reports
    // `cancelled` here for a superseded job (documented assumption — verify on the first real cancel).
    jobStatus: env.CI_DIGEST_JOB_STATUS ?? '',
    runStatus: env.CI_DIGEST_RUN_STATUS ?? env.CI_DIGEST_JOB_STATUS ?? '',
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

async function fetchWithTimeout(url, opts = {}, ms = Number(process.env.CI_HTTP_TIMEOUT_MS) || 30000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

function httpApi({ base, owner, repo, token }) {
  const call = async (method, path, body) => {
    const res = await fetchWithTimeout(`${base}${path}`, {
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
    const res = await fetchWithTimeout(url, {
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
    // Re-added by feature 051 US4. It was removed in 042's T040 because the endpoint 403'd for
    // CI_DIGEST_TOKEN — but T034 measured that the run's AUTOMATICALLY-PROVISIONED token is allowed
    // to write it, which is a different credential with different scopes. This is the fallback's
    // only channel, so it is deliberately narrow: one short description, no body.
    createStatus: (sha, description, context) =>
      call('POST', `/repos/${owner}/${repo}/statuses/${sha}`, { state: 'failure', description, context }),
    updateComment: (id, body) => call('PATCH', `/repos/${owner}/${repo}/issues/comments/${id}`, { body }),
  };
}

async function run() {
  const context = readJobContext();
  const gate = shouldPublish({ runStatus: context.runStatus, jobStatus: context.jobStatus });

  // Emit the outcome on EVERY path, including the ones that used to return silently. `emitOutcome`
  // is deliberately dumb and unconditional: the failure this closes was a path that returned without
  // saying anything, so anything conditional here would be the same bug with a new shape.
  const emitOutcome = (o) => {
    console.log(`[ci-failure-digest] ${o.signal} — ${o.summary}`);
    return o;
  };

  if (!gate.publish) {
    emitOutcome(describeOutcome({ gate }));
    console.log(`[ci-failure-digest] nothing to publish — ${gate.reason}`);
    return;
  }

  const evidence = collectEvidence();

  // COUNTS MODE (054 US2, item #167). A green run published nothing, so its counts and retry churn
  // could only be read by making the job fail. This branch returns before the digest is built: a
  // passing job has no failure to describe, and the whole point is that it stays cheap.
  if (gate.mode === 'counts') {
    await publishCounts({ context, evidence, gate, emitOutcome });
    return;
  }

  const digest = buildDigest(context, evidence);

  const credential = selectCredential();
  if (!credential.token) {
    // BOTH credentials absent. Nothing can be published — including, without this line, the fact
    // that nothing could be published. Say so in a form a human can find in the web UI, then still
    // print the digest inline so the evidence is not simply discarded. Never fail the job.
    emitOutcome(describeOutcome({ gate, tokenPresent: false }));
    console.log('[ci-failure-digest] no usable credential (CI_DIGEST_TOKEN and the run token are both empty) — printing the digest inline instead.');
    console.log(digest.markdown);
    return;
  }

  // DEGRADED PATH (US4). The purpose-scoped credential is gone, so the rich channels — a PR comment
  // and the evidence bundle — are out of reach: both need scopes the run token does not have. What
  // it CAN do, measured in T034, is write a commit status. So publish the one fact that matters most
  // (which step failed, plus a short excerpt) and stop, rather than throwing the diagnosis away as
  // 2026-08-01 did.
  if (credential.source === 'auto') {
    const api = httpApi({ ...forgeEndpoint(), token: credential.token });
    const description = buildStatusDescription({
      job: context.job,
      step: context.step,
      excerpt: redactForPublication(selectFallbackExcerpt(evidence.excerpts, context.step)),
    });
    let result;
    try {
      await api.createStatus(context.sha, description, `ci-digest/${context.job}`);
      result = { published: true, channel: 'commit-status' };
    } catch (err) {
      result = { published: false, reason: redactForPublication(String(err?.message ?? err)) };
    }
    emitOutcome(describeOutcome({ gate, tokenPresent: true, credentialSource: 'auto', publishResult: result }));
    console.log('::group::ci-failure-digest (inline copy — degraded channel, no bundle)');
    console.log(digest.markdown);
    console.log('::endgroup::');
    return;
  }

  const api = httpApi({ ...forgeEndpoint(), token: credential.token });

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
  // The bundle is the channel the forge API can actually READ (obligation 1) — a job log is visible
  // to a human in the web UI and to nothing else, which is how the original failure stayed invisible.
  // Recorded BEFORE the upload for the obvious reason that a bundle cannot contain the outcome of
  // its own upload; if that upload fails there is no bundle to read, and the log line below is the
  // only surviving signal. That asymmetry is why the log line exists as well as the bundle field.
  context.digestOutcome = describeOutcome({ gate, tokenPresent: true, publishResult: result });

  let bundleError = null;
  await publishBundle(api, version, evidence, context, result, withBundle.markdown).catch((err) => {
    bundleError = redactForPublication(String(err?.message ?? err));
    console.error(`[ci-failure-digest] bundle upload suppressed: ${bundleError}`);
  });

  // ON A NON-PR EVENT THE BUNDLE *IS* THE PUBLICATION (see publishDigest — the commit status was
  // removed in T040 because the endpoint needs write:repository and 403s). So `publishDigest`
  // returning `{published: true, channel: 'bundle'}` is a statement of INTENT, not of arrival: it
  // has contacted nothing at that point. If the upload then fails, the digest reached no channel at
  // all, and reporting `published` would be precisely the false signal this story removes — found
  // by the test that forces a dead transport and expects `failed`.
  const effective =
    result.published && result.channel === 'bundle' && bundleError
      ? { published: false, reason: `bundle upload failed: ${bundleError}` }
      : result;
  const outcome = emitOutcome(describeOutcome({ gate, tokenPresent: true, publishResult: effective }));
  console.log(
    effective.published
      ? `[ci-failure-digest] published via ${effective.channel} (bundle ${version})`
      : `[ci-failure-digest] NOT PUBLISHED — ${effective.reason}`,
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

/**
 * Publish a PASSING job's counts (054 US2, item #167).
 *
 * Deliberately not the digest path: no PR comment, no health blocks, no container logs — a green run
 * has no failure to describe, and a channel that is expensive on every run is a channel that gets
 * turned off. What it carries is the `[e2e-gate]` counts and the contention tally, which is the
 * difference between "nothing failed" and "nothing failed and nothing needed its retry".
 *
 * Publishing here can only ADD a package version; it never comments, never sets a status, and never
 * touches the job's result.
 */
async function publishCounts({ context, evidence, gate, emitOutcome }) {
  const sources = selectCountsSources(evidence.excerpts);

  // The counts go to the job log FIRST and unconditionally. A human can read that in the browser
  // even when publication fails, and it costs nothing — the same reasoning as the digest's inline
  // copy, applied to the case that previously produced no output at all.
  for (const s of sources) console.log(`[ci-failure-digest] ${s.source}\n${s.text.trim()}`);

  if (!sources.length) {
    emitOutcome(describeOutcome({ gate: { publish: false, reason: 'the job passed and produced no counts sources' } }));
    console.log('[ci-failure-digest] counts mode — this job runs no e2e counts steps; nothing to publish.');
    return;
  }

  const credential = selectCredential();
  if (credential.source !== 'purpose-scoped') {
    // The package registry needs the purpose-scoped credential; the run-provisioned token can only
    // write a commit status, which cannot carry these lines. Say so rather than failing quietly —
    // the counts are already in the job log above, so nothing is lost, only narrowed.
    emitOutcome(describeOutcome({
      gate,
      tokenPresent: Boolean(credential.token),
      credentialSource: credential.source ?? 'auto',
      publishResult: { published: false, reason: 'counts need the purpose-scoped credential to upload a package' },
    }));
    return;
  }

  const api = httpApi({ ...forgeEndpoint(), token: credential.token });
  const version = bundleVersion(context.runId, context.job);
  let result;
  try {
    await publishBundle(api, version, { excerpts: sources, health: [], absent: evidence.absent }, context);
    result = { published: true, channel: 'counts-bundle' };
  } catch (err) {
    result = { published: false, reason: redactForPublication(String(err?.message ?? err)) };
  }
  emitOutcome(describeOutcome({ gate, tokenPresent: true, publishResult: result }));
  console.log(
    result.published
      ? `[ci-failure-digest] counts published (bundle ${version})`
      : `[ci-failure-digest] counts NOT published — ${result.reason}`,
  );

  // Retention runs on THIS path too. Publishing on every green run — not only on failures — is
  // exactly what makes unbounded growth reachable, so the pruning that made the failure-only channel
  // safe has to follow the channel that replaced it.
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
      // The same fact in the three-way vocabulary `ci-status failure` renders from (FR-010). `publish`
      // above is kept as-is rather than replaced: existing bundles carry it, and a reader comparing
      // an old bundle with a new one should not have to work out which field superseded which.
      digestOutcome: context.digestOutcome ?? null,
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
