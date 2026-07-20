// Unit tests for the CI status reader (feature 042, US1).
//
// Runs in CI: guardrails/naming executes `node --test scripts/__tests__/*.test.mjs` (feature 041),
// so this file MUST stay deterministic, offline and token-free. Every case is driven from the
// captured fixtures in ./fixtures/ci/ — never from a live forge call.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildRunsQuery,
  assertFullSha,
  requireToken,
  describeAuthFailure,
  cacheRawPayload,
} from '../ci-status.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(HERE, 'fixtures', 'ci', name), 'utf8'));
const FULL_SHA = 'c2c3c29593fa94b3fd6d2b90ba7aaa94ddbc4596';

// --- (a) head_sha is the primary read path, and must be a FULL sha ------------------------------

test('(a) a sha lookup queries by head_sha', () => {
  const q = buildRunsQuery({ sha: FULL_SHA });
  assert.equal(q.get('head_sha'), FULL_SHA);
});

test('(a2) an abbreviated sha is REJECTED, not silently sent', () => {
  // ?head_sha= is an exact-match server-side filter: a short sha returns zero runs, which reads
  // as "no CI ran" rather than "you passed the wrong thing". Measured 2026-07-19.
  assert.throws(() => assertFullSha('c2c3c29'), /full 40-character/i);
  assert.throws(() => buildRunsQuery({ sha: 'c2c3c29' }), /full 40-character/i);
  assert.doesNotThrow(() => assertFullSha(FULL_SHA));
});

// --- (b) pagination: `limit` alone is silently ignored upstream ---------------------------------

test('(b) a listing always sends page TOGETHER with limit', () => {
  // Measured: `?limit=N` alone is silently ignored and returns all 886 runs (12.4 MB / 94 s).
  // `?page=N&limit=M` is honoured. Emitting limit without page is the expensive silent failure.
  const q = buildRunsQuery({ page: 2, limit: 30 });
  assert.equal(q.get('page'), '2');
  assert.equal(q.get('limit'), '30');
});

test('(b2) requesting a limit without a page still emits a page', () => {
  const q = buildRunsQuery({ limit: 30 });
  assert.ok(q.get('page'), 'limit was sent without page — upstream would ignore it and return everything');
});

// --- (c) filters the API silently ignores must never be sent -----------------------------------

test('(c) status/event/branch are NEVER sent as query params', () => {
  // Measured: all three are silently ignored server-side and cost a full 12.4 MB fetch.
  const q = buildRunsQuery({ sha: FULL_SHA, status: 'failure', event: 'push', branch: 'main' });
  for (const dropped of ['status', 'event', 'branch']) {
    assert.equal(q.get(dropped), null, `${dropped} was sent server-side; it must be applied client-side`);
  }
});

// --- (d) auth failures must name the missing scope ---------------------------------------------

test('(d) a 403 names the scope the endpoint needs, not just the code', () => {
  const msg = describeAuthFailure(403, '/repos/x/y/issues/12/comments');
  assert.match(msg, /read:issue/, 'the missing scope was not named');
  assert.match(msg, /403/);
});

test('(d2) a 401 on the package registry names read:package', () => {
  const msg = describeAuthFailure(401, '/packages/jumbleknot/generic/ci-failures/1--x');
  assert.match(msg, /read:package/);
});

test('(d3) an auth failure message never echoes a token value', () => {
  const msg = describeAuthFailure(403, '/repos/x/y/issues/12/comments');
  assert.equal(/gta_|[A-Fa-f0-9]{40}/.test(msg), false, 'the message may have echoed credential material');
});

// --- (e) a missing token aborts naming the variable, with no fallback ---------------------------

test('(e) a missing token names MCM_FORGE_TOKEN and how to set it', () => {
  assert.throws(() => requireToken({}), /MCM_FORGE_TOKEN/);
  assert.throws(() => requireToken({ MCM_FORGE_TOKEN: '' }), /MCM_FORGE_TOKEN/);
  assert.equal(requireToken({ MCM_FORGE_TOKEN: 'abc' }), 'abc');
});

// --- (f) FR-018: the read path must not reuse the git credential-fill credential ----------------

