// Unit tests for the CI failure digest writer (feature 042, US2/US3).
//
// Runs in CI: guardrails/naming executes `node --test scripts/__tests__/*.test.mjs` (feature 041),
// so this file MUST stay deterministic, offline, token-free and node:-built-ins only. Nothing here
// touches the network — the publish layer is exercised through an injected transport.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDigest,
  digestMarker,
  findExistingComment,
  shouldPublish,
  tailLines,
  DEFAULT_CAPS,
} from '../ci-failure-digest.mjs';

const ctx = (over = {}) => ({
  workflow: 'app-ci',
  job: 'app-e2e',
  step: 'Run agent mobile flows (Maestro)',
  sha: 'c2c3c29593fa94b3fd6d2b90ba7aaa94ddbc4596',
  pr: 82,
  runId: 1247,
  runStatus: 'failure',
  ...over,
});

// --- (a) tail bias -------------------------------------------------------------------------------

test('(a) an excerpt is taken from the END of a source, not the beginning', () => {
  // Failures surface last. A head-biased excerpt is worthless — it shows the boot banner.
  const log = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n');
  const out = tailLines(log, 10);
  assert.match(out, /line 500/, 'the tail was dropped — the failure itself would be missing');
  assert.equal(/\bline 1\b/.test(out), false, 'head lines leaked into a tail-biased excerpt');
  assert.equal(out.split('\n').length, 10);
});

test('(a2) a source shorter than the cap is returned whole', () => {
  assert.equal(tailLines('a\nb\nc', 10), 'a\nb\nc');
});

// --- (b) caps are PER SOURCE, and truncation is stated --------------------------------------------

test('(b) the line cap applies per source, not across the digest as a whole', () => {
  const big = (n) => Array.from({ length: 400 }, (_, i) => `${n}:${i}`).join('\n');
  const d = buildDigest(ctx(), {
    excerpts: [
      { source: 'a.log', text: big('a') },
      { source: 'b.log', text: big('b') },
    ],
  });
  for (const src of ['a.log', 'b.log']) {
    const block = d.excerpts.find((e) => e.source === src);
    assert.ok(block, `${src} was dropped instead of capped`);
    assert.equal(block.text.split('\n').length, DEFAULT_CAPS.lines);
  }
});

test('(b2) truncation is STATED, never silent', () => {
  const log = Array.from({ length: 4812 }, (_, i) => `line ${i}`).join('\n');
  const d = buildDigest(ctx(), { excerpts: [{ source: 'big.log', text: log }] });
  const block = d.excerpts.find((e) => e.source === 'big.log');
  assert.equal(block.truncated, true);
  assert.match(d.markdown, /4,?812/, 'the original size was not reported');
  assert.match(d.markdown, /truncat/i);
});

test('(b3) a byte cap also applies, for a source with few but enormous lines', () => {
  const oneHugeLine = 'x'.repeat(DEFAULT_CAPS.bytes * 3);
  const d = buildDigest(ctx(), { excerpts: [{ source: 'huge.log', text: oneHugeLine }] });
  const block = d.excerpts.find((e) => e.source === 'huge.log');
  assert.ok(block.text.length <= DEFAULT_CAPS.bytes, 'the byte cap did not apply');
  assert.equal(block.truncated, true);
});

// --- (c) identity fields (FR-002) -----------------------------------------------------------------

