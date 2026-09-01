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
  detachedHeadWarning,
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
// 054 T001/T002 — a context accumulates one status per state transition; only the NEWEST counts.
//
// A job that fails and is then re-run successfully on the same event leaves BOTH a `failure` and a
// `success` for one context. Before this, `computeMergeVerdict` mapped over every status without
// collapsing, so the stale `failure` still landed in `blocking` and the same context could appear
// twice in one verdict — as `passed` AND `failed`. Reported as backlog item #176; the reproduction
// below is the one written into that item.
//
// Fails CLOSED, which is why it was a p3 and not a p1: it never called a broken PR mergeable. It
// sent the reader diagnosing a failure that was already resolved, which is the human-in-the-loop
// cost feature 042 exists to remove.
// ================================================================================================

const CTX = 'guardrails / naming (pull_request)';
const statusAt = (status, created_at, context = CTX) => ({ context, status, created_at });

test('(ww) a stale failure re-run to success on the SAME event resolves to passed', () => {
  const v = computeMergeVerdict(
    [statusAt('failure', '2026-08-11T10:00:00Z'), statusAt('success', '2026-08-11T10:30:00Z')],
    { requiredGlobs: ['guardrails*'], event: 'pull_request' },
  );
  assert.equal(v.blocking.length, 0, 'a stale failure still blocked after a successful re-run');
  assert.equal(v.mergeable, true, 'reported NOT mergeable for a commit the forge would merge');
});

test('(ww2) NEWEST WINS IN BOTH DIRECTIONS — a newer failure after an older success blocks', () => {
  // The dangerous direction, and the one an "any success passes" shortcut gets wrong: a job that
  // passed and was then re-run into a genuine failure must block.
  const v = computeMergeVerdict(
    [statusAt('success', '2026-08-11T10:00:00Z'), statusAt('failure', '2026-08-11T10:30:00Z')],
    { requiredGlobs: ['guardrails*'], event: 'pull_request' },
  );
  assert.equal(v.blocking.length, 1, 'a newer genuine failure was absorbed by an older success');
  assert.equal(v.mergeable, false);
});

test('(ww3) no context appears more than once in a verdict', () => {
  const v = computeMergeVerdict(
    [
      statusAt('failure', '2026-08-11T10:00:00Z'),
      statusAt('success', '2026-08-11T10:30:00Z'),
      statusAt('success', '2026-08-11T10:45:00Z'),
    ],
    { requiredGlobs: ['guardrails*'], event: 'pull_request' },
  );
  const seen = v.all.map((c) => c.context);
  assert.equal(seen.length, new Set(seen).size, `one context reported twice: ${seen.join(', ')}`);
  assert.equal(v.all.length, 1);
});

test('(ww4) the collapse is per EVENT-SUFFIXED context — push and pull_request stay independent', () => {
  // The event-suffix rule (case (u)) must survive the collapse: `foo (push)` and
  // `foo (pull_request)` are different checks that can legitimately disagree. Keying the collapse
  // on the job name rather than the full context string would silently merge them.
  const all = [
    statusAt('failure', '2026-08-11T10:00:00Z', 'guardrails / naming (push)'),
    statusAt('success', '2026-08-11T10:30:00Z', 'guardrails / naming (pull_request)'),
  ];
  const pr = computeMergeVerdict(all, { requiredGlobs: ['guardrails*'], event: 'pull_request' });
  const push = computeMergeVerdict(all, { requiredGlobs: ['guardrails*'], event: 'push' });

  // The COLLAPSE keeps them apart — each view holds exactly its own context, with its own state.
  // That is what this case exists to guard, and it is asserted directly rather than inferred from
  // the verdict.
  assert.deepEqual(pr.all.map((c) => c.context), ['guardrails / naming (pull_request)']);
  assert.deepEqual(pr.all.map((c) => c.state), ['passed'],
    "the push context's failure was merged into the pull_request context");
  assert.deepEqual(push.all.map((c) => c.context), ['guardrails / naming (push)']);
  assert.equal(push.blocking.length, 1, "the pull_request success masked the push context's failure");

  // CORRECTED 2026-09-01 (item #281). This case used to assert `pr.mergeable === true` — that a
  // failing push context leaves the commit mergeable in the PR view. That assertion WAS the bug:
  // every branch-protection glob ends in `*`, so `guardrails*` matches both event-suffixed
  // contexts and the forge refuses the merge with 405. The tool said mergeable three times over a
  // commit that was not (PR #276, PR #263). The collapse is per-context; the VERDICT is
  // whole-commit, and must see the failure from either view.
  assert.equal(pr.mergeable, false, 'a failing required push context must block the PR view too');
  assert.deepEqual(pr.gate.blocking.map((c) => c.context), ['guardrails / naming (push)']);
});

