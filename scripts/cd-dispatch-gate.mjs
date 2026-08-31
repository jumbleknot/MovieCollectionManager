#!/usr/bin/env node
// The cd-deploy dispatch gate — app-ci's `trigger-cd` job asks this script whether to deploy.
// Item #230.
//
// WHAT THIS REPLACES, AND WHY IT IS A SCRIPT. `trigger-cd` used to inline the decision:
//
//     const bad = g.filter(([, st]) => st !== "success");
//     if (bad.length) { console.error("::error::guardrails not green: …"); process.exit(1); }
//
// A CANCELLED run reports its contexts as `failure`, so a guardrails run that a newer merge
// superseded — not broke — failed that check and no deploy was dispatched. Measured 2026-08-22:
// PR #217 (app dependency changes) merged, PR #228 merged seconds later and cancelled #217's
// still-running guardrails; the five `guardrails / *` contexts on #217 read `failure` with
// description "Has been cancelled". #228 was config-only, so app-ci was path-filtered out of its
// merge entirely and offered no replacement trigger. #217's changes reached `main` and were never
// deployed, silently — `trigger-cd` is advisory, so nothing went red.
//
// THE SEMANTICS ARE "THE TIP DECIDES", not "tolerate cancelled". Tolerating it would deploy from a
// commit a newer push has already superseded, and that is worse than it sounds: the dispatch sends
// `{"ref":"main"}`, so cd-deploy builds whatever the TIP is — not the sha whose CI was just
// verified. Dispatching from a superseded commit therefore deploys a tree nothing checked.
//
// Four things follow, and each is a decision this file owns:
//   1. Only the effective tip dispatches; an older commit hands off and says so. Exactly once.
//   2. "Effective" excludes `[skip ci]` commits. cd-deploy's own promotion commit is pushed with
//      [skip ci] and becomes the tip while running nothing — treating it as a tip would recreate
//      item #230 with a different second commit.
//   3. The check reuses ci-status.mjs's classification rather than re-deriving it. That module
//      already distinguishes superseded from failed and from path-gated-skipped, and is tested.
//   4. A decision NOT to dispatch is published as a commit status. The incident was invisible for
//      a day because an advisory green job that declined looks identical to one that deployed.
//
// The path knowledge that used to live in app-ci's `push: paths:` filter now lives here as
// DEPLOYABLE_PATHS. It moved rather than disappeared: the filter used to answer "should CI run",
// which starved config-only merges of a trigger-cd (the second half of the incident). app-ci now
// runs on every push to `main`, and the same knowledge answers the question it was always really
// asking — "is there anything to deploy".
//
// Authoritative tests: scripts/__tests__/cd-dispatch-gate.test.mjs.

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildRunsQuery,
  classifyCheckState,
  collapseToNewestPerContext,
  findRunForContext,
  parseContext,
  selectEventContexts,
} from './ci-status.mjs';
import { redactForPublication } from './ci-digest-redact.mjs';

/** The commit status this job publishes so a declined dispatch is visible without going looking. */
export const STATUS_CONTEXT = 'cd-dispatch / trigger-cd';

/**
 * Paths whose change makes a deploy meaningful — literal prefixes (trailing `/`) or exact files.
 *
 * Migrated from app-ci's `push: paths:` filter, which is why the lockfiles are here: a lockfile bump
 * changes transitive deps, so the images must be rebuilt (feature 058 / item #186 made that case for
 * the filter, and scripts/__tests__/app-ci-lockfile-filter.guard.test.mjs now asserts it here).
 * `scripts/cd/**` and cd-deploy.yml are additions: a change to how the deploy runs should be proven
 * by a deploy rather than by whatever unrelated merge happens next.
 *
 * ERRING WIDE IS DELIBERATE. Too narrow silently fails to deploy an app change — the failure mode
 * this whole file exists to remove. Too wide costs a redundant deploy of an unchanged tree, which
 * is visible and cheap. Add here freely; remove only with a reason.
 */
export const DEPLOYABLE_PATHS = [
  'frontend/',
  'agents/',
  'mcp-servers/',
  'backend/',
  'packages/',
  'infrastructure-as-code/',
  'scripts/cd/',
  '.forgejo/workflows/cd-deploy.yml',
  'Cargo.lock',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'package.json',
  'nx.json',
];

/** The skip markers this forge honours in a commit message. A commit carrying one runs NO workflow,
 *  so it can never carry a deploy and must not be mistaken for the tip. */
export const SKIP_CI_RE = /\[(?:skip[ -]ci|ci[ -]skip|no[ -]ci|skip[ -]actions|actions[ -]skip)\]/i;