test('(f) the read path never shells to `git credential fill`', () => {
  // That credential is write-capable yet repository-scoped only: 403 on issues/{n}/comments and
  // 401 reqPackageAccess on packages. Reaching for it would be both wrong and a privilege upgrade.
  // Scan CODE only. The header comment deliberately explains why that credential is unusable, and
  // a naive whole-file grep flags that prose — which would make this test unfailable-for-the-right-
  // reason and quietly pressure the explanation out of the file.
  const code = readFileSync(resolve(HERE, '..', 'ci-status.mjs'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/credential\s+fill/.test(code), false, 'ci-status.mjs appears to shell to git credential fill');
  assert.equal(/['"]credential['"]/.test(code), false, 'ci-status.mjs appears to invoke the git credential helper');
  // Prove the stripped source is still substantive, so this can never pass by scanning nothing.
  assert.ok(code.includes('MCM_FORGE_TOKEN'), 'comment-stripping ate the code; the assertion above is vacuous');
});

// --- FR-016: raw payloads go to disk, never to stdout ------------------------------------------

test('(g) a raw payload is cached to disk and referenced by path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-status-'));
  const path = cacheRawPayload(dir, 'runs', '{"workflow_runs":[]}');
  assert.ok(existsSync(path), 'the raw payload was not written to disk');
  assert.match(path, /runs/);
  assert.ok(path.startsWith(dir), 'the cache escaped the directory it was given');
});

test('(g2) the fixtures load and have the shape the classifier expects', () => {
  // Guards against a fixture being reshaped without the tests noticing.
  const cancelled = fixture('status-cancelled.json');
  assert.equal(cancelled.state, 'failure');
  assert.ok(cancelled.statuses.length > 0);
  for (const s of cancelled.statuses) {
    assert.ok(s.context, 'a fixture status is missing `context`');
    assert.ok(s.status, 'a fixture status is missing `status`');
  }
  const runs = fixture('runs-cancelled.json');
  assert.ok(runs.workflow_runs.every((r) => r.commit_sha && r.workflow_id && r.status));
});

// ================================================================================================
// T009 — classifyCheckState: five states, two of which the raw API reports WRONG.
// ================================================================================================

import { classifyCheckState, parseContext, findRunForContext } from '../ci-status.mjs';

const statusesOf = (f) => fixture(f).statuses;
const byContext = (f, needle) => statusesOf(f).find((s) => s.context.includes(needle));

test('(h) context strings parse into job + event', () => {
  assert.deepEqual(parseContext('app-ci / app-e2e (pull_request)'), {
    job: 'app-ci / app-e2e',
    event: 'pull_request',
  });
  assert.deepEqual(parseContext('guardrails / secret-scan (push)'), {
    job: 'guardrails / secret-scan',
    event: 'push',
  });
  // A context without a suffix must still parse rather than throw.
  assert.equal(parseContext('some / context').job, 'some / context');
});

test('(i) success → passed', () => {
  assert.equal(classifyCheckState(byContext('status-all-green.json', 'secret-scan')), 'passed');
});

test('(j) a genuine failure → failed', () => {
  const s = byContext('status-genuine-failure.json', 'mc-service-checks');
  assert.equal(classifyCheckState(s), 'failed');
});

test('(k) TRAP 1 — a gated job that skipped counts as SATISFIED, not pending', () => {
  // A path-gated job settles to `success` with description "Skipped". Treating it as pending makes
  // a green PR look blocked forever. Fails safe (an unnecessary wait), but still wrong.
  const s = byContext('status-skipped.json', 'app-e2e');
  assert.equal(s.status, 'success', 'fixture drift: a skipped job should settle to success upstream');
  assert.equal(classifyCheckState(s), 'skipped');
});

test('(l) pending → waiting (runner starvation is not failure)', () => {
  const s = byContext('status-waiting.json', 'app-e2e');
  assert.equal(classifyCheckState(s), 'waiting');
});

test('(m) TRAP 2 — a cancelled run reads as `failure` but MUST classify as superseded', () => {
  // Measured on real data: 13/16 contexts of a superseded commit report status="failure" with
  // description "Has been cancelled", for a commit that was never broken. This fails LOUD —
  // announcing a broken build that isn't — so it is the worse of the two traps.
  const s = byContext('status-cancelled.json', 'app-e2e');
  assert.equal(s.status, 'failure', 'fixture drift: a cancelled context should read as failure upstream');
  assert.equal(classifyCheckState(s), 'superseded');
});