test('(ww5) statuses sharing a created_at collapse deterministically — later entry wins', () => {
  // Equal timestamps are reachable: the forge stamps to the second. Without a stable tiebreak the
  // verdict would depend on sort implementation, which is a coin-flip verdict rather than a wrong
  // one — harder to notice and harder to reproduce.
  const same = '2026-08-11T10:00:00Z';
  const v = computeMergeVerdict([statusAt('failure', same), statusAt('success', same)], {
    requiredGlobs: ['guardrails*'],
    event: 'pull_request',
  });
  assert.equal(v.all.length, 1);
  assert.equal(v.mergeable, true, 'the tiebreak did not take the later array entry');
});

// ================================================================================================
// T026 — reading the published digest back.
// ================================================================================================

import { extractDigests, DIGEST_MARKER_RE, describeFilteredOutDigests } from '../ci-status.mjs';

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

test('(x2b) THE BUG: --job accepts the "workflow / job" CONTEXT form this tool itself prints', () => {
  // Measured 2026-08-30, PR #289. `ci-status failure --pr 289 --job "infra-image-scan / infra-image-scan"`
  // reported "no digest was published" for a digest that was sitting on the PR the whole time. The
  // marker carries the BARE job name (`job=infra-image-scan`); the `--job` value a reader naturally
  // passes is the CONTEXT string from this tool's own status table (`infra-image-scan / infra-image-scan`),
  // and `d.job === job` matched neither. Every other consumer in ci-status.mjs normalises with
  // `c.job.split('/').pop().trim()` — this one path did not.
  //
  // The cost was not the typo: the mismatch reads as ABSENCE, so it sent a whole session into an
  // hour of local Trivy reproduction to re-derive five findings the digest already named.
  const comments = [
    { id: 2, body: '<!-- ci-digest:job=infra-image-scan -->\nA' },
    { id: 3, body: '<!-- ci-digest:job=app-e2e -->\nB' },
  ];
  assert.equal(extractDigests(comments, 'infra-image-scan / infra-image-scan').length, 1,
    'the context form matched nothing — an unmatched filter reads as "no digest exists"');
  assert.equal(extractDigests(comments, 'app-ci / app-e2e').length, 1);
  // The bare form must keep working — it is what the non-PR bundle path already passes.
  assert.equal(extractDigests(comments, 'app-e2e').length, 1);
});

test('(x2c) a genuinely absent job still matches nothing — normalisation must not become a wildcard', () => {
  const comments = [{ id: 2, body: '<!-- ci-digest:job=app-e2e -->\nA' }];
  assert.equal(extractDigests(comments, 'guardrails / sast').length, 0);
  assert.equal(extractDigests(comments, 'nope').length, 0);
  assert.equal(extractDigests(comments, 'app-ci / ').length, 0, 'an empty job half must not match everything');
});

test('(x2d) a --job that filters every digest out says SO, instead of reporting absence', () => {
  // The deeper half of the (x2b) defect: normalising the filter fixes the case that was measured,
  // but any future mismatch would go straight back to rendering as "no digest was published". A
  // filter that matches nothing when candidates EXIST must fail closed and name what is available.
  const all = [{ job: 'app-e2e' }, { job: 'sast' }];
  const lines = describeFilteredOutDigests(all, 'guardrails / okf');
  assert.ok(lines.length > 0, 'a filtered-out selection produced no explanation at all');
  const text = lines.join('\n');
  assert.match(text, /okf/, 'the message does not name the filter that matched nothing');
  assert.match(text, /app-e2e/, 'the message does not name the digests that DO exist');
  assert.match(text, /sast/);
});

