#!/usr/bin/env node
// Item #311 — the weekly Renovate health digest.
//
// WHY THIS EXISTS. Renovate's failure mode on this forge is ABSENCE, and absence reads as "nothing
// to do": a channel whose toolchain is missing dies to one suppressed WARN line, for ever (#218); a
// surviving merged branch turns a dashboard tick into an empty PR and a wasted ~35-minute CI cycle
// (#290); open PRs silently eat next week's prConcurrentLimit; and a pending stability-days is
// indistinguishable from a dead one without going and looking (#298). Each of those was discovered
// by incident, sessions after it started. This job goes and looks, once a week, and writes what it
// found where the operator already reads.
//
// DESIGN, inherited from check-lockfile-refresh.mjs (the proven pattern):
//   - comment-only, ALWAYS exit 0 — a weekly red trains people to ignore it; the comment IS the report
//   - always comments, even when healthy (one line) — so silence means the JOB died, which is itself
//     the signal; absence must never read as health, that being the root fault this digest exists for
//   - self-stopping: no-ops once item #311 is closed. CLOSING #311 IS THE KILL SWITCH.
//   - reads the Dependency Dashboard (#29); NEVER writes it — ticking is the only sanctioned
//     interaction with #29 and this script does not tick
//
// Usage:
//   node scripts/renovate-health.mjs             # post the digest to item #311
//   node scripts/renovate-health.mjs --dry-run   # exercise every read + render, post nothing

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// Item #485 — the required-context read this digest was not doing. Both are pure and already
// exported; ci-status.mjs guards its own entrypoint, so importing it runs nothing.
import { parseRequiredGlobs, computeMergeVerdict } from './ci-status.mjs';
// Item #500 — the shared argument contract. THIS SCRIPT'S DEFAULT ACTION WRITES TO THE PUBLIC
// TRACKER, so a silently-ignored flag is not a usability wart here: `--dryrun`, `--dry_run` and
// `-dry-run` each used to mean "post the comment", with an exit code identical to the intended run's.
import { ArgvError, dieOnArgvError, partitionArgs, wantsHelp } from './lib/argv-contract.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ITEM = 311; // the digest's home — close it to stop the digest
const DASHBOARD = 29; // Renovate's Dependency Dashboard — READ ONLY here
const STABILITY_CONTEXT = 'renovate/stability-days';
const BRANCH_PREFIX = 'renovate/';
const PROTECTED_BRANCH = 'main';
// The weekly CVE sweep. Its `main` run gates every infra-touching PR, and it posts no required
// context of its own — see selectNewestScheduledRun() for why this digest goes and reads it.
const SWEEP_WORKFLOW = 'infra-image-scan.yml';

// ── Pure logic (unit-tested in __tests__/renovate-health.test.mjs) ───────────

/**
 * The `## Repository problems` section of the dashboard body, warnings only. This is the ONE place
 * a dead channel is visible at all — Renovate suppresses the underlying rejection to a single WARN
 * line here and the channel then simply never appears (§5 of the runbook, item #218).
 */
