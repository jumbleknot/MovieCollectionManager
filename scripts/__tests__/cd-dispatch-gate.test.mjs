// Item #230 — the trigger-cd deploy gate, asserted against the measured incident.
//
// WHAT WENT WRONG (2026-08-22, and this file is the reproduction). Two pull requests merged within
// minutes. The second merge CANCELLED the still-running guardrails on the first commit, and a
// cancelled run reports its contexts as `failure` — so trigger-cd's inline `st !== "success"` read
// five green-until-cancelled checks as a broken build and refused to dispatch. The second commit was
// config-only, so app-ci was path-filtered out of its merge entirely and it offered no replacement
// trigger. Net: PR #217's dependency changes reached `main` and were never deployed, silently,
// because trigger-cd is advisory.
//
// WHY THE DECISION IS A PURE FUNCTION. This forge exposes no jobs/steps endpoint, and a green tick
// on an advisory job cannot distinguish "dispatched" from "declined and said nothing" — the exact
// blindness that let the incident sit unnoticed. So the decision is lifted out of the workflow's
// inline `node -e` and pinned here with the incident's own payloads.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEPLOYABLE_PATHS,
  changedPathsTouchDeploy,
  decide,
  diffPaths,
  effectiveTip,
  guardrailsChecks,
  lastDeploy,
} from '../cd-dispatch-gate.mjs';

// ── The measured incident ────────────────────────────────────────────────────────────────────────
const APP_SHA = '1896f34f1896f34f1896f34f1896f34f1896f34f';   // PR #217 — app dependency changes
const CFG_SHA = 'ee8ce302ee8ce302ee8ce302ee8ce302ee8ce302';   // PR #228 — config/docs only, merged seconds later
const OLD_DEPLOY_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/** The five guardrails contexts as the forge reported them on the CANCELLED run (all `failure`). */
const cancelledGuardrails = ['secret-scan', 'naming', 'okf', 'agent-gates', 'sast'].map((job) => ({
  context: `guardrails / ${job} (push)`,
  status: 'failure',
  description: 'Has been cancelled',
  created_at: '2026-08-22T01:00:00Z',
}));

const greenGuardrails = ['secret-scan', 'naming', 'okf', 'agent-gates', 'sast'].map((job) => ({
  context: `guardrails / ${job} (push)`,
  status: 'success',
  description: 'All checks have passed',
  created_at: '2026-08-22T01:05:00Z',
}));

test('the measured two-merge pair dispatches the deploy exactly once', () => {
  // Acceptance criterion 1, and the whole point of the item. The first commit is no longer the tip,
  // so it hands off; the second commit is the tip and carries the deploy for BOTH — the range since
  // the last promotion still contains the first commit's app changes.
  const first = decide({
    sha: APP_SHA,
    effectiveTipSha: CFG_SHA,
    guardrails: guardrailsChecks(cancelledGuardrails),
    deployableChanged: true,
  });
  const second = decide({
    sha: CFG_SHA,
    effectiveTipSha: CFG_SHA,
    guardrails: guardrailsChecks(greenGuardrails),
    deployableChanged: true,
  });

  assert.equal(first.outcome, 'superseded');
  assert.equal(second.outcome, 'dispatch');
  assert.equal(
    [first, second].filter((d) => d.dispatch).length,
    1,
    'the pair must produce exactly one cd-deploy dispatch — zero was the incident, two is a ' +
      'redundant production deploy of the same tip',
  );
});

test('a superseded commit reports skipped, not failed', () => {
  // Acceptance criterion 2, first half. `fatal` false is load-bearing: a red advisory job on every
  // pair of quick merges is noise that trains a human to ignore the signal that matters.
  const d = decide({
    sha: APP_SHA,
    effectiveTipSha: CFG_SHA,
    guardrails: guardrailsChecks(cancelledGuardrails),
    deployableChanged: true,
  });
  assert.equal(d.dispatch, false);
  assert.equal(d.fatal, false);
  assert.match(d.reason, /ee8ce302/, 'the reason must name the commit that carries the deploy instead');
});

test('the tip is checked before guardrails, so a cancelled run is never read as a break', () => {
  // Ordering, asserted directly. Classifying first would surface `guardrails-failed` for the
  // incident's five cancelled contexts — which is precisely the wrong answer the item was filed for.
  const d = decide({
    sha: APP_SHA,
    effectiveTipSha: CFG_SHA,
    guardrails: guardrailsChecks(cancelledGuardrails),
    deployableChanged: true,
  });
  assert.notEqual(d.outcome, 'guardrails-failed');
});