test('(c) the digest names workflow, job, failing step, commit and PR', () => {
  const d = buildDigest(ctx(), { excerpts: [] });
  assert.match(d.markdown, /app-ci/);
  assert.match(d.markdown, /app-e2e/);
  assert.match(d.markdown, /Run agent mobile flows/);
  assert.match(d.markdown, /c2c3c29/);
  assert.match(d.markdown, /#82/);
});

test('(c2) a push-event digest omits the PR row rather than printing a null', () => {
  const d = buildDigest(ctx({ pr: null }), { excerpts: [] });
  assert.equal(/null|undefined/.test(d.markdown), false);
});

// --- (d) container health + absent evidence -------------------------------------------------------

test('(d) container health evidence is included when present', () => {
  const d = buildDigest(ctx(), {
    excerpts: [],
    health: [{ container: 'mc-service-store-mongo', status: 'unhealthy', output: 'connection refused' }],
  });
  assert.match(d.markdown, /mc-service-store-mongo/);
  assert.match(d.markdown, /unhealthy/);
});

test('(d2) absent evidence is STATED, not silently omitted', () => {
  // Container jobs have no Docker CLI at all, so "no health data" is the normal case there and
  // must read as a known gap rather than as an empty section.
  const d = buildDigest(ctx(), { excerpts: [], absent: ['container health — no Docker CLI on this runner'] });
  assert.match(d.markdown, /Not collected/i);
  assert.match(d.markdown, /no Docker CLI/);
});

test('(d3) a job that captured NOTHING still identifies itself', () => {
  const d = buildDigest(ctx(), { excerpts: [], absent: ['no output captured'] });
  assert.match(d.markdown, /app-e2e/, 'a digest with no evidence lost its own identity');
  assert.match(d.markdown, /no output captured/);
});

// --- (e) redaction is applied before publication (FR-005) -----------------------------------------

test('(e) every excerpt passes through redaction', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';
  const d = buildDigest(ctx(), { excerpts: [{ source: 'a.log', text: `auth ${jwt} failed` }] });
  assert.equal(d.markdown.includes(jwt), false, 'a credential reached the published digest');
  assert.match(d.markdown, /<redacted-jwt>/);
});

test('(e2) an excerpt that survives redaction dirty is WITHHELD, not published', () => {
  // Fragmented: naming the value in prose would trip the tree-wide secret scan (see the note in
  // ci-digest-redact.test.mjs).
  const planted = 'minio' + 'secret';
  const d = buildDigest(ctx(), { excerpts: [{ source: 'a.log', text: `using ${planted}` }] });
  assert.equal(d.markdown.includes(planted), false, 'a residual credential match was published');
  assert.match(d.markdown, /withheld/i);
});

test('(e3) the forge host never reaches the digest', () => {
  const host = 'beelink.tailz9x8w7' + '.ts' + '.net:3000';
  const d = buildDigest(ctx(), { excerpts: [{ source: 'a.log', text: `GET http://${host}/api` }] });
  assert.equal(d.markdown.includes('tailz9x8w7'), false);
  assert.match(d.markdown, /<forge>/);
});

// --- (f) upsert marker (FR-007) -------------------------------------------------------------------

test('(f) the marker is keyed by JOB so a retry edits rather than stacks', () => {
  const marker = digestMarker('app-e2e');
  const d = buildDigest(ctx(), { excerpts: [] });
  assert.ok(d.markdown.startsWith(marker), 'the digest does not lead with its upsert marker');
  // Two different jobs must not collide; the same job twice must.
  assert.notEqual(digestMarker('app-e2e'), digestMarker('dast'));
  assert.equal(digestMarker('app-e2e'), digestMarker('app-e2e'));
});

test('(f2) an existing comment for the same job is found and reused', () => {
  const comments = [
    { id: 1, body: 'unrelated review comment' },
    { id: 2, body: `${digestMarker('dast')}\n### old dast digest` },
    { id: 3, body: `${digestMarker('app-e2e')}\n### old app-e2e digest` },
  ];
  assert.equal(findExistingComment(comments, 'app-e2e')?.id, 3);
  assert.equal(findExistingComment(comments, 'sast'), null, 'a non-existent job matched some other comment');
});

// --- (g) FR-001a: a cancelled run publishes NOTHING -----------------------------------------------

test('(g) a job from a CANCELLED run must not publish', () => {
  // Measured: a cancelled run's contexts read as `failure` for a commit that was never broken.
  // Publishing here would upsert a failure comment onto the PR on every rapid re-push.
  assert.equal(shouldPublish({ runStatus: 'cancelled', jobStatus: 'failure' }).publish, false);
  assert.match(shouldPublish({ runStatus: 'cancelled', jobStatus: 'failure' }).reason, /supersed|cancel/i);
});