export function parseRepositoryProblems(body) {
  const text = String(body ?? '');
  const m = text.match(/^##\s+Repository problems\s*$([\s\S]*?)(?=^##\s|\n*$(?![\s\S]))/im);
  if (!m) return [];
  return m[1]
    .split('\n')
    .map((l) => l.replace(/^\s*-\s*/, '').trim())
    .filter((l) => l.includes('WARN') || l.includes('ERROR'));
}

/**
 * Classify every renovate/* branch by ancestry against main.
 *   ancestor + open PR   → an EMPTY PR (the #288 shape: a stale branch reused verbatim)
 *   ancestor + no PR     → a stale ref (the #290 class — the repo setting covers UI merges only)
 *   not ancestor         → active pending work (normal)
 *   ancestry unanswerable→ reported, never dropped — a guard that silently skips what it cannot
 *                          read is the fault this file exists to prevent
 */
export function classifyRenovateBranches(branches, openPrHeads, isAncestor) {
  const out = { emptyPr: [], stale: [], active: [], unknown: [] };
  for (const b of branches) {
    if (!b.startsWith(BRANCH_PREFIX)) continue;
    const anc = isAncestor(b);
    if (anc === null || anc === undefined) out.unknown.push(b);
    else if (anc && openPrHeads.has(b)) out.emptyPr.push(b);
    else if (anc) out.stale.push(b);
    else out.active.push(b);
  }
  return out;
}

/** Open Renovate PRs consume prConcurrentLimit — leaving four unmerged caps the next window at one. */
export function budget(config, openRenovatePrs) {
  const limit = Number(config?.prConcurrentLimit ?? 0);
  const open = openRenovatePrs.length;
  return { limit, open, headroom: Math.max(0, limit - open) };
}

/** One row per open Renovate PR: its stability-days state, or `absent` when no such context exists. */
export function stabilityRows(prs, statusesBySha) {
  return prs.map((pr) => {
    const statuses = statusesBySha[pr.head?.sha] ?? [];
    const st = statuses.find((s) => s.context === STABILITY_CONTEXT);
    return {
      number: pr.number,
      title: pr.title,
      created_at: pr.created_at,
      stability: st ? (st.status ?? st.state ?? 'unknown') : 'absent',
    };
  });
}

/**
 * Open Renovate PRs that a REQUIRED context is currently blocking (item #485).
 *
 * WHY THIS READ WAS MISSING AND WHAT IT COST. This digest read exactly one context —
 * `renovate/stability-days`, which is ADVISORY — and rendered it in a table whose only verdict
 * column says `success`. On 2026-09-18 at 11:57:15Z run 3562 posted "✅ Healthy" to item #311 while
 * `main` had been failing a required gate since 07:02:22Z (five hours) and listed PR #478, which was
 * unmergeable on exactly that failure, under a column reading `success`. The digest was not wrong
 * about what it looked at. It looked at the wrong thing.
 *
 * This is the SECOND occurrence with a DIFFERENT cause — the digest previously reported Healthy with
 * two red Renovate PRs on 2026-09-04 (runbook §5). That one was about PRs being red; the sweep half
 * of this item is about `main` being red. Neither fix covers the other, so both are here.
 *
 * @param {object[]} prs open Renovate PRs
 * @param {Record<string, object[]>} statusesBySha the combined-status list per head sha
 * @param {string[]|null} requiredGlobs from branch protection; null means "could not read"
 * @returns {{number:number,title:string,contexts:string[]}[]} one row per blocked PR
 */
export function blockedRequiredRows(prs, statusesBySha, requiredGlobs) {
  // null means the protection read failed. Returning [] would render "nothing is blocked", which is
  // precisely the absence-reads-as-health fault this whole file exists to prevent — so the caller
  // reports the unknown instead, and this never manufactures a clean answer from a failed read.
  if (!Array.isArray(requiredGlobs) || requiredGlobs.length === 0) return [];
  const out = [];
  for (const pr of prs) {
    const statuses = statusesBySha[pr.head?.sha] ?? [];
    if (!statuses.length) continue;
    // Reuse the gate logic verbatim rather than re-deriving it — a second, subtly different notion
    // of "required" is how the hand-maintained mirror drifted in the first place.
    const verdict = computeMergeVerdict(statuses, { requiredGlobs, event: 'pull_request' });
    const blocking = verdict.gate?.blocking ?? verdict.blocking ?? [];
    if (blocking.length) {
      out.push({ number: pr.number, title: pr.title, contexts: blocking.map((c) => c.job ?? c.context) });
    }
  }
  return out;
}

/**
 * The newest SCHEDULED run of a workflow, from a page of the runs API (item #485).
 *
 * THE #418 TRAP, RE-MEASURED 2026-09-19 AND STILL TRUE: the runs API reports `event` = "push" on
 * every scheduled run. It is NOT the trigger. The same record carries `trigger_event` = "schedule",
 * and that is the field to filter on. Filtering on `event` finds nothing and reads as "the sweep
 * never ran".
 *
 * FOUR MEASURED QUIRKS OF THIS ENDPOINT, recorded so they are not re-derived (2026-09-19, Forgejo
 * 15.0.3+gitea-1.22.0). They are the reason the caller's query looks over-specified:
 *   1. `?limit=N` ALONE IS IGNORED — `?limit=3` returned all 3614 runs (371 KB). It works only when
 *      paired with `?page=`.
 *   2. `?trigger_event=schedule` IS SILENTLY IGNORED and returns the UNFILTERED set — 3614 runs
 *      across every workflow. An unknown filter reading as "matched everything" is the same trap
 *      the label filters have; this is why the filter below is applied CLIENT-SIDE.
 *   3. `?workflow_id=<file>` IS a real server-side filter, and the value is the workflow FILE NAME.
 *   4. `/actions/workflows/<file>/runs` is 404 on this build — it does not exist.
 *
 * @param {object[]} runs a page of workflow_runs
 * @param {string} workflowId the workflow FILE NAME, e.g. 'infra-image-scan.yml'
 * @returns {object|null} the newest scheduled run, or null when the page carries none
 */
export function selectNewestScheduledRun(runs, workflowId) {
  const matching = (runs ?? []).filter(
    (r) => r?.workflow_id === workflowId && r?.trigger_event === 'schedule',
  );
  if (!matching.length) return null;
  // The API returns newest-first, but sort explicitly rather than relying on it: an ordering change
  // would silently report a months-old sweep as this week's posture.
  return matching.sort((a, b) => Date.parse(b.started ?? 0) - Date.parse(a.started ?? 0))[0];
}

/**
 * `main`'s CURRENT sweep posture — the newest run of the workflow ON `main`, by schedule OR push.
 *
 * WHY THE SCHEDULED RUN ALONE IS NOT THE ANSWER, measured 2026-09-25. The 04:00 cron (run 3946) went
 * red on ONE finding; it was allowlisted and merged at 12:23Z, and the same gate then passed on
 * `main` at 12:33Z (run 3975, a push run, sha 09247f3d). Reading only the scheduled run reports
 * `❌ main is failure` for the six days until the next cron, on a `main` that is green. That is this
 * digest's founding fault in mirror image: item #485 was absence read as health, this is a stale
 * verdict read as live. Both are the digest reporting something other than the posture.
 *
 * A PUSH RUN IS AN EQUALLY AUTHORITATIVE VERDICT, which is what makes this sound rather than merely
 * cheerier. `infra-image-scan.yml` runs the FULL, un-path-gated sweep on every non-`pull_request`
 * event — the path filter is on the push TRIGGER (whether the workflow starts), not on the scan's
 * scope. So a green push run scanned the same image set the cron does. What the push trigger cannot
 * promise is that it ever fires, which is exactly why the cron exists and stays the safety net.
 *
 * `prettyref` IS THE BRANCH DISCRIMINATOR, and it is load-bearing. `head_branch` is null on every
 * run measured on this build; `prettyref` carries `main`, a branch name, or `#557` for a pull
 * request. Without it this would happily adopt a push run on `renovate/docker-base-images` (run
 * 3959, red) or on a feature branch (3965, green) as `main`'s posture — reporting some other
 * branch's verdict as the one every PR inherits, in either direction.
 *
 * Fails closed exactly as before: no usable run is `null`, which `sweepVerdict` renders UNKNOWN and
 * never a pass.
 *
 * @param {object[]} runs a page of workflow_runs
 * @param {string} workflowId the workflow FILE NAME
 * @param {string} [branch] the default branch as `prettyref` spells it
 * @returns {object|null} the newest qualifying run on that branch, or null
 */
export function selectNewestMainSweepRun(runs, workflowId, branch = 'main') {
  const matching = (runs ?? []).filter(
    (r) => r?.workflow_id === workflowId
      && r?.prettyref === branch
      && (r?.trigger_event === 'schedule' || r?.trigger_event === 'push'),
  );
  if (!matching.length) return null;
  return matching.sort((a, b) => Date.parse(b.started ?? 0) - Date.parse(a.started ?? 0))[0];
}

/**
 * Turn that run into a verdict (item #485).
 *
 * `status` carries the TERMINAL verdict on this forge — `conclusion` is undefined on every run
 * measured. Verified against the three runs item #485 names: 3521/failure, 2132/failure,
 * 1948/failure.
 *
 * `null` in means the page carried no scheduled run. That is an UNKNOWN, never a pass: a sweep this
 * digest could not find is exactly the silence it exists to break.
 */
export function sweepVerdict(run, superseded = null) {
  if (!run) {
    return {
      state: 'unknown',
      text: 'no run of this workflow found on `main` in the page read — the sweep may not have run, or the page did not reach back far enough',
    };
  }
  const status = String(run.status ?? '').toLowerCase();
  // NAME THE EVENT. A reader must be able to tell the un-path-gated weekly cron from a push run that
  // happened to touch an infra path, because only the cron is guaranteed to have run at all.
  const trigger = run.trigger_event === 'schedule' ? 'weekly cron' : `${run.trigger_event ?? 'unknown'} run`;
  const where = `run ${run.id} (${trigger}, ${run.started ?? 'unknown time'}, ${String(run.commit_sha ?? '').slice(0, 8)})`;
  // A green push run that SUPERSEDES a red cron is the 2026-09-25 case, and the superseded verdict is
  // reported rather than dropped: "it was red at 04:00 and a fix landed" is the useful sentence, and
  // silently replacing one verdict with the other is how a digest starts hiding things again.
  const supersededText = superseded
    ? ` — supersedes the ${superseded.trigger_event === 'schedule' ? 'weekly cron' : 'earlier'} run ${superseded.id}`
      + ` (${superseded.started ?? 'unknown time'}), which was ${String(superseded.status ?? '<unset>').toUpperCase()}`
    : '';
  if (status === 'failure') return { state: 'failure', text: `${where} is FAILURE${supersededText}`, run, superseded };
  if (status === 'success') return { state: 'success', text: `${where} is success${supersededText}`, run, superseded };
  return { state: 'unknown', text: `${where} reports status=${run.status ?? '<unset>'}`, run, superseded };
}

export function buildDigest({ problems, branches, budgetInfo, rows, blocked = [], sweep = null, requiredGlobs = null }) {
  // Item #485. `✅ Healthy` used to be decided by four branch/dashboard counters alone, so it could
  // be — and on 2026-09-18 was — printed while `main` was five hours into failing a required gate
  // and a listed PR was unmergeable on it. Every signal the line claims to cover must now be in
  // this sum, including the ones whose answer is "I could not tell".
  const requiredUnreadable = !Array.isArray(requiredGlobs) || requiredGlobs.length === 0;
  const sweepBad = sweep && sweep.state !== 'success';
  const anomalies =
    problems.length +
    branches.emptyPr.length +
    branches.stale.length +
    branches.unknown.length +
    blocked.length +
    (sweepBad ? 1 : 0) +
    (requiredUnreadable ? 1 : 0);
  const lines = ['### Weekly Renovate health digest', ''];

  if (anomalies === 0) {
    lines.push(
      '✅ **Healthy.** No repository problems, no empty-PR or stale `renovate/*` branches, ' +
        'no open Renovate PR blocked by a required context, and the CVE sweep on `main` is green.',
    );
    // SAY WHICH RUN THAT WAS. The green verdict may come from a push run rather than the weekly cron
    // (selectNewestMainSweepRun), and "the WEEKLY sweep is green" would then be a claim stronger than
    // the evidence — the digest asserting a guarantee only the cron gives. And when a green push run
    // superseded a RED cron, that is the week's CVE event: it belongs in the digest even though
    // nothing is wrong now, because dropping it is how this digest started hiding things (item #485).
    if (sweep?.run) lines.push('', `  Read from ${sweep.text}.`);
  }

  if (sweepBad) {
    const verdict = sweep.state === 'failure' ? '❌' : '⚠️';
    lines.push(
      `${verdict} **The weekly CVE sweep on \`main\` is ${sweep.state}** — ${sweep.text}.`,
      '',
      sweep.state === 'failure'
        ? '  `main` is failing a gate that every infra-touching PR inherits, so a Renovate PR can be ' +
          'unmergeable for a CVE with no bearing on its own diff (the PR #478 shape, item #487). ' +
          'A scheduled run posts no required context, which is why this digest goes and reads the run.'
        : '  This is an UNKNOWN, not a pass — a sweep whose verdict cannot be read is the silence ' +
          'this digest exists to break.',
      '',
    );
  }

  if (blocked.length) {
    lines.push(
      '❌ **Open Renovate PRs blocked by a REQUIRED context** — these cannot merge, whatever ' +
        '`stability-days` says below:',
      '',
    );
    for (const b of blocked) {
      lines.push(`- #${b.number} — ${b.title} → \`${b.contexts.join('`, `')}\``);
    }
    lines.push('');
  }

  if (requiredUnreadable) {
    lines.push(
      '⚠️ **Could not read branch protection**, so no PR was checked against the REQUIRED set — ' +
        'the `stability-days` column below is advisory only and proves nothing about mergeability.',
      '',
    );
  }

  if (problems.length) {
    lines.push('❌ **Repository problems on the dashboard** — a channel may be dead (runbook §5):', '');
    for (const p of problems) lines.push(`- ${p}`);
    lines.push('');
  }
  if (branches.emptyPr.length) {
    lines.push(
      `⚠️ **Empty-PR branches** (ancestor of \`main\` with an open PR — the #288 shape; leave for autoclose, cancel the CI runs if in the way — runbook §4): ${branches.emptyPr.map((b) => `\`${b}\``).join(', ')}`,
      '',
    );
  }
  if (branches.stale.length) {
    lines.push(
      `⚠️ **Stale refs** (ancestor of \`main\`, no open PR — the #290 class; the repo setting covers UI merges only): ${branches.stale.map((b) => `\`${b}\``).join(', ')}`,
      '',
    );
  }
  if (branches.unknown.length) {
    lines.push(
      `⚠️ **Ancestry unanswerable** (shallow clone? deleted upstream mid-run?): ${branches.unknown.map((b) => `\`${b}\``).join(', ')}`,
      '',
    );
  }

  lines.push(
    '',
    `**Budget**: ${budgetInfo.open} open Renovate PR(s) of \`prConcurrentLimit: ${budgetInfo.limit}\` — headroom **${budgetInfo.headroom}** for the next window. Merging promptly is a throughput lever (runbook §1).`,
  );
  if (branches.active.length) {
    lines.push('', `Active pending branches: ${branches.active.map((b) => `\`${b}\``).join(', ')}`);
  }

  if (rows.length) {
    lines.push(
      '',
      '**Open Renovate PRs and their `stability-days` state** (the item #298 observation). NOTE this ' +
        'column is the ADVISORY check only — a `success` here says nothing about whether the PR can ' +
        'merge; the required set is reported above (item #485):',
      '',
    );
    lines.push('| PR | created | stability-days |', '|---|---|---|');
    for (const r of rows) lines.push(`| #${r.number} — ${r.title} | \`${r.created_at}\` | ${r.stability} |`);
  }

  lines.push('', '_`scripts/renovate-health.mjs` — close item #311 to stop this digest._');
  return lines.join('\n');
}