test('a genuine guardrails failure on the tip still blocks the deploy', () => {
  // Acceptance criterion 2, second half. The fix must not buy superseded-tolerance by deploying
  // commits that are actually broken.
  const broken = [
    ...greenGuardrails.slice(1),
    { context: 'guardrails / secret-scan (push)', status: 'failure', description: 'Has been failed', created_at: '2026-08-22T01:05:00Z' },
  ];
  const d = decide({
    sha: CFG_SHA,
    effectiveTipSha: CFG_SHA,
    guardrails: guardrailsChecks(broken),
    deployableChanged: true,
  });
  assert.equal(d.outcome, 'guardrails-failed');
  assert.equal(d.dispatch, false);
  assert.equal(d.fatal, true, 'a real break must be LOUD — the incident was invisible because it was not');
});

test('guardrails that never reported at all is a hard failure, not a silent pass', () => {
  const d = decide({ sha: CFG_SHA, effectiveTipSha: CFG_SHA, guardrails: [], deployableChanged: true });
  assert.equal(d.outcome, 'guardrails-missing');
  assert.equal(d.fatal, true);
});

test('guardrails still in flight on the tip declines loudly rather than deploying', () => {
  // guardrails is the fast workflow and has long since settled by the time app-e2e finishes, so
  // `pending` here means something anomalous. Deploying on an unfinished gate is the one outcome
  // worse than not deploying.
  const inFlight = [
    ...greenGuardrails.slice(1),
    { context: 'guardrails / secret-scan (push)', status: 'pending', description: '', created_at: '2026-08-22T01:05:00Z' },
  ];
  const d = decide({
    sha: CFG_SHA,
    effectiveTipSha: CFG_SHA,
    guardrails: guardrailsChecks(inFlight),
    deployableChanged: true,
  });
  assert.equal(d.outcome, 'guardrails-inconclusive');
  assert.equal(d.dispatch, false);
  assert.equal(d.fatal, true);
});

test('a path-gated guardrails job that settled to Skipped counts as satisfied', () => {
  // A skipped required check settles to `success` with description "Skipped" on this forge. Reading
  // it as anything else would make a legitimately-skipped guardrails job block every deploy.
  const withSkip = [
    ...greenGuardrails.slice(1),
    { context: 'guardrails / secret-scan (push)', status: 'success', description: 'Has been skipped', created_at: '2026-08-22T01:05:00Z' },
  ];
  const d = decide({
    sha: CFG_SHA,
    effectiveTipSha: CFG_SHA,
    guardrails: guardrailsChecks(withSkip),
    deployableChanged: true,
  });
  assert.equal(d.outcome, 'dispatch');
});

test('a config-only tip that supersedes an app commit still deploys', () => {
  // Acceptance criterion 3. The range that matters is last-deployed..tip, NOT this commit's own
  // diff — the app commit's changes are inside it even though the tip touched only config.
  const d = decide({
    sha: CFG_SHA,
    effectiveTipSha: CFG_SHA,
    guardrails: guardrailsChecks(greenGuardrails),
    deployableChanged: true,
  });
  assert.equal(d.outcome, 'dispatch');
});

test('a tip with nothing deployable since the last deploy declines without failing', () => {
  const d = decide({
    sha: CFG_SHA,
    effectiveTipSha: CFG_SHA,
    guardrails: guardrailsChecks(greenGuardrails),
    deployableChanged: false,
  });
  assert.equal(d.outcome, 'nothing-to-deploy');
  assert.equal(d.dispatch, false);
  assert.equal(d.fatal, false);
});

test('an undeterminable deployable-change answer fails safe by dispatching', () => {
  // The range is derived from git history. If it cannot be derived (no promotion commit ever, a
  // grafted history), the safe direction is a redundant deploy — never a skipped one.
  const d = decide({
    sha: CFG_SHA,
    effectiveTipSha: CFG_SHA,
    guardrails: guardrailsChecks(greenGuardrails),
    deployableChanged: null,
  });
  assert.equal(d.outcome, 'dispatch');
});

// ── Deriving the tip and the last deploy from git ────────────────────────────────────────────────