/** cd-deploy's promotion commit, written by scripts/cd/promote-digest.sh. */
const PROMOTION_RE = /^chore\(cd\): promote ([0-9a-f]{7,40}) image digest/m;

const short = (sha) => String(sha ?? '').slice(0, 8);

/** True when any changed path is one a deploy would actually ship. */
export function changedPathsTouchDeploy(paths) {
  return paths.some((p) =>
    DEPLOYABLE_PATHS.some((entry) => (entry.endsWith('/') ? p.startsWith(entry) : p === entry)),
  );
}

/**
 * The newest commit on the branch that will actually run a workflow.
 * @param {{sha: string, message: string}[]} commits newest-first
 */
export function effectiveTip(commits) {
  const hit = commits.find((c) => !SKIP_CI_RE.test(c.message ?? ''));
  return hit ? hit.sha : null;
}

/**
 * The most recent deploy visible in `commits`, as `{commit, deployedSha}` — or null.
 * `commit` is the diff base (always an ancestor); `deployedSha` is only for the human-readable reason.
 */
export function lastDeploy(commits) {
  for (const c of commits) {
    const m = PROMOTION_RE.exec(c.message ?? '');
    if (m) return { commit: c.sha, deployedSha: m[1] };
  }
  return null;
}

/**
 * The `guardrails*` contexts for one event, classified through ci-status.mjs.
 * Collapsed to newest-per-context first, so a re-run's success is not shadowed by its own earlier
 * failure (item #176).
 */
export function guardrailsChecks(statuses, { runs = [], event = 'push' } = {}) {
  return collapseToNewestPerContext(selectEventContexts(statuses, event))
    .filter((s) => parseContext(s.context).job.startsWith('guardrails'))
    .map((s) => ({
      context: s.context,
      state: classifyCheckState(s, findRunForContext(s.context, runs)),
    }));
}

/**
 * The whole decision, as a pure function.
 *
 * ORDER IS THE FIX. The tip question is answered BEFORE guardrails are read, because a superseded
 * commit's guardrails legitimately report `failure` — reading them first is exactly the wrong answer
 * item #230 was filed for. `nothing-to-deploy` follows for the same reason: a tip with no shippable
 * change has no business failing on a gate it does not need.
 *
 * @param {{sha: string, effectiveTipSha: string|null,
 *          guardrails: {context: string, state: string}[],
 *          deployableChanged: boolean|null}} input
 *   `deployableChanged === null` means "could not be determined" and fails SAFE — a redundant
 *   deploy, never a skipped one.
 * @returns {{outcome: string, dispatch: boolean, fatal: boolean, reason: string}}
 */
export function decide({ sha, effectiveTipSha, guardrails, deployableChanged }) {
  if (effectiveTipSha && effectiveTipSha !== sha) {
    return {
      outcome: 'superseded',
      dispatch: false,
      fatal: false,
      reason: `superseded — ${short(effectiveTipSha)} is the tip of main and carries the deploy for this commit`,
    };
  }
  if (deployableChanged === false) {
    return {
      outcome: 'nothing-to-deploy',
      dispatch: false,
      fatal: false,
      reason: 'nothing deployable changed since the last deploy — no cd-deploy dispatched',
    };
  }
  if (!guardrails.length) {
    return {
      outcome: 'guardrails-missing',
      dispatch: false,
      fatal: true,
      reason: 'no guardrails status reported on this commit — refusing to deploy an unverified tip',
    };
  }
  const failed = guardrails.filter((c) => c.state === 'failed');
  if (failed.length) {
    return {
      outcome: 'guardrails-failed',
      dispatch: false,
      fatal: true,
      reason: `guardrails failed: ${failed.map((c) => c.context).join(', ')}`,
    };
  }
  const unsettled = guardrails.filter((c) => c.state !== 'passed' && c.state !== 'skipped');
  if (unsettled.length) {
    return {
      outcome: 'guardrails-inconclusive',
      dispatch: false,
      fatal: true,
      reason:
        `guardrails neither passed nor skipped on the tip: ` +
        unsettled.map((c) => `${c.context}=${c.state}`).join(', '),
    };
  }
  return {
    outcome: 'dispatch',
    dispatch: true,
    fatal: false,
    reason: `guardrails green (${guardrails.length} context(s)) and ${short(sha)} is the tip — dispatching cd-deploy`,
  };
}

/** `success` for the outcomes that are correct non-deploys; `failure` for the ones a human must see. */
export function statusStateFor(decision) {
  return decision.fatal ? 'failure' : 'success';
}