test('(x2e) genuine absence stays silent here — this must not manufacture a false positive', () => {
  // No digests at all is the real absence case, and renderDigestAbsence already owns it.
  assert.deepEqual(describeFilteredOutDigests([], 'guardrails / okf'), []);
  // No filter means nothing was filtered out.
  assert.deepEqual(describeFilteredOutDigests([{ job: 'app-e2e' }], null), []);
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
  // Compare RESOLVED to RESOLVED. `safeBundleEntryPath` returns `resolve(root, …)`, and on Windows
  // `resolve` prepends the current drive while `join` does not — so the old `join(root, …)`
  // expectation failed there with `expected '\tmp\bundle-root\logs\app.log'`, `actual
  // 'E:\tmp\bundle-root\logs\app.log'`. A developer's suite went red for a reason that was not their
  // fault, which trains people to ignore red.
  //
  // Do NOT relax this to `endsWith` or a substring check. It looks like the same assertion and is
  // not: this block guards a zip-slip path that turns a compromised CI token into arbitrary file
  // write on a developer's machine, and a suffix match would accept an escape from the bundle root.
  // Cases (y2)-(y4) below assert `throws` and are drive-agnostic already. T041 mutation-checks that
  // this change did not weaken them.
  const root = '/tmp/bundle-root';
  assert.equal(safeBundleEntryPath(root, 'logs/app.log'), resolve(root, 'logs/app.log'));
  assert.equal(safeBundleEntryPath(root, 'health/mongo.json'), resolve(root, 'health/mongo.json'));
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

// ================================================================================================
// Security hardening (042-security-hardening) — reader-side.
// ================================================================================================

import {
  stripControlChars,
  safeBundleWrite,
  MAX_INFLATED_BYTES,
  parseBundleGz,
} from '../ci-status.mjs';
import { gzipSync } from 'node:zlib';

test('(ii) a gzip bomb is refused, not inflated to OOM', () => {
  // 60 KB gzip → 60 MB inflated. gunzipSync default cap is ~2 GiB (effectively none). A hostile
  // bundle (write:package is in PR-job scope) would OOM the developer's machine on `failure --full`.
  const bomb = gzipSync(Buffer.alloc(MAX_INFLATED_BYTES * 2, 0));
  assert.throws(() => parseBundleGz(bomb), /exceed|too large|inflat/i);
});

test('(ii2) a normal bundle parses fine', () => {
  const ok = gzipSync(Buffer.from(JSON.stringify({ files: [{ path: 'a.log', text: 'hi' }], meta: {} })));
  assert.deepEqual(parseBundleGz(ok).files, [{ path: 'a.log', text: 'hi' }]);
});

test('(jj) control chars (ANSI/OSC/cursor) are stripped from reader output; \\n and \\t kept', () => {
  // emit() redacts creds/host but must also neutralise terminal escapes an attacker put in a log or
  // a spoofed PR comment (cursor-rewrite, OSC 52 clipboard, hyperlink spoof).
  const evil = 'green\x1b[2K\x1b]52;c;BASE64\x07 safe to merge\x1b[A';
  const out = stripControlChars(evil);
  assert.equal(/\x1b|\x07|\x9b/.test(out), false, 'an escape survived');
  assert.equal(stripControlChars('line1\nline2\tcol'), 'line1\nline2\tcol', 'newline/tab were stripped');
});

test('(kk) a malformed manifest entry is skipped, not fatal to the whole --full', () => {
  // Was: writeFileSync sat outside the try, so `text: null` threw and abandoned every later entry.
  const dir = mkdtempSync(join(tmpdir(), 'ci-bundle-'));
  const files = [
    { path: 'good.log', text: 'ok' },
    { path: 'bad.log', text: null },
    { path: 'good2.log', text: 'also ok' },
  ];
  const written = safeBundleWrite(dir, files);
  assert.equal(written.includes('good.log'), true);
  assert.equal(written.includes('good2.log'), true, 'a malformed middle entry aborted the rest');
  assert.equal(written.includes('bad.log'), false, 'the malformed entry was written anyway');
});

test('(ll) a marker NOT at the start of a comment is not treated as a digest (anti-spoof/anchor)', () => {
  const comments = [
    { id: 1, body: 'nice work! <!-- ci-digest:job=app-e2e -->', user: { login: 'attacker' } },   // mid-body → ignored
    { id: 2, body: '<!-- ci-digest:job=app-e2e -->\n### real', user: { login: 'ci-bot' } },        // anchored → real
  ];
  const found = extractDigests(comments, 'app-e2e');
  assert.equal(found.length, 1);
  assert.equal(found[0].id, 2);
  assert.equal(found[0].author, 'ci-bot');
});

test('(mm) fetchWithTimeout aborts a slow request rather than hanging', async () => {
  const { fetchWithTimeout } = await import('../ci-status.mjs');
  // point at a black-hole port; a 150ms timeout must reject quickly, not hang.
  await assert.rejects(
    fetchWithTimeout('http://10.255.255.1:9/never', {}, 150),
    /timed out|fetch failed|abort/i,
  );
});

import { parseRequiredGlobs, resolveRequiredGlobs } from '../ci-status.mjs';

// --- (nn)-(tt) required contexts come from BRANCH PROTECTION, not a hand-maintained list --------
//
// Regression for a MEASURED miss (2026-07-26, PR #103): the hardcoded REQUIRED_CONTEXT_GLOBS held
// five globs while `main` actually required six — `infra-image-scan / infra-image-scan*` had been
// added with feature 035 and never mirrored here. ci-status printed `VERDICT mergeable` + exit 0
// while the forge answered the merge call with 405 "Not all required status checks successful".
// The error direction is the dangerous one for automation: it over-reports mergeable.

test('(nn) the live protection payload is parsed into the required globs', () => {
  const globs = parseRequiredGlobs(fixture('branch-protections.json'), 'main');
  assert.deepEqual(globs, [
    'guardrails*',
    'app-ci / changes*',
    'app-ci / affected*',
    'app-ci / mc-service-checks*',
    'app-ci / app-e2e*',
    'infra-image-scan / infra-image-scan*',
  ]);
});

test('(nn2) THE BUG: infra-image-scan is required, so a pending one is NOT mergeable', () => {
  // Exactly the PR #103 shape: every glob in the old hardcoded five is green, and the sixth —
  // which branch protection really requires — is still pending. Old behaviour: mergeable. Correct
  // behaviour: waiting.
  const statuses = [
    { context: 'guardrails / sast (pull_request)', status: 'success' },
    { context: 'app-ci / changes (pull_request)', status: 'success' },
    { context: 'app-ci / affected (pull_request)', status: 'success' },
    { context: 'app-ci / mc-service-checks (pull_request)', status: 'success' },
    { context: 'app-ci / app-e2e (pull_request)', status: 'success' },
    { context: 'infra-image-scan / infra-image-scan (pull_request)', status: 'pending' },
  ];
  const globs = parseRequiredGlobs(fixture('branch-protections.json'), 'main');
  const v = computeMergeVerdict(statuses, { requiredGlobs: globs, event: 'pull_request' });
  assert.equal(v.mergeable, false, 'reported mergeable while a required check was pending');
  assert.equal(v.waiting.length, 1);
  assert.equal(v.waiting[0].job, 'infra-image-scan / infra-image-scan');
  assert.equal(exitCodeForVerdict(v), 3, 'exit 0 here would let a `status && merge` wrapper 405');
});

test('(oo) the built-in fallback is a SUBSET of the live protection — it may lag, never over-claim', () => {
  // A fallback glob that branch protection does NOT require would mark a check required that isn't,
  // blocking a mergeable PR. Missing globs are the tolerable direction (caught by the live fetch);
  // extra ones are not. This is the assertion that would have flagged the drift as it happened.
  const live = parseRequiredGlobs(fixture('branch-protections.json'), 'main');
  for (const g of REQUIRED_CONTEXT_GLOBS) {
    assert.ok(live.includes(g), `fallback glob ${JSON.stringify(g)} is not required by branch protection`);
  }
});

test('(oo2) the built-in fallback also carries the glob whose absence caused the miss', () => {
  // Belt and braces: the live fetch is the fix, but the fallback must not ship known-stale.
  assert.ok(
    REQUIRED_CONTEXT_GLOBS.includes('infra-image-scan / infra-image-scan*'),
    'the fallback list is missing the very glob that produced the 405',
  );
});

test('(pp) a glob rule_name matches by pattern, not just by literal name', () => {
  const globs = parseRequiredGlobs(fixture('branch-protections.json'), 'release/2026.07');
  assert.deepEqual(globs, ['guardrails*']);
});

test('(qq) a rule with status checks DISABLED contributes nothing', () => {
  assert.equal(parseRequiredGlobs(fixture('branch-protections.json'), 'legacy-no-checks'), null);
});

test('(rr) an unprotected branch yields null, so the caller falls back rather than treating it as "nothing required"', () => {
  // Returning [] here would make every check non-required and EVERYTHING mergeable — the same
  // over-reporting failure in a louder disguise.
  assert.equal(parseRequiredGlobs(fixture('branch-protections.json'), 'some/feature/branch'), null);
});

test('(ss) a malformed / empty payload yields null instead of throwing', () => {
  for (const bad of [null, undefined, [], {}, [{ rule_name: 'main' }], 'nonsense']) {
    assert.equal(parseRequiredGlobs(bad, 'main'), null, `threw or over-claimed on ${JSON.stringify(bad)}`);
  }
});

test('(tt) resolveRequiredGlobs falls back to the built-in list when the fetch fails, and says so', async () => {
  // A 403 (token without the scope) or an offline forge must NOT abort the whole command — a
  // degraded verdict beats no verdict. But it MUST be visible, or this silently becomes the same
  // hand-maintained list the bug came from.
  const failing = async () => { throw new Error('403'); };
  const r = await resolveRequiredGlobs(failing, 'main');
  assert.deepEqual(r.globs, REQUIRED_CONTEXT_GLOBS);
  assert.equal(r.source, 'fallback');
  assert.match(r.note, /branch protection/i);

  const ok = async () => fixture('branch-protections.json');
  const live = await resolveRequiredGlobs(ok, 'main');
  assert.equal(live.source, 'branch-protection');
  assert.equal(live.globs.length, 6);
});

// --- (uu) the EXIT PATH must actually return the contracted code -------------------------------
//
// Measured on the Windows host (2026-07-26): the process died with -1073740791 (0xC0000409,
// Windows' __fastfail abort) where the contract says 3. Output was correct every time; only the
// exit path died — and CLAUDE.md tells agents to BRANCH on this code, so an abort reads as a
// crashed tool and loses the "runner starvation, not failure" signal. Cause: `process.exit()`
// tearing down while stdout was flushing and undici keep-alive sockets were still open.
//
// These spawn the real script, so they exercise the whole exit path — not a mocked resolver. Only
// the three OFFLINE, token-free codes are asserted here (the suite must stay network-free); the
// exit-3 verdict path is covered structurally by (nn2)/exitCodeForVerdict above.

import { spawnSync } from 'node:child_process';

const SCRIPT = resolve(HERE, '..', 'ci-status.mjs');
const runScript = (args, env = {}) =>
  spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, MCM_FORGE_TOKEN: 'x'.repeat(40), ...env },
    timeout: 30_000,
  });

