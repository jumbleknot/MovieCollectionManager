// Item #577 — the promotion model, asserted statically.
//
// WHY A TEST AND NOT A COMMENT. `minio-image.yml` already carried a comment stating the design
// intent — "updating it becomes a deliberate act rather than a weekly breakage" — and the deliberate
// act had no owner, no trigger and no signal, so it degraded to "forgotten". PR #559's golang 1.27
// bump published and reached nothing for three weeks. A comment cannot notice that.
//
// THE MODEL THIS PINS. Promotion is triggered by a DOCKERFILE CHANGE, never by the weekly canary.
// That discriminator is correct because the two triggers do different jobs, which the workflow's own
// header already says: a `push` build means the image's INPUTS changed (a Renovate base bump or a
// MINIO_TAG bump — #559 was one), while the canary's changed digest is float. The apk installs
// resolve against Alpine's live index, so the canary mints a new digest every Friday with no input
// having moved; promoting that would open a PR a week whose only content is float, and spend ~35
// minutes of app-e2e on it. Training someone to merge a weekly PR without reading it is how the next
// real bump gets waved through.
//
// Assertion 4 is the one that guards someone ELSE's change: the promoter's PR is only safe because
// `infrastructure-as-code/docker/**` sits in app-ci's `app` filter, so the ref change is exercised
// by app-e2e. Narrowing that filter would make this automation quietly ship unexercised image
// changes — the item #535 fault, arriving through a new door.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MINIO_WORKFLOW = resolve(REPO_ROOT, '.forgejo/workflows/minio-image.yml');
const APP_CI_WORKFLOW = resolve(REPO_ROOT, '.forgejo/workflows/app-ci.yml');

const minio = parseYaml(readFileSync(MINIO_WORKFLOW, 'utf8'));
const steps = minio?.jobs?.['build-publish']?.steps ?? [];

/** The promotion step, found by the script it runs rather than by a name a rename would break. */
function promoteStep() {
  const step = steps.find((s) => typeof s?.run === 'string' && s.run.includes('promote-minio-digest.mjs'));
  assert.ok(step, 'no step in minio-image.yml runs scripts/promote-minio-digest.mjs');
  return step;
}

test('the workflow has a promotion step at all', () => {
  assert.ok(steps.length > 0, 'build-publish has no steps — the parse is wrong, not the workflow');
  promoteStep();
});

// ── 1. The canary never promotes ──────────────────────────────────────────────────────────────

test('the promotion step is gated on the trigger, and the gate excludes schedule', () => {
  const cond = String(promoteStep().if ?? '');
  assert.ok(cond.length > 0, 'the promotion step has no `if:` — the weekly canary would promote');
  assert.ok(
    cond.includes("github.event_name == 'push'"),
    `the gate does not admit the Dockerfile-change trigger: ${cond}`,
  );
  assert.ok(
    !/event_name\s*==\s*'schedule'/.test(cond),
    `the gate admits the weekly canary, which publishes float: ${cond}`,
  );
});

test('the only push path into this workflow is the Dockerfile', () => {
  // The gate above says "promote on push". That is only the right rule while `push` can mean nothing
  // else. Adding this workflow file to its own paths filter was tried once and produced a feedback
  // loop (run 3119: editing a COMMENT rebuilt the image and invalidated every compose pin). With a
  // promoter attached, that loop would also open a PR.
  const paths = minio?.on?.push?.paths ?? [];
  assert.deepEqual(paths, ['infrastructure-as-code/docker/minio/Dockerfile'],
    'the push filter no longer means "the image inputs changed", so the promotion gate is wrong');
});

// ── 2. A dispatch promotes only when asked ────────────────────────────────────────────────────

test('workflow_dispatch exposes a promote input that defaults to NOT promoting', () => {
  const input = minio?.on?.workflow_dispatch?.inputs?.promote;
  assert.ok(input, 'workflow_dispatch has no `promote` input — a dispatch could not promote at all');
  assert.equal(input.type, 'boolean');
  // A default that ACTS is the measured trap (`agent-stack.mjs --help` built and deployed the stack).
  // Dispatch is also how the build is proven still working, which must stay a read-only act.
  assert.equal(input.default, false, 'dispatching the build would promote by default');
});

test('the gate honours the dispatch input', () => {
  const cond = String(promoteStep().if ?? '');
  assert.match(cond, /inputs\.promote/, `a dispatch could never promote: ${cond}`);
});

// ── 3. The promotion runs app-e2e — no [skip ci] ──────────────────────────────────────────────