test('the effective tip skips [skip ci] commits, which run nothing', () => {
  // THE TRAP THIS EXISTS FOR: cd-deploy's own promotion commit is pushed with [skip ci] and becomes
  // the tip. A bare `git rev-parse main` would make the commit that legitimately owns the deploy
  // look superseded by a commit that will never run a trigger-cd — recreating item #230 exactly.
  const commits = [
    { sha: 'cccccccccccccccccccccccccccccccccccccccc', message: `chore(cd): promote ${APP_SHA} image digest(s) [skip ci]` },
    { sha: CFG_SHA, message: 'Merge pull request (#228)' },
    { sha: APP_SHA, message: 'Merge pull request (#217)' },
  ];
  assert.equal(effectiveTip(commits), CFG_SHA);
});

test('the effective tip is the newest real commit when nothing is skipped', () => {
  const commits = [
    { sha: CFG_SHA, message: 'Merge pull request (#228)' },
    { sha: APP_SHA, message: 'Merge pull request (#217)' },
  ];
  assert.equal(effectiveTip(commits), CFG_SHA);
});

test('the last deploy yields both the promotion commit and the sha it deployed', () => {
  // The DIFF BASE is the promotion commit itself, not the sha in its message: the promotion commit
  // is by definition the state of `main` immediately after that deploy, and it is always an
  // ancestor. The message's sha is what cd-deploy was dispatched for, which can be OLDER than what
  // it actually built (it builds the tip) — a base that is not guaranteed to be reachable.
  const commits = [
    { sha: 'dddddddddddddddddddddddddddddddddddddddd', message: 'docs: something' },
    { sha: 'cccccccccccccccccccccccccccccccccccccccc', message: `chore(cd): promote ${OLD_DEPLOY_SHA} image digest(s) [skip ci]` },
  ];
  assert.deepEqual(lastDeploy(commits), {
    commit: 'cccccccccccccccccccccccccccccccccccccccc',
    deployedSha: OLD_DEPLOY_SHA,
  });
});

test('no promotion commit in range yields no last deploy', () => {
  assert.equal(lastDeploy([{ sha: CFG_SHA, message: 'docs: something' }]), null);
});

// ── The deployable path set ──────────────────────────────────────────────────────────────────────

test('a docs-only change set touches nothing deployable', () => {
  assert.equal(changedPathsTouchDeploy(['docs/runbooks/ci-diagnostics.md', 'openwiki/quickstart.md', 'CLAUDE.md']), false);
});

test('an app change set touches something deployable', () => {
  assert.equal(changedPathsTouchDeploy(['frontend/app/index.tsx']), true);
  assert.equal(changedPathsTouchDeploy(['backend/mc-service/src/main.rs']), true);
});

test('a root lockfile change is deployable but a nested package.json is matched by its directory', () => {
  // The file entries are EXACT matches, not suffix matches — `package.json` must mean the root
  // manifest. `frontend/package.json` is deployable because `frontend/` is, not because the entry
  // happens to end the same way.
  assert.equal(changedPathsTouchDeploy(['pnpm-lock.yaml']), true);
  assert.equal(changedPathsTouchDeploy(['frontend/package.json']), true);
  assert.equal(changedPathsTouchDeploy(['tools/package.json']), false);
});

test('the deploy machinery itself is deployable', () => {
  // A change to how the deploy runs should be proven by a deploy, not by the next unrelated merge.
  assert.equal(changedPathsTouchDeploy(['scripts/cd/promote-digest.sh']), true);
  assert.equal(changedPathsTouchDeploy(['.forgejo/workflows/cd-deploy.yml']), true);
});

test('the deployable path set is non-empty and every entry is a plain path', () => {
  // Guards the assertions above from passing vacuously, and pins the entries as literal paths —
  // a glob (`frontend/**`) would silently match nothing under an exact/prefix matcher.
  assert.ok(DEPLOYABLE_PATHS.length > 0);
  for (const p of DEPLOYABLE_PATHS) {
    assert.ok(!p.includes('*'), `${p} looks like a glob — DEPLOYABLE_PATHS entries are literal prefixes or exact paths`);
  }
});

test('an unreachable diff base yields null rather than throwing', () => {
  // The safety net under the whole nothing-to-deploy skip. A base the checkout cannot resolve — a
  // shallow clone, a promotion commit that is not an ancestor — must degrade to "unknown", which
  // `decide` turns into a dispatch. An exception here would fail the job and skip the deploy, which
  // is the direction item #230 exists to eliminate.
  assert.equal(diffPaths('0000000000000000000000000000000000000000', 'HEAD'), null);
});