// ── I/O ──────────────────────────────────────────────────────────────────────

const api = (base, token) => async (method, path, body) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `token ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
};

/** Renovate-authored: renovate/* head, or the Mend footer for reused refs/pull heads. */
function isRenovatePr(pr) {
  return (
    String(pr?.head?.ref ?? '').startsWith(BRANCH_PREFIX) ||
    String(pr?.body ?? '').includes('Mend Renovate')
  );
}

function gitIsAncestor(branch) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', `origin/${branch}`, 'origin/main'], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
    });
    return true;
  } catch (err) {
    if (err?.status === 1) return false; // a real answer: not an ancestor
    return null; // could not answer (missing ref, shallow clone) — reported, never dropped
  }
}

/** @param {'post'|'dry-run'} command — resolved by resolveCommand(), never re-read from process.argv. */
async function main(command = 'post') {
  const token = process.env.CI_DIGEST_TOKEN?.trim() || process.env.MCM_FORGE_ISSUE_TOKEN?.trim();
  if (!token) {
    // Loudly, but exit 0: an absent Actions secret must not read as a verdict.
    console.error('[renovate-health] no CI_DIGEST_TOKEN — cannot read the forge or comment. Exiting 0 WITHOUT a digest.');
    return;
  }
  const server = (process.env.GITHUB_SERVER_URL ?? '').replace(/\/$/, '');
  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? 'jumbleknot/mcm').split('/');
  const call = api(`${server}/api/v1`, token);

  const item = await call('GET', `/repos/${owner}/${repo}/issues/${ITEM}`);
  if (item.state !== 'open') {
    console.log(`[renovate-health] item #${ITEM} is ${item.state} — the digest is switched off. Exiting 0.`);
    return;
  }

  const config = JSON.parse(readFileSync(resolve(REPO_ROOT, 'renovate.json'), 'utf8'));
  const dashboard = await call('GET', `/repos/${owner}/${repo}/issues/${DASHBOARD}`);
  const problems = parseRepositoryProblems(dashboard.body);

  const openPrs = (await call('GET', `/repos/${owner}/${repo}/pulls?state=open&limit=50`)).filter(isRenovatePr);
  const openPrHeads = new Set(openPrs.map((p) => p.head?.ref).filter(Boolean));

  const branchNames = (await call('GET', `/repos/${owner}/${repo}/branches?limit=50`)).map((b) => b.name);
  const branches = classifyRenovateBranches(branchNames, openPrHeads, gitIsAncestor);

  const statusesBySha = {};
  for (const pr of openPrs) {
    const sha = pr.head?.sha;
    if (!sha) continue;
    // The combined-status endpoint carries every context on the sha; stability-days included.
    statusesBySha[sha] = (await call('GET', `/repos/${owner}/${repo}/commits/${sha}/status`)).statuses ?? [];
  }
  const rows = stabilityRows(openPrs, statusesBySha);

  // ── Item #485, half one: which open PRs a REQUIRED context is blocking. ───────────────────────
  // Degrade to null rather than [] on a failed read — blockedRequiredRows() then reports nothing
  // and buildDigest() counts the unreadable protection as an anomaly, so a missing scope cannot
  // present as "nothing is blocked".
  let requiredGlobs = null;
  try {
    requiredGlobs = parseRequiredGlobs(
      await call('GET', `/repos/${owner}/${repo}/branch_protections`),
      PROTECTED_BRANCH,
    );
  } catch (err) {
    console.error(`[renovate-health] could not read branch protection: ${err.message}`);
  }
  const blocked = blockedRequiredRows(openPrs, statusesBySha, requiredGlobs);

  // ── Item #485, half two: is `main` failing its weekly CVE sweep right now? ────────────────────
  // `workflow_id` is a REAL server-side filter and `page`+`limit` are what make the page size take
  // effect; `trigger_event` is NOT a filter here and is applied client-side by
  // selectNewestScheduledRun. See that function for all four measured quirks — three of them read
  // as "matched everything" or "nothing ran" if trusted. 50 is measured as enough to reach the most
  // recent scheduled sweep past a week of PR runs (run 3521 sat 1 page deep on 2026-09-19), and the
  // absence of one is reported as an UNKNOWN rather than papered over.
  let sweep = sweepVerdict(null);
  try {
    const runs = await call(
      'GET',
      `/repos/${owner}/${repo}/actions/runs?workflow_id=${SWEEP_WORKFLOW}&page=1&limit=50`,
    );
    const page = runs.workflow_runs ?? [];
    // `main`'s posture NOW (schedule or push, on `main` only), with the newest CRON kept as context so
    // a superseded red is reported rather than dropped. See selectNewestMainSweepRun for why a push
    // run is an equally authoritative verdict and why `prettyref` is the discriminator.
    const current = selectNewestMainSweepRun(page, SWEEP_WORKFLOW);
    const cron = selectNewestScheduledRun(page, SWEEP_WORKFLOW);
    const superseded = current && cron && cron.id !== current.id ? cron : null;
    sweep = sweepVerdict(current, superseded);
  } catch (err) {
    console.error(`[renovate-health] could not read the weekly sweep: ${err.message}`);
  }

  const body = buildDigest({
    problems,
    branches,
    budgetInfo: budget(config, openPrs),
    rows,
    blocked,
    sweep,
    requiredGlobs,
  });

  console.log(`[renovate-health] problems=${problems.length} emptyPr=${branches.emptyPr.length} stale=${branches.stale.length} unknown=${branches.unknown.length} openPrs=${openPrs.length} blocked=${blocked.length} sweep=${sweep.state} required=${requiredGlobs?.length ?? 'unreadable'}`);
  if (command === 'dry-run') {
    // Exercises every read and the whole render path, and posts nothing — so the check can be
    // proven working now rather than discovered broken on a Friday.
    console.log('\n──── digest that WOULD be posted ────\n' + body + '\n─────────────────────────────────────');
    return;
  }
  await call('POST', `/repos/${owner}/${repo}/issues/${ITEM}/comments`, { body });
  console.log(`[renovate-health] commented on item #${ITEM}.`);
}