test('(uu) an unknown command exits 2 — a real number, not an abort/signal', () => {
  const r = runScript(['bogus-command']);
  assert.equal(r.status, 2, `expected 2, got ${r.status} (signal=${r.signal})`);
  assert.equal(r.signal, null, 'died by signal instead of exiting');
});

test('(uu2) a missing token exits 2 and names the variable', () => {
  const r = runScript(['status'], { MCM_FORGE_TOKEN: '' });
  assert.equal(r.status, 2, `expected 2, got ${r.status} (signal=${r.signal})`);
  assert.match(r.stderr, /MCM_FORGE_TOKEN/);
});

test('(uu3) --selftest exits 0 and its output is not truncated by the exit', () => {
  const r = runScript(['--selftest']);
  assert.equal(r.status, 0, `expected 0, got ${r.status} (signal=${r.signal})`);
  // The final line must be present: process.exit() mid-flush is exactly how it used to vanish.
  assert.match(r.stdout, /selftest\] traps classified/);
});

test('(uu4) the exit path does not call process.exit() on the happy path', () => {
  // Guard the FIX, not just the symptom: a future edit reintroducing `.then(code => process.exit(code))`
  // would restore the Windows abort while every assertion above still passed on Linux.
  const src = readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(src, /\.then\(\s*\(?code\)?\s*=>\s*process\.exit/, 'process.exit() is back on the resolve path');
  assert.match(src, /process\.exitCode = code/, 'exitWith no longer sets process.exitCode');
  assert.match(src, /setTimeout\(\(\) => process\.exit\(code\), \d+\)\.unref\(\)/, 'the force-exit fallback must stay unref\'d');
});

// --- detached head (AGit) ------------------------------------------------------------------------
// A PR whose head is refs/pull/N/head runs WITHOUT Actions secrets, so every ${{ secrets.* }} is
// empty and any nx-cached job dies reporting a cache misconfiguration. The condition is invisible in
// the web UI. Regression-pinned because reading those failures as a code fault cost two sessions a
// full day on 2026-08-01.

test('(vv) a refs/pull/N/head head ref is reported as detached', () => {
  const warning = detachedHeadWarning('refs/pull/126/head');
  assert.ok(warning, 'expected a warning for a non-branch head');
  assert.match(warning, /DETACHED HEAD/);
  assert.match(warning, /refs\/pull\/126\/head/);
  // The warning must state the CONSEQUENCE, not just the condition — the condition alone is what
  // everyone already saw and dismissed.
  assert.match(warning, /secrets/i);
});

test('(vv2) a real branch head ref produces no warning', () => {
  for (const ref of ['main', 'fix/nx-wrapper-entry-path', 'renovate/npm-nx-vulnerability']) {
    assert.equal(detachedHeadWarning(ref), null, `${ref} is a real branch and must not warn`);
  }
});

test('(vv3) a missing or non-string head ref never throws', () => {
  // --sha and --branch targets carry no head ref at all; the renderer must stay silent, not crash.
  for (const ref of [null, undefined, 42, {}, '']) {
    assert.equal(detachedHeadWarning(ref), null);
  }
});

test('(vv4) a branch merely NAMED like a pull ref is not mistaken for one', () => {
  // Only the exact refs/pull/<digits>/head shape is detached; a lookalike branch is trusted.
  assert.equal(detachedHeadWarning('refs/pull/abc/head'), null);
  assert.equal(detachedHeadWarning('my/refs/pull/1/head'), null);
  assert.equal(detachedHeadWarning('refs/pull/1/merge'), null);
});

test('(vv5) a CLOSED/merged PR whose branch was deleted is NOT reported detached', () => {
  // Forgejo reverts head.ref to refs/pull/N/head once the branch is gone, so a routinely tidied-up
  // merged PR looks identical to an AGit one. Measured on #125: opened from a real branch, passed
  // every required check, then flagged only because cleanup deleted the branch. Warning there calls
  // a correctly-run green PR untrustworthy — the exact inversion this tool exists to prevent.
  assert.equal(detachedHeadWarning('refs/pull/125/head', { prState: 'closed' }), null);
  assert.ok(detachedHeadWarning('refs/pull/126/head', { prState: 'open' }), 'an OPEN detached PR must still warn');
});

test('(vv6) an unknown PR state still warns — fail loud, not silent', () => {
  // If the API omits `state`, the safe default is to warn: a missed detached head costs a day of
  // misdirected debugging, whereas a spurious warning on a merged PR costs one glance.
  assert.ok(detachedHeadWarning('refs/pull/126/head', {}));
  assert.ok(detachedHeadWarning('refs/pull/126/head', { prState: null }));
});

// --- (z) the reporter distinguishes a BROKEN digest from an ABSENT one (feature 051 US3) ---------
//
// "The digest ran and failed" and "no digest was needed" rendered identically: both produced
// "no digest was published for them". The reader believes the second, because it is the ordinary
// case — and on 2026-08-01 that is exactly what happened. The digest had collected the evidence and
// thrown it away for want of a credential, and the report said nothing had been published, which
// was true and useless.
//
// Loaded per-case, not at module scope: a static import of a not-yet-existing export throws at LOAD
// time and takes every other case in this file with it, which makes the collected count meaningless.

const statusModule = () => import('../ci-status.mjs');

test('(z) a `failed` outcome is NEVER rendered with the "no digest was published" wording', async () => {
  const { renderDigestAbsence } = await statusModule();
  const lines = renderDigestAbsence(
    [{ job: 'guardrails / naming', description: 'failing' }],
    [{ job: 'naming', outcome: 'failed', detail: 'no-credential', summary: 'no usable credential was available' }],
  ).join('\n');

  assert.doesNotMatch(
    lines,
    /no digest was published/i,
    'a BROKEN digest was reported as an absent one — the 2026-08-01 failure, reproduced',
  );
  assert.match(lines, /ran and FAILED/i, 'the report does not say the digest itself is broken');
  assert.match(lines, /no-credential/, 'the sub-reason, which implies the next action, was dropped');
});

test('(z2) each `failed` sub-reason points at its OWN next action', async () => {
  const { renderDigestAbsence } = await statusModule();
  const of = (detail) =>
    renderDigestAbsence(
      [{ job: 'g / naming', description: 'failing' }],
      [{ job: 'naming', outcome: 'failed', detail, summary: 's' }],
    ).join('\n');

  // Three different faults, three different things to do. Collapsing them leaves the reader as
  // stuck as an absent digest does.
  assert.match(of('no-credential'), /secret/i, 'no-credential must point at the run\'s secrets');
  assert.match(of('forbidden'), /scope/i, 'forbidden must point at the missing scope');
  assert.match(of('transport'), /retry|forge/i, 'transport must point at a retry or the forge');
});

test('(z3) a genuinely absent digest KEEPS the original wording — the string is not simply retired', async () => {
  const { renderDigestAbsence } = await statusModule();
  // The reserved wording is still correct for `not-needed` and for the job-died-early case. A fix
  // that removed it everywhere would trade one wrong answer for another.
  const lines = renderDigestAbsence([{ job: 'g / naming', description: 'failing' }], []).join('\n');
  assert.match(lines, /no digest was published/i);
  assert.match(lines, /died BEFORE the digest step ran/i, 'the diagnosis for a genuine absence was lost');
});

test('(z4) `not-needed` is not reported as a fault at all', async () => {
  const { renderDigestAbsence } = await statusModule();
  const lines = renderDigestAbsence(
    [{ job: 'g / naming', description: 'failing' }],
    [{ job: 'naming', outcome: 'not-needed', detail: null, summary: 'no digest was needed' }],
  ).join('\n');
  assert.doesNotMatch(lines, /ran and FAILED/i, '`not-needed` was rendered as a broken digest');
});

// ─── item #281 — the verdict must evaluate what BRANCH PROTECTION evaluates ──────────────────────
//
// Measured three times (PR #276 2026-08-29, two dependency PRs the same day, PR #263 2026-09-01):
// `status`/`watch` reported "mergeable" and the merge API answered 405. Branch-protection globs all
// end in `*`, so `infra-image-scan / infra-image-scan*` matches BOTH event-suffixed contexts, while
// the tool pre-filtered to one event and never saw the failing one.
//
// The event filter is NOT the bug and must stay: it exists so a superseded commit does not read as
// failed (test (u)). The bug is that it also narrowed the VERDICT. `--event` narrows a VIEW.
import { computeMergeVerdict as verdict281, exitCodeForVerdict as exit281 } from '../ci-status.mjs';

const MIXED_EVENT_STATUSES = [
  { context: 'app-ci / app-e2e (pull_request)', status: 'success', description: 'Successful in 1s', created_at: '2026-09-01T00:00:01Z' },
  { context: 'infra-image-scan / infra-image-scan (pull_request)', status: 'success', description: 'Successful in 2s', created_at: '2026-09-01T00:00:02Z' },
  { context: 'infra-image-scan / infra-image-scan (push)', status: 'failure', description: 'Failing after 2m38s', created_at: '2026-09-01T00:00:03Z' },
];
const MIXED_GLOBS = ['app-ci / app-e2e*', 'infra-image-scan / infra-image-scan*'];

test('(#281a) a failing PUSH context makes the commit NOT mergeable, even in the pull_request view', () => {
  const v = verdict281(MIXED_EVENT_STATUSES, { event: 'pull_request', requiredGlobs: MIXED_GLOBS });
  assert.equal(v.mergeable, false,
    'reported mergeable while a required push-event context had failed — this is the 405');
});

test('(#281b) the exit code is 1 (a required context FAILED), not 3 (waiting)', () => {
  const v = verdict281(MIXED_EVENT_STATUSES, { event: 'pull_request', requiredGlobs: MIXED_GLOBS });
  assert.equal(exit281(v), 1, 'a `ci-status && merge` wrapper would have merged on this exit code');
});

test('(#281c) the gate names the off-view context, so the reader is not left guessing', () => {
  const v = verdict281(MIXED_EVENT_STATUSES, { event: 'pull_request', requiredGlobs: MIXED_GLOBS });
  const contexts = v.gate.blocking.map((c) => c.context);
  assert.deepEqual(contexts, ['infra-image-scan / infra-image-scan (push)']);
});

test('(#281d) the VIEW still honours --event — the fix must not collapse the two events', () => {
  const v = verdict281(MIXED_EVENT_STATUSES, { event: 'pull_request', requiredGlobs: MIXED_GLOBS });
  assert.equal(v.event, 'pull_request');
  assert.equal(v.all.every((c) => !c.context.includes('(push)')), true,
    'the pull_request view leaked a push context');
});

test('(#281e) REGRESSION GUARD — a superseded commit is still not reported as failed', () => {
  // This is the case the event filter was added for (test (u), measured 2026-07-19). Evaluating
  // every event must NOT resurrect it: cancelled classifies as `superseded`, never `failed`, so the
  // gate stays clean. If this ever goes red, the gate is counting cancelled contexts as failures.
  const v = verdict281(statusesOf('status-cancelled.json'), { event: 'push' });
  assert.equal(v.gate.blocking.length, 0, 'a cancelled context leaked into the gate as a failure');
  assert.equal(exit281(v), 3, 'a superseded commit must read as "no verdict yet", not as failed');
});

test('(#281f) a genuine single-event failure is unchanged', () => {
  const v = verdict281(statusesOf('status-genuine-failure.json'), { event: 'pull_request' });
  assert.equal(v.mergeable, false);
  assert.equal(exit281(v), 1);
});

import { describeOffViewGating } from '../ci-status.mjs';

test('(#281g) the off-view blocker is NAMED, with its event — the line that was missing', () => {
  const v = verdict281(MIXED_EVENT_STATUSES, { event: 'pull_request', requiredGlobs: MIXED_GLOBS });
  const lines = describeOffViewGating(v).join('\n');
  assert.match(lines, /ALSO GATING/);
  assert.match(lines, /infra-image-scan \/ infra-image-scan \(push\)/,
    'the blocking context was not named');
  assert.match(lines, /405/, 'the reader is not told why the merge will be refused');
});

test('(#281h) a commit whose events agree prints NO extra section — no noise on the happy path', () => {
  const green = [
    { context: 'app-ci / app-e2e (pull_request)', status: 'success', description: 'ok', created_at: '2026-09-01T00:00:01Z' },
    { context: 'app-ci / app-e2e (push)', status: 'success', description: 'ok', created_at: '2026-09-01T00:00:02Z' },
  ];
  const v = verdict281(green, { event: 'pull_request', requiredGlobs: ['app-ci / app-e2e*'] });
  assert.equal(v.mergeable, true);
  assert.deepEqual(describeOffViewGating(v), []);
});

test('(#281i) a context already visible in the view is not repeated in the extra section', () => {
  const v = verdict281(statusesOf('status-genuine-failure.json'), { event: 'pull_request' });
  assert.deepEqual(describeOffViewGating(v), [],
    'the failing context is in the table already; naming it twice is noise');
});

// ─── items #324 and #226 — the two commands that answer about the wrong commit ───────────────────
import { cmdWatch, resolveSha } from '../ci-status.mjs';

const FAKE_CONN = { base: 'http://forge.invalid/api/v1', owner: 'o', repo: 'r', token: 't' };
const SHA_A = 'a018d1f1ff3e796c7feb7b68ae50aed293bc6070';
const SHA_B = '43167af8df54b517703131e25ab0779144cbf72e';

/** Serve the three endpoints loadVerdict reads, with a scripted sequence of status payloads. */
function stubForge({ statusSequence = [[]], run = null } = {}) {
  const realFetch = globalThis.fetch;
  const calls = { status: 0, run: 0 };
  globalThis.fetch = async (url) => {
    const u = String(url);
    const json = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o) });
    if (u.includes('/branch_protections')) return json([]);
    if (/\/actions\/runs\/\d+/.test(u)) { calls.run += 1; return json(run ?? {}); }
    if (u.includes('/actions/runs?')) return json({ workflow_runs: [] });
    if (u.endsWith('/status')) {
      const i = Math.min(calls.status, statusSequence.length - 1);
      calls.status += 1;
      return json({ statuses: statusSequence[i] });
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

const quiet = async (fn) => {
  const real = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = real; }
};