test('(g2) a genuine failure publishes', () => {
  assert.equal(shouldPublish({ runStatus: 'failure', jobStatus: 'failure' }).publish, true);
});

test('(g3) a passing job publishes nothing', () => {
  assert.equal(shouldPublish({ runStatus: 'success', jobStatus: 'success' }).publish, false);
});

test('(g4) the cancelled check wins even when the job itself reports failure', () => {
  // Order matters: a cancelled job DOES report failure, so testing jobStatus first would publish.
  const r = shouldPublish({ runStatus: 'cancelled', jobStatus: 'failure' });
  assert.equal(r.publish, false);
});

// ================================================================================================
// T020 — publish routing. Exercised through an injected transport; nothing here touches the network.
// ================================================================================================

import { publishDigest } from '../ci-failure-digest.mjs';

function fakeApi(comments = []) {
  const calls = [];
  return {
    calls,
    listComments: async () => comments,
    createComment: async (pr, body) => { calls.push({ op: 'createComment', pr, body }); return { id: 99 }; },
    updateComment: async (id, body) => { calls.push({ op: 'updateComment', id, body }); return { id }; },
    createStatus: async (sha, payload) => { calls.push({ op: 'createStatus', sha, ...payload }); return {}; },
  };
}

const digestOf = (over) => buildDigest(ctx(over), { excerpts: [] });

test('(h) a pull_request failure CREATES a comment when none exists', async () => {
  const api = fakeApi([]);
  await publishDigest({ context: ctx({ event: 'pull_request' }), digest: digestOf({}) }, api);
  assert.deepEqual(api.calls.map((c) => c.op), ['createComment']);
  assert.match(api.calls[0].body, /ci-digest:job=app-e2e/);
});

test('(i) a RETRY updates the existing comment instead of stacking a new one', async () => {
  // FR-007: the marker is the upsert key. Three failures of one job must leave ONE comment.
  const api = fakeApi([{ id: 7, body: `${digestMarker('app-e2e')}\n### stale digest` }]);
  await publishDigest({ context: ctx({ event: 'pull_request' }), digest: digestOf({}) }, api);
  assert.deepEqual(api.calls.map((c) => c.op), ['updateComment']);
  assert.equal(api.calls[0].id, 7);
});

test('(i2) another job\'s comment on the same PR is left alone', async () => {
  const api = fakeApi([{ id: 7, body: `${digestMarker('dast')}\n### dast digest` }]);
  await publishDigest({ context: ctx({ event: 'pull_request' }), digest: digestOf({}) }, api);
  assert.deepEqual(api.calls.map((c) => c.op), ['createComment'], 'it edited a different job\'s comment');
});

test('(j) a push failure posts a COMMIT STATUS instead (no PR to comment on)', async () => {
  const api = fakeApi([]);
  await publishDigest({ context: ctx({ event: 'push', pr: null }), digest: digestOf({ pr: null }) }, api);
  assert.deepEqual(api.calls.map((c) => c.op), ['createStatus']);
  assert.match(api.calls[0].context, /ci-digest/);
});

test('(k) FR-001a — a cancelled run publishes NOTHING, by either route', async () => {
  const api = fakeApi([]);
  const result = await publishDigest(
    { context: ctx({ event: 'pull_request', runStatus: 'cancelled' }), digest: digestOf({}) },
    api,
  );
  assert.deepEqual(api.calls, [], 'a superseded run published a failure digest');
  assert.equal(result.published, false);
  assert.match(result.reason, /supersed|cancel/i);
});

test('(l) FR-009 — a transport failure is swallowed, never thrown at the job', async () => {
  // The digest step must never change a job's outcome, including when the digest itself breaks.
  const exploding = { ...fakeApi([]), listComments: async () => { throw new Error('forge is down'); } };
  const result = await publishDigest({ context: ctx({ event: 'pull_request' }), digest: digestOf({}) }, exploding);
  assert.equal(result.published, false);
  assert.match(result.reason, /forge is down/);
});