test('nothing in the promotion path suppresses CI', () => {
  // BOTH places, because the commit message is built in the SCRIPT and the step only invokes it.
  // The first draft of this test read the step alone, which would have passed while the script
  // committed `[skip ci]` — an assertion aimed one layer above the thing it claims to check.
  assert.ok(!JSON.stringify(promoteStep()).includes('[skip ci]'),
    'the promotion step carries [skip ci] — the image change would reach the stacks unexercised');
  const src = readFileSync(resolve(REPO_ROOT, 'scripts/promote-minio-digest.mjs'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!code.includes('[skip ci]'),
    'the promoter commits [skip ci] — its pull request would never run app-e2e');
});

test('the dispatch gate compares explicitly rather than relying on truthiness', () => {
  // A dispatch input can arrive as the string "false", which is truthy. cd-deploy writes
  // `inputs.deploy == true` for exactly this reason; a bare `inputs.promote` would make an
  // UNTICKED box promote — the same shape as an argument a tool does not reject.
  const cond = String(promoteStep().if ?? '');
  assert.match(cond, /inputs\.promote\s*==\s*true/,
    `the gate relies on truthiness, so an unticked box could promote: ${cond}`);
});

test('the promoter opens a pull request rather than pushing to main', () => {
  // cd-deploy promotes by pushing `[skip ci]` straight to main, which is right for an image CI just
  // built and scanned within the same run. This image is different: the ref change must run app-e2e,
  // and feature 069 deliberately kept a human in the loop. A push-to-main promoter would drop both.
  const src = readFileSync(resolve(REPO_ROOT, 'scripts/promote-minio-digest.mjs'), 'utf8');
  assert.ok(/\/pulls/.test(src), 'the promoter does not open a pull request');

  // ASSERTED ON THE PUSH INVOCATION, not on the file's text. The first version of this check
  // grepped the whole source for `refs/for/` and failed on the COMMENT explaining why AGit is
  // forbidden — a guard that fires on its own documentation is one someone deletes rather than
  // reads. The refspec is the thing that has to be right, so the refspec is what is read.
  const push = /git\(\[\s*'push'[\s\S]{0,200}?\]\)/.exec(src);
  assert.ok(push, 'the promoter never pushes a branch — the pull request would have no head');
  const refspec = push[0];

  // CLAUDE.md's invariant: a PR's head must be a REAL branch. An AGit push (`HEAD:refs/for/main`)
  // yields a refs/pull/N/head, which Forgejo runs with NO Actions secrets — every `${{ secrets.* }}`
  // is empty and nx reports the empty cache token as `Misconfigured remote cache endpoint`. That
  // cost two sessions a day on #126.
  assert.match(refspec, /HEAD:refs\/heads\//, `the push target is not a real branch: ${refspec}`);
  assert.ok(!/refs\/for\//.test(refspec), `the promoter uses an AGit push: ${refspec}`);
  assert.ok(!/:(refs\/heads\/)?main['"`\s]/.test(refspec), `the promoter pushes to main: ${refspec}`);
});

test('the checkout can actually push the branch the pull request needs', () => {
  // FOUND BY READING, NOT BY CI — and CI could not have found it. The promotion step only runs on a
  // minio Dockerfile change, so no pull request exercises the push path; the first time this would
  // have been discovered is the first real Renovate bump, which is precisely the moment it matters.
  //
  // A bare `actions/checkout` gives a depth-1 clone with the run-provisioned token. `git push` would
  // then authenticate as the run rather than as the write-scoped PAT, and a force-push of a commit
  // made on a shallow clone is refused outright (`shallow update not allowed`). cd-deploy, the other
  // workflow here that pushes, sets all three.
  const checkout = steps.find((s) => String(s?.uses ?? '').startsWith('actions/checkout@'));
  assert.ok(checkout, 'build-publish has no checkout step');
  assert.equal(checkout.with?.['fetch-depth'], 0, 'a shallow clone cannot force-push the promotion branch');
  assert.match(String(checkout.with?.token ?? ''), /secrets\.CD_PUSH_TOKEN/,
    'the checkout does not carry the write credential, so `git push` would use the run token');
  assert.equal(checkout.with?.['persist-credentials'], true,
    'credentials are not persisted into the remote, so `git push` has none to use');
});

// ── 4. The PR it opens is actually exercised ──────────────────────────────────────────────────

test('app-ci still routes infrastructure-as-code/docker/** into the app filter', () => {
  const appCi = parseYaml(readFileSync(APP_CI_WORKFLOW, 'utf8'));
  const step = (appCi?.jobs?.changes?.steps ?? []).find((s) => typeof s?.with?.filters === 'string');
  assert.ok(step, 'app-ci has no paths-filter step — this guard cannot see what it claims to check');
  const filters = parseYaml(step.with.filters);
  assert.ok(Array.isArray(filters?.app) && filters.app.length > 0, 'the `app` filter is empty or missing');
  assert.ok(
    filters.app.some((p) => String(p).startsWith('infrastructure-as-code/docker/')),
    'app-e2e no longer runs on a compose change — the minio promotion PR would ship unexercised',
  );
});

// ── 5. The credential split ───────────────────────────────────────────────────────────────────

test('the promotion step takes its credentials from env, never from argv', () => {
  const step = promoteStep();
  // `-e NAME=$VALUE` publishes to `ps` for every session on the shared host. The same applies to a
  // token passed as a script argument; scripts/check-no-argv-secrets.mjs enforces this repo-wide and
  // this pins it for the one step that handles a write-scoped credential.
  assert.ok(step.env && typeof step.env === 'object', 'the promotion step declares no env');
  assert.ok('FORGE_TOKEN' in step.env, 'the promotion step has no write credential');
  assert.ok(!/\$\{\{\s*secrets\./.test(String(step.run)),
    'a secret is interpolated into the run body — it would reach the process listing and the log');
});