const GREEN_STATUS = [{
  context: 'guardrails / naming (push)', status: 'success',
  description: 'Successful in 1s', created_at: '2026-09-01T00:00:01Z',
}];

test('(#324a) watch KEEPS POLLING when nothing has reported yet — it must not return instantly', async () => {
  // Measured 2026-08-31: `watch --pr 322 --timeout 5400` returned in ~2s with exit 3, the same code
  // it uses for "waited 90 minutes and CI is still queued". The caller cannot tell those apart, and
  // CLAUDE.md tells agents to branch on this exit code.
  const { calls, restore } = stubForge({ statusSequence: [[], [], GREEN_STATUS] });
  try {
    const code = await quiet(() =>
      cmdWatch({ sha: SHA_A }, FAKE_CONN, { timeoutSeconds: 60, intervalSeconds: 0 }));
    assert.ok(calls.status >= 3, `polled ${calls.status}x — it returned before anything reported`);
    assert.equal(code, 0, 'the eventual green verdict was not returned');
  } finally { restore(); }
});

test('(#324b) the timeout path still returns 3 and is still reached', async () => {
  const { calls, restore } = stubForge({ statusSequence: [[]] });
  try {
    const code = await quiet(() =>
      cmdWatch({ sha: SHA_A }, FAKE_CONN, { timeoutSeconds: 0, intervalSeconds: 0 }));
    assert.equal(code, 3, 'a genuine timeout must stay exit 3 — starvation is not failure');
    assert.ok(calls.status >= 1);
  } finally { restore(); }
});