// ── The argument contract (item #500) ────────────────────────────────────────────────────────────

/** Every argument this script accepts. Anything else is an ERROR — see resolveCommand. */
export const ACCEPTED_FLAGS = ['--dry-run', '--help', '-h'];

export const USAGE = `renovate-health.mjs — the weekly Renovate health digest (item #311).

  node scripts/renovate-health.mjs             POST the digest as a comment on item #311 — the default
  node scripts/renovate-health.mjs --dry-run   render the digest to stdout and post NOTHING
  node scripts/renovate-health.mjs --help      this text

A bare invocation POSTS PUBLICLY. That is what .forgejo/workflows/renovate-health.yml runs weekly.`;

/**
 * Resolve argv into the action to take — and REJECT anything not recognised.
 *
 * WHY A PURE FUNCTION rather than the `process.argv.includes('--dry-run')` it replaces. That test
 * lived inline in main(), which meant the SAFE mode required an exact spelling while the mode that
 * writes to the public tracker was what every other input produced. `--dryrun` posted. `--dry_run`
 * posted. `-dry-run` posted. So did `--help`. And because this script always exits 0 by design, the
 * typo'd run was indistinguishable from the intended one in both output and exit code.
 *
 * The rejection is deliberately NOT laundered through that exit-0 discipline — see dieOnArgvError.
 *
 * @returns {{command: 'help'|'dry-run'|'post'}}
 * @throws {ArgvError} when any argument is not in ACCEPTED_FLAGS
 */
export function resolveCommand(argv = []) {
  const args = (argv ?? []).filter((a) => a !== '');
  // Help wins outright: someone asking what this does must never trigger what it does.
  if (wantsHelp(args)) return { command: 'help' };
  const { flags } = partitionArgs(args, { accepted: ACCEPTED_FLAGS, maxPositionals: 0, usage: USAGE });
  return { command: flags.has('--dry-run') ? 'dry-run' : 'post' };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Argv is resolved OUTSIDE the catch below, on purpose. main()'s failures exit 0 (a weekly red
  // trains people to ignore the digest), but a mistyped flag is a CALLER error, not a digest
  // failure — routing it through the exit-0 discipline is exactly what made the typo invisible.
  let command;
  try {
    ({ command } = resolveCommand(process.argv.slice(2)));
  } catch (err) {
    dieOnArgvError(err);
  }
  if (command === 'help') {
    console.log(USAGE);
  } else {
    main(command).catch((err) => {
      // Still exit 0 — see the header. A broken digest must not present as a failed build.
      console.error(`[renovate-health] FAILED to produce a digest: ${err.message}`);
    });
  }
}