test('(m2) superseded is detected structurally too, via the owning run', () => {
  // The description is a UI string that could be reworded; run.status is structural. Either signal
  // alone is enough, so a wording change cannot silently turn superseded into failed.
  const noDescription = { status: 'failure', context: 'app-ci / app-e2e (pull_request)', description: '' };
  const cancelledRun = { workflow_id: 'app-ci.yml', event: 'pull_request', status: 'cancelled' };
  assert.equal(classifyCheckState(noDescription, cancelledRun), 'superseded');
  // ...and with neither signal it stays a genuine failure.
  assert.equal(classifyCheckState(noDescription, { ...cancelledRun, status: 'failure' }), 'failed');
});

test('(m3) every cancelled context in the real fixture classifies as superseded — none as failed', () => {
  const runs = fixture('runs-cancelled.json').workflow_runs;
  const cancelled = statusesOf('status-cancelled.json').filter((s) => s.description === 'Has been cancelled');
  assert.ok(cancelled.length >= 10, 'fixture drift: expected the real superseded commit to have many contexts');
  for (const s of cancelled) {
    assert.equal(classifyCheckState(s, findRunForContext(s.context, runs)), 'superseded', `misclassified: ${s.context}`);
  }
});

test('(n) a context is matched to its run by workflow file AND event', () => {
  const runs = fixture('runs-cancelled.json').workflow_runs;
  const run = findRunForContext('app-ci / app-e2e (pull_request)', runs);
  assert.equal(run?.workflow_id, 'app-ci.yml');
  assert.equal(findRunForContext('nope / nothing (push)', runs), null);
});

// ================================================================================================
// T011 — computeMergeVerdict: required-only, advisory, and the event-suffix rule.
// ================================================================================================

import { computeMergeVerdict, REQUIRED_CONTEXT_GLOBS, selectEventContexts } from '../ci-status.mjs';

const verdictFor = (f, opts = {}) =>
  computeMergeVerdict(statusesOf(f), { event: 'pull_request', ...opts });

test('(o) all required green → mergeable', () => {
  const v = computeMergeVerdict(statusesOf('status-all-green.json'), { event: 'push' });
  assert.equal(v.mergeable, true);
  assert.equal(v.blocking.length, 0);
});

test('(p) a SKIPPED required check satisfies the verdict', () => {
  const v = verdictFor('status-skipped.json');
  assert.equal(v.mergeable, true, 'a path-gated skip blocked the merge verdict');
  assert.equal(v.waiting.length, 0, 'a skip was mistaken for still-pending');
});

test('(q) a WAITING required check is neither mergeable nor failed', () => {
  const v = verdictFor('status-waiting.json');
  assert.equal(v.mergeable, false);
  assert.equal(v.blocking.length, 0, 'runner starvation was reported as a failure');
  assert.equal(v.waiting.length, 1);
});

test('(r) a failing NON-REQUIRED check stays advisory and leaves the commit mergeable', () => {
  // dast is not a required context. Both failure modes are guarded here: a false "blocked" report,
  // and silently dropping a real regression.
  const v = verdictFor('status-advisory-failure.json');
  assert.equal(v.mergeable, true, 'a non-required failure blocked the merge verdict');
  assert.equal(v.blocking.length, 0);
  assert.equal(v.advisory.length, 1, 'the non-required failure was dropped instead of surfaced');
  assert.match(v.advisory[0].context, /dast/);
});

test('(s) a genuine required failure blocks', () => {
  const v = verdictFor('status-genuine-failure.json');
  assert.equal(v.mergeable, false);
  assert.equal(v.blocking.length, 1);
  assert.match(v.blocking[0].context, /mc-service-checks/);
});