test('(#324c) a settled commit still returns IMMEDIATELY — the fix must not poll every green', async () => {
  const { calls, restore } = stubForge({ statusSequence: [GREEN_STATUS] });
  try {
    const code = await quiet(() =>
      cmdWatch({ sha: SHA_A }, FAKE_CONN, { timeoutSeconds: 60, intervalSeconds: 0 }));
    assert.equal(code, 0);
    assert.equal(calls.status, 1, 'a green verdict was polled more than once');
  } finally { restore(); }
});

test('(#226a) `--run N` resolves the RUN\'s commit, not local HEAD', async () => {
  // `target.run` was parsed and then read by nothing at all: the usage line advertises the flag and
  // two error messages tell you to pass it. With no --sha/--pr/--branch, resolveSha fell through to
  // `git rev-parse HEAD`, so `failure --run 2477` reported on the working copy and said
  // "No failed jobs on this commit."
  const { calls, restore } = stubForge({ run: { id: 2477, commit_sha: SHA_B } });
  try {
    const resolved = await resolveSha({ run: '2477' }, FAKE_CONN);
    assert.equal(resolved.sha, SHA_B, 'resolved to the wrong commit (local HEAD?)');
    assert.equal(calls.run, 1, 'the run endpoint was never consulted');
  } finally { restore(); }
});