test('(l2) a transport failure message is redacted before it is reported', async () => {
  const host = 'beelink.tailz9x8w7' + '.ts' + '.net:3000';
  const exploding = {
    ...fakeApi([]),
    listComments: async () => { throw new Error(`connect ECONNREFUSED http://${host}/api`); },
  };
  const result = await publishDigest({ context: ctx({ event: 'pull_request' }), digest: digestOf({}) }, exploding);
  assert.equal(result.reason.includes('tailz9x8w7'), false, 'an error message leaked the forge host');
});

// ================================================================================================
// T028/T030 — evidence bundle identity, size cap, and 30-day retention (US3).
// ================================================================================================

import { bundleVersion, buildBundleManifest, selectExpiredVersions, BUNDLE_CAP_BYTES, RETENTION_DAYS } from '../ci-failure-digest.mjs';

// --- identity: per run AND job (the clarified FR-006) ---------------------------------------------

test('(m) the bundle version is keyed by run AND job', () => {
  assert.equal(bundleVersion(1247, 'app-e2e'), '1247--app-e2e');
});

test('(m2) two jobs failing in the SAME run get distinct bundles', () => {
  // Jobs fail together routinely — most notably a cancelled run fails every context at once.
  // Keying by run alone would let the second upload overwrite the first (SC-010).
  assert.notEqual(bundleVersion(1247, 'app-e2e'), bundleVersion(1247, 'dast'));
});

test('(m3) the same job retried in a NEW run gets its own bundle', () => {
  assert.notEqual(bundleVersion(1247, 'app-e2e'), bundleVersion(1248, 'app-e2e'));
});

test('(m4) a job name with characters unsafe for a package version is normalised', () => {
  const v = bundleVersion(1, 'infra-image-scan / infra-image-scan');
  assert.equal(/[^A-Za-z0-9._-]/.test(v), false, `unsafe characters survived into the version: ${v}`);
  assert.match(v, /^1--/);
});

// --- size cap: truncate largest-first, and SAY SO -------------------------------------------------

test('(n) an oversized bundle truncates largest-source-first and records it', () => {
  const files = [
    { path: 'logs/small.log', text: 'x'.repeat(1_000) },
    { path: 'logs/huge.log', text: 'y'.repeat(BUNDLE_CAP_BYTES * 2) },
    { path: 'logs/medium.log', text: 'z'.repeat(50_000) },
  ];
  const m = buildBundleManifest(files, { cap: BUNDLE_CAP_BYTES });
  const total = m.files.reduce((n, f) => n + f.text.length, 0);
  assert.ok(total <= BUNDLE_CAP_BYTES, `bundle exceeded its cap: ${total} > ${BUNDLE_CAP_BYTES}`);
  // A bundle must never silently misrepresent itself as complete.
  assert.equal(m.meta.truncated, true);
  assert.ok(m.meta.truncatedSources.includes('logs/huge.log'), 'the largest source was not the one trimmed');
  const small = m.files.find((f) => f.path === 'logs/small.log');
  assert.equal(small.text.length, 1_000, 'a small source was trimmed before the huge one');
});

test('(n2) a bundle within the cap is untouched and not marked truncated', () => {
  const m = buildBundleManifest([{ path: 'a.log', text: 'hello' }], { cap: BUNDLE_CAP_BYTES });
  assert.equal(m.meta.truncated, false);
  assert.equal(m.files[0].text, 'hello');
});

test('(n3) the manifest records what was absent, so "not collected" ≠ "empty"', () => {
  const m = buildBundleManifest([], { cap: BUNDLE_CAP_BYTES, absent: ['container health — no Docker CLI'] });
  assert.deepEqual(m.meta.absent, ['container health — no Docker CLI']);
});

// --- retention: 30 days, pruned opportunistically -------------------------------------------------

const daysAgo = (n, now) => new Date(now - n * 86_400_000).toISOString();

test('(o) versions older than the retention window are selected for pruning', () => {
  const now = Date.parse('2026-07-19T00:00:00Z');
  const versions = [
    { version: '1--a', created_at: daysAgo(1, now) },
    { version: '2--b', created_at: daysAgo(RETENTION_DAYS + 5, now) },
    { version: '3--c', created_at: daysAgo(RETENTION_DAYS - 1, now) },
  ];
  const expired = selectExpiredVersions(versions, { now, retentionDays: RETENTION_DAYS });
  assert.deepEqual(expired.map((v) => v.version), ['2--b']);
});