test('(t) TRAP 2 at verdict level — a superseded commit is NOT reported as failed', () => {
  const runs = fixture('runs-cancelled.json').workflow_runs;
  const v = computeMergeVerdict(statusesOf('status-cancelled.json'), { event: 'pull_request', runs });
  assert.equal(v.blocking.length, 0, 'a superseded run was announced as a broken build');
  assert.ok(v.superseded.length > 0, 'the superseded contexts vanished instead of being reported');
  assert.equal(v.mergeable, false, 'superseded is not mergeable either — the newer run decides');
});

test('(u) THE EVENT-SUFFIX RULE — the same job differs per event; the verdict must pick one', () => {
  // Measured on the real superseded commit: guardrails/secret-scan is push=success but
  // pull_request=failure(cancelled). A glob like `guardrails*` matches BOTH, so a verdict that
  // ignores the event reports failure for a commit whose push run was entirely green.
  const all = statusesOf('status-cancelled.json');
  const push = selectEventContexts(all, 'push');
  const pr = selectEventContexts(all, 'pull_request');
  assert.ok(push.length > 0 && pr.length > 0, 'fixture drift: expected both events present');
  assert.equal(push.every((s) => parseContext(s.context).event === 'push'), true);

  const sameJob = 'guardrails / secret-scan';
  const pushOne = push.find((s) => s.context.startsWith(sameJob));
  const prOne = pr.find((s) => s.context.startsWith(sameJob));
  assert.equal(classifyCheckState(pushOne), 'passed');
  assert.equal(classifyCheckState(prOne), 'superseded');
  assert.notEqual(classifyCheckState(pushOne), classifyCheckState(prOne),
    'fixture drift: this test is only meaningful while the two events disagree');
});

test('(v) a zero-match required glob is treated as satisfied', () => {
  // Mirrors branch-protection behaviour: a required context that produced no status at all does
  // not hold the verdict hostage.
  const v = computeMergeVerdict(statusesOf('status-all-green.json'), {
    event: 'push',
    requiredGlobs: [...REQUIRED_CONTEXT_GLOBS, 'never-matches-anything*'],
  });
  assert.equal(v.mergeable, true, 'a glob matching nothing blocked the verdict');
});

test('(w) the required-context glob set covers the documented branch-protection contexts', () => {
  for (const needle of ['guardrails', 'app-e2e', 'mc-service-checks', 'affected', 'changes']) {
    assert.ok(REQUIRED_CONTEXT_GLOBS.some((g) => g.includes(needle)), `missing required glob: ${needle}`);
  }
  // trigger-cd and dast are explicitly NOT required.
  assert.equal(REQUIRED_CONTEXT_GLOBS.some((g) => /trigger-cd|dast/.test(g)), false);
});

// ================================================================================================
// T026 — reading the published digest back.
// ================================================================================================

import { extractDigests, DIGEST_MARKER_RE } from '../ci-status.mjs';

test('(x) digests are extracted from PR comments by marker, ignoring unrelated comments', () => {
  const comments = [
    { id: 1, body: 'looks good to me' },
    { id: 2, body: '<!-- ci-digest:job=app-e2e -->\n### ❌ CI failure — `app-ci` / `app-e2e`\nbody' },
    { id: 3, body: '<!-- ci-digest:job=sast -->\n### ❌ CI failure — `guardrails` / `sast`\nbody' },
  ];
  const found = extractDigests(comments);
  assert.equal(found.length, 2, 'a review comment was mistaken for a digest, or a digest was missed');
  assert.deepEqual(found.map((d) => d.job).sort(), ['app-e2e', 'sast']);
});

test('(x2) a single job can be selected', () => {
  const comments = [
    { id: 2, body: '<!-- ci-digest:job=app-e2e -->\nA' },
    { id: 3, body: '<!-- ci-digest:job=sast -->\nB' },
  ];
  assert.equal(extractDigests(comments, 'sast').length, 1);
  assert.equal(extractDigests(comments, 'nope').length, 0);
});

test('(x3) the marker pattern round-trips with the writer\'s own marker format', () => {
  // Guards the read and write halves against drifting apart — they are in different files and
  // nothing but this assertion couples the two formats.
  assert.match('<!-- ci-digest:job=app-e2e -->', DIGEST_MARKER_RE);
  DIGEST_MARKER_RE.lastIndex = 0;
});