test('(#226b) an explicit --sha or --pr still wins over --run', async () => {
  const { calls, restore } = stubForge({ run: { id: 2477, commit_sha: SHA_B } });
  try {
    const resolved = await resolveSha({ sha: SHA_A, run: '2477' }, FAKE_CONN);
    assert.equal(resolved.sha, SHA_A);
    assert.equal(calls.run, 0, '--run should not be fetched when an explicit sha was given');
  } finally { restore(); }
});

import { failuresToExplain } from '../ci-status.mjs';

test('(#226c) `failure` sees a push-event failure even though the view infers pull_request', () => {
  // The bug that made (#226a) look unfixed: resolveSha found the right commit, then cmdFailure
  // read verdict.blocking (the pull_request VIEW, all green) and said "No failed jobs on this
  // commit" about a commit whose push-event sweep had failed.
  const v = verdict281(MIXED_EVENT_STATUSES, { requiredGlobs: MIXED_GLOBS });
  assert.deepEqual(
    failuresToExplain(v).map((c) => c.context),
    ['infra-image-scan / infra-image-scan (push)'],
  );
});

test('(#226d) a commit with nothing failing yields nothing to explain', () => {
  const v = verdict281(statusesOf('status-all-green.json'), { event: 'push' });
  assert.deepEqual(failuresToExplain(v), []);
});

import { describePending } from '../ci-status.mjs';

test('(#281j) a job waiting on BOTH events is disambiguated, not printed twice identically', () => {
  const waiting = [
    { job: 'infra-image-scan / infra-image-scan', context: 'infra-image-scan / infra-image-scan (push)' },
    { job: 'infra-image-scan / infra-image-scan', context: 'infra-image-scan / infra-image-scan (pull_request)' },
    { job: 'guardrails / sast', context: 'guardrails / sast (pull_request)' },
  ];
  assert.deepEqual(describePending(waiting), [
    'infra-image-scan / infra-image-scan (push)',
    'infra-image-scan / infra-image-scan (pull_request)',
    'guardrails / sast',
  ]);
});