// ── Runner ───────────────────────────────────────────────────────────────────────────────────────

const env = process.env;

async function forgeGet(path) {
  const res = await fetch(`${env.GH_API_URL}${path}`, {
    headers: { Authorization: `token ${env.GH_TOKEN}` },
  });
  if (!res.ok) throw new Error(`forge ${res.status} for ${path}`);
  return res.json();
}

/**
 * The newest `max` commits reachable from `sha`, newest-first.
 *
 * ANCESTORS ONLY, and that is the point — this is what `lastDeploy` reads. The branch listing from
 * the forge contains commits NEWER than this one too, and a promotion commit among them is not in
 * this checkout, so a diff base taken from there would be unresolvable. Measured on `main`,
 * 2026-08-31: the two newest commits were `chore(cd): promote …` and `chore(openwiki): …`, both
 * newer than the effective tip.
 */
export function gitLogCommits(sha, max = 200) {
  const out = execFileSync('git', ['log', `--max-count=${max}`, '--format=%H%x1f%s', sha], { encoding: 'utf8' });
  return out.split('\n').filter(Boolean).map((line) => {
    const [commitSha, message] = line.split('\x1f');
    return { sha: commitSha, message: message ?? '' };
  });
}

/** Changed paths between two commits, or null when the range cannot be computed locally. */
export function diffPaths(base, head) {
  try {
    execFileSync('git', ['cat-file', '-e', `${base}^{commit}`], { stdio: 'ignore' });
    const out = execFileSync('git', ['diff', '--name-only', `${base}`, `${head}`], { encoding: 'utf8' });
    return out.split('\n').filter(Boolean);
  } catch {
    return null; // shallow clone, grafted history, or an unreachable base — fail safe upstream
  }
}

async function main() {
  const sha = env.GH_SHA ?? env.GITHUB_SHA;
  const branch = env.GH_BRANCH ?? 'main';
  const repo = env.GH_REPO;

  const commitsRaw = await forgeGet(
    `/repos/${repo}/commits?sha=${encodeURIComponent(branch)}&page=1&limit=30&stat=false&verification=false&files=false`,
  );
  const commits = commitsRaw.map((c) => ({ sha: c.sha, message: c.commit?.message ?? '' }));

  const [statuses, runsRaw] = await Promise.all([
    forgeGet(`/repos/${repo}/commits/${sha}/statuses?page=1&limit=100`),
    forgeGet(`/repos/${repo}/actions/runs?${buildRunsQuery({ sha })}`).catch(() => ({})),
  ]);
  const runs = Array.isArray(runsRaw) ? runsRaw : (runsRaw?.workflow_runs ?? []);

  // `commits` (the branch listing) answers "is anything NEWER than me"; the local log answers
  // "when was the last deploy in MY history". They are different questions and different ranges.
  const deploy = lastDeploy(gitLogCommits(sha));
  const changed = deploy ? diffPaths(deploy.commit, sha) : null;

  const decision = decide({
    sha,
    effectiveTipSha: effectiveTip(commits),
    guardrails: guardrailsChecks(statuses, { runs, event: 'push' }),
    deployableChanged: changed === null ? null : changedPathsTouchDeploy(changed),
  });

  const line = `[cd-dispatch-gate] ${decision.outcome}: ${decision.reason}`;
  console.log(redactForPublication(line));
  if (decision.fatal) console.error(`::error::${redactForPublication(decision.reason)}`);

  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `dispatch=${decision.dispatch}\noutcome=${decision.outcome}\n`);
  }

  // Visibility (item #230, acceptance criterion 4). Never allowed to change the job's own verdict:
  // the same rule the failure digest follows — diagnostics must not manufacture, mask or delay a
  // result. A token without `write:repository` simply warns.
  try {
    const res = await fetch(`${env.GH_API_URL}/repos/${repo}/statuses/${sha}`, {
      method: 'POST',
      headers: { Authorization: `token ${env.GH_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        state: statusStateFor(decision),
        context: STATUS_CONTEXT,
        description: redactForPublication(decision.reason).slice(0, 250),
      }),
    });
    if (!res.ok) console.warn(`::warning::could not publish the ${STATUS_CONTEXT} status (${res.status})`);
  } catch (err) {
    console.warn(`::warning::could not publish the ${STATUS_CONTEXT} status: ${redactForPublication(String(err?.message ?? err))}`);
  }

  return decision.fatal ? 1 : 0;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      console.error(`::error::${redactForPublication(String(err?.stack ?? err))}`);
      process.exitCode = 1;
    });
}