test('(o2) a version with an unparseable timestamp is KEPT, not pruned', () => {
  // Deleting evidence on a parse failure is the destructive direction. Keep it and move on.
  const now = Date.parse('2026-07-19T00:00:00Z');
  const expired = selectExpiredVersions([{ version: 'x', created_at: 'not-a-date' }], { now });
  assert.deepEqual(expired, []);
});

test('(o3) retention is 30 days, matching the repo-wide log-retention standard', () => {
  assert.equal(RETENTION_DAYS, 30);
});

// ================================================================================================
// Write-side defects found by adversarial review.
// ================================================================================================

test('(p) the cap is ENFORCED even when no single source can absorb the overage', () => {
  // `slice(-0)` returns the WHOLE string (-0 === 0), so when room computed to 0 the loop marked the
  // bundle truncated, broke, and returned it unchanged and over cap — meta.truncated LYING.
  // Reachable in production: 6 collected ~3 MB logs vs a 5 MB cap.
  const m = buildBundleManifest(
    [{ path: 'a', text: 'x'.repeat(6) }, { path: 'b', text: 'y'.repeat(6) }, { path: 'c', text: 'z'.repeat(6) }],
    { cap: 10 },
  );
  const total = m.files.reduce((n, f) => n + f.text.length, 0);
  assert.ok(total <= 10, `cap not enforced: kept ${total} bytes against a cap of 10`);
  assert.equal(m.meta.truncated, true);
});

test('(p2) six large sources against a realistic cap still land under it', () => {
  const files = Array.from({ length: 6 }, (_, i) => ({ path: `logs/${i}.log`, text: 'x'.repeat(3_000_000) }));
  const m = buildBundleManifest(files, { cap: BUNDLE_CAP_BYTES });
  const total = m.files.reduce((n, f) => n + f.text.length, 0);
  assert.ok(total <= BUNDLE_CAP_BYTES, `18 MB of logs produced a ${total}-byte bundle`);
  assert.equal(m.meta.truncated, true);
});

test('(p3) tailLines(text, 0) returns nothing, not everything', () => {
  assert.equal(tailLines('a\nb\nc', 0), '');
});

test('(q) the cap counts BYTES, not UTF-16 code units', () => {
  // A 4-byte emoji is length 2 in JS. Non-ASCII CI output (stack traces, CJK, box-drawing) would
  // overshoot the real byte budget by up to 3x.
  const emoji = '🔥'.repeat(2000); // 8000 bytes, length 4000
  const m = buildBundleManifest([{ path: 'e.log', text: emoji }], { cap: 4000 });
  assert.ok(Buffer.byteLength(m.files[0].text, 'utf8') <= 4000, 'byte cap measured code units, not bytes');
});

test('(r) a commit status never carries an empty target_url', async () => {
  // It was sending target_url:"" because context.bundleUrl was never assigned — a link to nowhere,
  // and a plausible reason the POST was rejected. Omit the field rather than send an empty one.
  const api = fakeApi([]);
  await publishDigest({ context: ctx({ event: 'push', pr: null, bundleUrl: undefined }), digest: digestOf({ pr: null }) }, api);
  const call = api.calls.find((c) => c.op === 'createStatus');
  assert.ok(call, 'no status was posted');
  assert.equal('target_url' in call && call.target_url === '', false, 'an empty target_url was sent');
});

test('(r2) when a bundle URL exists it IS sent', async () => {
  const api = fakeApi([]);
  const context = ctx({ event: 'push', pr: null });
  context.bundleUrl = 'https://forge.example/owner/-/packages/generic/ci-failures/1--x';
  await publishDigest({ context, digest: digestOf({ pr: null }) }, api);
  assert.match(api.calls.find((c) => c.op === 'createStatus').target_url, /ci-failures/);
});