// ================================================================================================
// Bundle extraction must not escape its own directory (zip-slip).
//
// A bundle manifest is attacker-controlled input the moment anyone holds `write:package` on the
// forge — a compromised CI token, or another package namespace. Extracting it with a naive join()
// turns that into arbitrary file write on a DEVELOPER'S machine (~/.bashrc, ~/.ssh/authorized_keys)
// as soon as they run `failure --full`. That is a CI-token → workstation escalation, so entry paths
// are validated, not merely sanitised.
// ================================================================================================

import { safeBundleEntryPath } from '../ci-status.mjs';

test('(y) a normal bundle entry resolves inside the bundle root', () => {
  const root = '/tmp/bundle-root';
  assert.equal(safeBundleEntryPath(root, 'logs/app.log'), join(root, 'logs/app.log'));
  assert.equal(safeBundleEntryPath(root, 'health/mongo.json'), join(root, 'health/mongo.json'));
});

test('(y2) parent-directory traversal is REJECTED, not sanitised into something plausible', () => {
  const root = '/tmp/bundle-root';
  for (const evil of [
    '../../../etc/passwd',
    'logs/../../../etc/passwd',
    '..',
    'logs/..',
    './../../x',
  ]) {
    assert.throws(() => safeBundleEntryPath(root, evil), /outside|traversal|invalid/i, `not rejected: ${evil}`);
  }
});

test('(y3) an absolute path is rejected', () => {
  const root = '/tmp/bundle-root';
  assert.throws(() => safeBundleEntryPath(root, '/etc/passwd'), /outside|absolute|invalid/i);
  assert.throws(() => safeBundleEntryPath(root, '//etc/passwd'), /outside|absolute|invalid/i);
});

test('(y4) an empty or dot-only entry is rejected rather than writing the directory itself', () => {
  const root = '/tmp/bundle-root';
  for (const evil of ['', '.', './', '   ']) {
    assert.throws(() => safeBundleEntryPath(root, evil), /invalid|outside/i, `not rejected: ${JSON.stringify(evil)}`);
  }
});

test('(y5) the containment check is the authority, not the character filter', () => {
  // The original bug: a sanitiser that allows `.` `/` and `-` leaves `../../x` completely intact,
  // because every character in it is already in the allowed set. Character filtering alone can
  // never be the control here.
  const root = '/tmp/bundle-root';
  const sanitisedButStillEvil = '../../x'.replace(/[^A-Za-z0-9._/-]/g, '_');
  assert.equal(sanitisedButStillEvil, '../../x', 'precondition: the old filter is a no-op on this input');
  assert.throws(() => safeBundleEntryPath(root, sanitisedButStillEvil), /outside|traversal|invalid/i);
});

// ================================================================================================
// A check must carry the id of the run that produced it, so `failure --full` can locate the bundle
// without the operator having to pass --run by hand.
// ================================================================================================

test('(z) each check carries the runId of the run that produced it', () => {
  const runs = fixture('runs-cancelled.json').workflow_runs;
  const v = computeMergeVerdict(statusesOf('status-cancelled.json'), { event: 'pull_request', runs });
  const withRun = v.all.filter((c) => c.runId != null);
  assert.ok(withRun.length > 0, 'no check carried a runId — `failure --full` cannot find a bundle');
  // The bundle version is derived from it, so undefined here silently 404s at retrieval time.
  for (const c of withRun) assert.equal(typeof c.runId, 'number', `runId should be numeric, got ${typeof c.runId}`);
});

test('(z2) the runId matches the run for that context\'s OWN event', () => {
  // Same job, two events, two different runs — picking the wrong one fetches the wrong bundle.
  const runs = fixture('runs-cancelled.json').workflow_runs;
  const v = computeMergeVerdict(statusesOf('status-cancelled.json'), { event: 'pull_request', runs });
  const check = v.all.find((c) => c.job === 'app-ci / app-e2e');
  const expected = findRunForContext('app-ci / app-e2e (pull_request)', runs);
  assert.equal(check.runId, expected.id);
});

// ================================================================================================
// Silent-wrong-answer guards. Every case below returned a plausible but WRONG result before the fix.
// ================================================================================================

import { exitCodeForVerdict, parseTargetArgs } from '../ci-status.mjs';

test('(aa) NO statuses yet is not "mergeable" — it is "waiting"', () => {
  // The window between `git push` and the forge posting its first status. `[].every()` is true, so
  // an empty required set rendered as green and `watch` exited immediately instead of waiting.
  const v = computeMergeVerdict([]);
  assert.equal(v.mergeable, false, 'a commit with no reported checks was declared mergeable');
  assert.ok(v.waiting.length > 0 || v.noResults, 'nothing signalled that results are simply absent');
});

test('(aa2) a zero-match GLOB is still satisfied — the empty case is about the whole set', () => {
  // Guards the fix against over-correcting: an absent individual required context must still not
  // hold the verdict hostage (that mirrors branch protection).
  const v = computeMergeVerdict(statusesOf('status-all-green.json'), {
    event: 'push',
    requiredGlobs: [...REQUIRED_CONTEXT_GLOBS, 'never-matches*'],
  });
  assert.equal(v.mergeable, true);
});

test('(bb) a wholly superseded commit is WAITING, not mergeable and not exit-0', () => {
  // mergeable was false while the exit code was 0 — the two things a caller keys on disagreed, so
  // `ci-status status && merge` would merge a commit whose CI never actually passed.
  const runs = fixture('runs-cancelled.json').workflow_runs;
  const v = computeMergeVerdict(statusesOf('status-cancelled.json'), { event: 'pull_request', runs });
  assert.equal(v.mergeable, false);
  assert.equal(exitCodeForVerdict(v), 3, 'a superseded commit reported success to a caller');
});

test('(bb3) exit code and mergeable never disagree', () => {
  for (const [name, statuses, opts] of [
    ['green', statusesOf('status-all-green.json'), { event: 'push' }],
    ['skipped', statusesOf('status-skipped.json'), { event: 'pull_request' }],
    ['waiting', statusesOf('status-waiting.json'), { event: 'pull_request' }],
    ['failed', statusesOf('status-genuine-failure.json'), { event: 'pull_request' }],
    ['advisory', statusesOf('status-advisory-failure.json'), { event: 'pull_request' }],
    ['empty', [], {}],
  ]) {
    const v = computeMergeVerdict(statuses, opts);
    const code = exitCodeForVerdict(v);
    assert.equal(code === 0, v.mergeable === true, `${name}: exit ${code} but mergeable=${v.mergeable}`);
  }
});

test('(cc) the digest tool\'s OWN commit status is not reported as an advisory failure', () => {
  // ci-failure-digest posts `ci-digest / <job>` with state=failure. Without excluding it, the
  // diagnostic tool lists itself among the failures it is trying to explain.
  const statuses = [
    ...statusesOf('status-all-green.json'),
    { id: 99, status: 'failure', context: 'ci-digest / app-e2e (push)', description: 'see bundle' },
  ];
  const v = computeMergeVerdict(statuses, { event: 'push' });
  assert.equal(v.advisory.some((c) => c.job.startsWith('ci-digest')), false,
    'the digest tool reported itself as a failure');
  assert.equal(v.mergeable, true);
});

test('(dd) a flag with no value is REJECTED, not silently retargeted to HEAD', () => {
  // `--pr $PR` with PR unset used to fall through to the local HEAD and print a verdict for a
  // completely different commit, with no warning.
  assert.throws(() => parseTargetArgs(['status', '--pr']), /requires a value/i);
  assert.throws(() => parseTargetArgs(['status', '--sha']), /requires a value/i);
  assert.throws(() => parseTargetArgs(['watch', '--timeout']), /requires a value/i);
  assert.throws(() => parseTargetArgs(['watch', '--timeout', 'abc']), /number/i);
  assert.deepEqual(parseTargetArgs(['status', '--pr', '82']).target.pr, '82');
});

test('(ee) an unsuffixed context is selected once, not twice', () => {
  // Duplicated required contexts would double-count in blocking/waiting.
  const statuses = [
    { status: 'success', context: 'legacy-context', description: '' },
    { status: 'success', context: 'app-ci / affected (push)', description: '' },
  ];
  // With event=null only the unsuffixed context applies — and it must appear ONCE. The bug was
  // that it matched both the `event` filter and the `unsuffixed` filter and was concatenated twice.
  const forNull = selectEventContexts(statuses, null);
  assert.equal(forNull.length, 1);
  assert.equal(new Set(forNull.map((s) => s.context)).size, forNull.length, 'a context was duplicated');
  // A real event picks up its own contexts PLUS the unsuffixed one, each once.
  for (const ev of ['push', 'pull_request']) {
    const sel = selectEventContexts(statuses, ev);
    assert.equal(new Set(sel.map((s) => s.context)).size, sel.length, `duplicate for ${ev}`);
  }
  assert.equal(selectEventContexts(statuses, 'push').length, 2);
  assert.equal(selectEventContexts(statuses, 'pull_request').length, 1);
});

test('(ff) the caller can force which event to resolve', () => {
  // Found by dogfooding PR #83: the push contexts had already succeeded while the pull_request
  // contexts were still queued. inferEvent always prefers pull_request, so there was no way to ask
  // for the push view of a commit that also belongs to a PR.
  const all = statusesOf('status-cancelled.json');
  assert.equal(computeMergeVerdict(all, { event: 'push' }).event, 'push');
  assert.equal(computeMergeVerdict(all, { event: 'pull_request' }).event, 'pull_request');
  // The two genuinely differ, which is the whole point.
  const push = computeMergeVerdict(all, { event: 'push' });
  const pr = computeMergeVerdict(all, { event: 'pull_request' });
  assert.notDeepEqual(push.all.map((c) => c.state), pr.all.map((c) => c.state));
});

test('(gg) the REAL forge wording for skipped and cancelled is recognised', () => {
  // Measured, not guessed. An earlier version matched /^skipped/i because a HAND-AUTHORED fixture
  // said "Skipped"; the forge actually says "Has been skipped", so a path-gated job rendered as
  // "passed" and an operator would believe it had run. Observed on PR #83's trigger-cd.
  assert.equal(classifyCheckState({ status: 'success', description: 'Has been skipped' }), 'skipped');
  assert.equal(classifyCheckState({ status: 'failure', description: 'Has been cancelled' }), 'superseded');
  // Bare forms too, in case the wording is shortened upstream.
  assert.equal(classifyCheckState({ status: 'success', description: 'Skipped' }), 'skipped');
  assert.equal(classifyCheckState({ status: 'failure', description: 'Cancelled' }), 'superseded');
});

test('(gg2) a genuine failure whose message merely CONTAINS the word is not reclassified', () => {
  // Anchoring matters: an unanchored match would turn a real break into "superseded" — silently
  // hiding it, which is the loud-failure direction inverted.
  assert.equal(classifyCheckState({ status: 'failure', description: 'Failed: 3 tests cancelled early' }), 'failed');
  assert.equal(classifyCheckState({ status: 'success', description: 'Ran 12 suites, 0 skipped' }), 'passed');
});

test('(gg3) a skipped required check still SATISFIES the merge verdict', () => {
  // The verdict was already correct before the wording fix (both passed and skipped satisfy) —
  // this pins that the display fix did not change the gate.
  const v = computeMergeVerdict(statusesOf('status-skipped.json'), { event: 'pull_request' });
  assert.equal(v.mergeable, true);
  assert.ok(v.all.some((c) => c.state === 'skipped'), 'the fixture no longer exercises a skip');
});

test('(hh) a non-PR failure resolves its bundle from (runId, job) — no status needed', async () => {
  // T040: the commit status is gone (403, needs write:repository). The reader derives the pointer
  // the status used to carry, using the runId now on every check.
  const { bundleVersion } = await import('../ci-failure-digest.mjs');
  // Deliberately no `runs`: pairing the cancelled-run fixture with these statuses would classify
  // everything as superseded and leave `blocking` empty — which is correct behaviour, and was my
  // test-setup error the first time round.
  const v = computeMergeVerdict(statusesOf('status-genuine-failure.json'), { event: 'pull_request' });
  const failed = v.blocking[0];
  assert.ok(failed, 'fixture no longer contains a failing required check');
  // The read side must be able to name a bundle without consulting any commit status.
  const jobName = failed.job.split('/').pop().trim();
  assert.match(bundleVersion(986, jobName), /^986--/);
});
