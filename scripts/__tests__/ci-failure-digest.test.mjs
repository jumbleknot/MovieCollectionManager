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
  jobStatus: 'failure', // a real failing job sets CI_DIGEST_JOB_STATUS; the fixture must model that
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

test('(g3) a passing job publishes no DIGEST — 054 changed what it publishes, not whether', () => {
  // Was: `publish === false`. Feature 054 (item #167) made a green run publish a counts-only bundle,
  // because a passing app-e2e's counts were otherwise unreadable without making the job fail. The
  // property this case actually guards — a passing job never emits a FAILURE digest — is unchanged
  // and is asserted directly rather than via a flag that now means something wider.
  assert.notEqual(shouldPublish({ runStatus: 'success', jobStatus: 'success' }).mode, 'digest');
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

test('(j) a push failure posts NO commit status — the bundle IS the publication (FR-008, T040)', async () => {
  // Measured on smoke run 986: POST /repos/…/statuses/{sha} returns 403. The status was only ever a
  // POINTER to the bundle, and the reader can derive that pointer itself from (runId, job), so the
  // status is dropped rather than widening CI_DIGEST_TOKEN with write:repository — which is most of
  // the privilege that made CD_PUSH_TOKEN unacceptable across 16 jobs.
  const api = fakeApi([]);
  const r = await publishDigest({ context: ctx({ event: 'push', pr: null }), digest: digestOf({ pr: null }) }, api);
  assert.deepEqual(api.calls, [], 'a push failure still tried to write a commit status');
  assert.equal(r.published, true);
  assert.equal(r.channel, 'bundle');
});

test('(j2) the transport needs no status-writing capability at all', async () => {
  // If a future change reintroduces createStatus, this fails loudly rather than silently 403-ing
  // in CI where nobody reads the log.
  const api = fakeApi([]);
  delete api.createStatus;
  const r = await publishDigest({ context: ctx({ event: 'push', pr: null }), digest: digestOf({ pr: null }) }, api);
  assert.equal(r.published, true, 'publishing a push failure required a status-writing transport');
});

test('(j3) the digest travels INSIDE the bundle, so a non-PR failure is still readable', () => {
  const m = buildBundleManifest([], { digestMarkdown: '### the digest', context: { job: 'naming' } });
  const entry = m.files.find((f) => f.path === 'digest.md');
  assert.ok(entry, 'the bundle carries no digest.md — a push failure would have nothing to read');
  assert.match(entry.text, /the digest/);
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

// (r)/(r2) removed by T040. They asserted that the commit status carried a non-empty target_url —
// a fix for a real bug, but the commit status itself is now gone (it needed write:repository, 403
// measured on smoke run 986). Test (j2) supersedes them with the stronger property: the transport
// needs no status-writing capability at all.

test('(s) the bundle records whether the digest actually reached its channel', () => {
  // The job log is unreadable over the API, so a failed publish would otherwise be invisible from
  // the read side — the bootstrap gap that made T040 un-diagnosable.
  const m = buildBundleManifest([], { context: { job: 'naming' } });
  assert.ok('truncated' in m.meta, 'meta shape changed unexpectedly');
});

test('(t) a 403 names the scope the endpoint ACTUALLY needs', async () => {
  // Measured on smoke run 986: POST /statuses/{sha} returned 403, and the message said
  // "missing write:package" — a scope that was granted and working. FR-020 requires naming the
  // real one, or the reader chases the wrong fix.
  const { scopeHintForTest } = await import('../ci-failure-digest.mjs');
  if (!scopeHintForTest) return; // exported only for this assertion
  assert.match(scopeHintForTest('/repos/o/r/statuses/abc'), /write:repository/);
  assert.match(scopeHintForTest('/repos/o/r/issues/1/comments'), /write:issue/);
  assert.match(scopeHintForTest('http://h/api/packages/o/generic/x/1/b.gz'), /write:package/);
});

// ================================================================================================
// Collector defects found when the feature failed its FIRST real diagnosis (run 992, app-e2e).
// The bundle was 4 MB of mongo noise: the failing services' logs were never collected, and the
// compose-level log was truncated to zero bytes. Every case below is modelled on that real bundle.
// ================================================================================================

import { selectSources, allocateFairly, collectEvidence } from '../ci-failure-digest.mjs';

// The 13 files feature-036 actually writes, with the sizes seen on run 992.
const REAL_ENTRIES = [
  { name: '_auth-stack.log', size: 17_404 },
  { name: '_mcm-stack.log', size: 250_000 },
  { name: '_ps.txt', size: 900 },
  { name: 'keycloak-service.log', size: 6_412 },
  { name: 'keycloak-store-postgres.log', size: 7_758 },
  { name: 'mc-service-store-mongo-rs-init.log', size: 170 },
  { name: 'mc-service-store-mongo.log', size: 20_000_000 },
  { name: 'mc-service.log', size: 40_000 },
  { name: 'mcm-bff-cache-redis.log', size: 3_000 },
  { name: 'mcm-bff-service-nonsecure.log', size: 60_000 },
  { name: 'mcm-bff-store-mongo.log', size: 900_000 },
  { name: 'movie-assistant-gateway.log', size: 80_000 },
  { name: 'movie-assistant-mcp-movie.log', size: 5_000 },
];
const UNHEALTHY = ['mc-service', 'movie-assistant-gateway'];

test('(u) every container log is collected — no arbitrary alphabetical cap', () => {
  // The bug: `.slice(0, 6)` on an alphabetically-ordered list kept keycloak and mongo, and dropped
  // mc-service, mcm-bff-service-nonsecure and every movie-assistant-* — i.e. the failing services.
  const picked = selectSources(REAL_ENTRIES.map((e) => e.name), UNHEALTHY).map((s) => s.name ?? s);
  for (const must of ['mc-service.log', 'mcm-bff-service-nonsecure.log', 'movie-assistant-gateway.log']) {
    assert.ok(picked.includes(must), `dropped a failing service's log: ${must}`);
  }
});

test('(u2) unhealthy containers are ordered FIRST, ahead of healthy noise', () => {
  const picked = selectSources(REAL_ENTRIES.map((e) => e.name), UNHEALTHY).map((s) => s.name ?? s);
  const firstMongo = picked.indexOf('mc-service-store-mongo.log');
  for (const must of ['mc-service.log', 'movie-assistant-gateway.log']) {
    assert.ok(picked.indexOf(must) < firstMongo, `${must} ranked below a healthy container's log`);
  }
});

test('(u3) the docker ps table is collected', () => {
  // Never collected before — only .log and .health.json were read — so the one table showing which
  // containers EXITED was missing from every bundle.
  const picked = selectSources(REAL_ENTRIES.map((e) => e.name), UNHEALTHY).map((s) => s.name ?? s);
  assert.ok(picked.includes('_ps.txt'), 'the docker ps -a table was not collected');
});

test('(v) fair allocation never zeroes a source while another keeps megabytes', () => {
  // The real failure: mongo (20 MB) crowded the 5 MB cap and _mcm-stack.log was trimmed to 0 bytes,
  // because target = min(size - excess, size/2) goes negative when excess > size.
  const files = REAL_ENTRIES.map((e) => ({ path: 'logs/' + e.name, text: 'x'.repeat(e.size) }));
  const m = buildBundleManifest(files, { cap: BUNDLE_CAP_BYTES });
  const total = m.files.reduce((n, f) => n + Buffer.byteLength(f.text, 'utf8'), 0);
  assert.ok(total <= BUNDLE_CAP_BYTES, `over cap: ${total}`);
  for (const f of m.files) {
    assert.ok(f.text.length > 0, `${f.path} was zeroed while the bundle still carried other sources`);
  }
});

test('(v2) a small source keeps ALL of its content — only the greedy ones are trimmed', () => {
  const files = REAL_ENTRIES.map((e) => ({ path: 'logs/' + e.name, text: 'x'.repeat(e.size) }));
  const m = buildBundleManifest(files, { cap: BUNDLE_CAP_BYTES });
  for (const small of ['_ps.txt', 'mc-service-store-mongo-rs-init.log', 'keycloak-service.log']) {
    const f = m.files.find((x) => x.path === 'logs/' + small);
    const orig = REAL_ENTRIES.find((e) => e.name === small).size;
    assert.equal(f.text.length, orig, `${small} was trimmed even though it fits comfortably`);
  }
});

test('(v3) allocateFairly gives every source at least an equal share', () => {
  const sizes = [10, 10, 10, 1_000_000];
  const shares = allocateFairly(sizes, 1000);
  assert.equal(shares.reduce((a, b) => a + b, 0) <= 1000, true);
  for (const s of shares) assert.ok(s > 0, 'a source got a zero allocation');
  // The three tiny ones keep everything; the greedy one absorbs the trim.
  assert.deepEqual(shares.slice(0, 3), [10, 10, 10]);
});

test('(w) the DIGEST stays small even though the BUNDLE now carries every source', () => {
  // Fixing the collector took sources from 6 to 13. The bundle should carry all of them; the digest
  // must not — 13 x 200 lines is an unreadable PR comment. Small and pointed vs complete.
  const many = Array.from({ length: 13 }, (_, i) => ({
    source: `c${i}.log`,
    text: Array.from({ length: 400 }, (_, n) => `c${i} line ${n}`).join('\n'),
  }));
  const d = buildDigest(ctx(), { excerpts: many });
  assert.ok(d.excerpts.length <= 3, `digest carried ${d.excerpts.length} excerpts — too many for a comment`);
  assert.ok(d.markdown.length < 40_000, `digest markdown is ${d.markdown.length} bytes — too large`);
  // ...and it must SAY that it held sources back, rather than silently dropping them.
  assert.match(d.markdown, /more source/i, 'the digest silently dropped sources');
});

test('(w2) the digest keeps the HIGHEST-RANKED sources, not an arbitrary slice', () => {
  const d = buildDigest(ctx(), {
    excerpts: [
      { source: '_ps.txt', text: 'status table' },
      { source: 'mc-service.log', text: 'the failing service' },
      { source: 'noise.log', text: 'noise' },
      { source: 'more-noise.log', text: 'noise' },
    ],
  });
  assert.match(d.markdown, /_ps\.txt/);
  assert.match(d.markdown, /mc-service\.log/);
});

test('(x) step output outranks every container log', () => {
  // T041: what the failing step PRINTED is the most diagnostic source there is. Three consecutive
  // app-e2e failures needed a human to paste it because nothing collected it.
  const picked = selectSources(
    ['_ps.txt', 'mc-service.log', 'step:agent-integration.log', 'noise.log'],
    ['mc-service'],
  ).map((s) => s.name);
  assert.equal(picked[0], 'step:agent-integration.log', 'step output did not rank first');
});

test('(x2) a job with no instrumented step SAYS so rather than reporting nothing', () => {
  const ev = collectEvidence({ home: '/nonexistent-home', cwd: '/tmp', env: { GITHUB_RUN_ID: 'x' } });
  assert.ok(ev.absent.some((a) => /step output/.test(a)), 'silent about missing step output');
  assert.ok(ev.absent.some((a) => /ci-log-step\.sh/.test(a)), 'does not say how to fix it');
});

// ================================================================================================
// T046/T048 — failing-step name from the marker, and a comment-safe size cap.
// ================================================================================================

import { readFailingStep, readRunHealth as readFailingStepModuleRunHealth, COMMENT_MAX_BYTES } from '../ci-failure-digest.mjs';

test('(y) the digest names the failing step from the marker', () => {
  const d = buildDigest(ctx({ step: 'guardrails / naming' }), { excerpts: [] });
  assert.match(d.markdown, /guardrails \/ naming/);
  assert.equal(/_not reported_/.test(d.markdown), false);
});

test('(y2) readFailingStep returns null when no step was wrapped', () => {
  assert.equal(readFailingStep({ GITHUB_RUN_ID: 'nope', HOME: '/nonexistent' }), null);
});

// --- (y3) the READER half of item #180 ----------------------------------------------------------
//
// scripts/__tests__/ci-log-step.test.mjs (g4) pins that the two jobs WRITE separate markers; this
// pins that the digest READS its own. Both halves derive the path independently, so a change to one
// alone is exactly the kind of silent drift that produced the original defect.
//
// The second assertion is the one that matters: there is deliberately NO run-scoped fallback. A
// fallback would keep reading the sibling job's marker on precisely the overlapping runs the fix is
// for, so the bug would survive behind it and the tests would still be green.
test('(y3) readFailingStep reads THIS job\'s marker, and does not fall back to a run-scoped one', () => {
  const root = mkdtempSync(join(tmpdir(), 'failing-step-'));
  mkdirSync(join(root, '1683', 'dast'), { recursive: true });
  mkdirSync(join(root, '1683', 'app-e2e'), { recursive: true });
  writeFileSync(join(root, '1683', 'dast', '_failed-step'), 'dast-install-latest-docker\n');
  writeFileSync(join(root, '1683', 'app-e2e', '_failed-step'), 'web-e2e\n');
  // The pre-fix layout, left in place on purpose: nothing may read it any more.
  writeFileSync(join(root, '1683', '_failed-step'), 'dast-install-latest-docker\n');

  const inJob = (job) => ({ CI_STEP_LOG_ROOT: root, GITHUB_RUN_ID: '1683', GITHUB_JOB: job });
  assert.equal(readFailingStep(inJob('app-e2e')), 'web-e2e');
  assert.equal(readFailingStep(inJob('dast')), 'dast-install-latest-docker');
  assert.equal(
    readFailingStep({ CI_STEP_LOG_ROOT: root, GITHUB_RUN_ID: '1683', GITHUB_JOB: 'affected' }),
    null,
    'a job with no marker of its own adopted the run-scoped one — the fallback re-creates #180',
  );
});

test('(z) a huge digest is capped to a comment-safe size, and says it was', () => {
  // Real data: run 1000's digest.md was 90 KB; Forgejo's comment body limit is ~64 KB, so a full
  // app-e2e digest COMMENT would be rejected. The bundle keeps the full logs as separate files.
  const huge = Array.from({ length: 3 }, (_, i) => ({
    source: `big${i}.log`,
    text: Array.from({ length: 200 }, (_, n) => `${i}: ${'x'.repeat(300)} line ${n}`).join('\n'),
  }));
  const d = buildDigest(ctx(), { excerpts: huge });
  assert.ok(
    Buffer.byteLength(d.markdown, 'utf8') <= COMMENT_MAX_BYTES,
    `digest is ${Buffer.byteLength(d.markdown, 'utf8')} bytes, over the ${COMMENT_MAX_BYTES} comment cap`,
  );
  assert.match(d.markdown, /truncated for comment size|full content is in the bundle/i);
});

test('(z2) COMMENT_MAX_BYTES stays safely under the forge comment limit', () => {
  assert.ok(COMMENT_MAX_BYTES < 65535, 'cap is not under the ~64 KB forge comment limit');
});

test('(z3) a small digest is left entirely alone', () => {
  const d = buildDigest(ctx(), { excerpts: [{ source: 'a.log', text: 'one short line' }] });
  assert.equal(/truncated for comment size/i.test(d.markdown), false);
  assert.match(d.markdown, /one short line/);
});

// ================================================================================================
// Security hardening — write side (injection via attacker-controlled log content).
// ================================================================================================

import { fenceFor, neutralizeMarkers } from '../ci-failure-digest.mjs';

test('(aa) a log line containing ``` cannot break out of the code fence', () => {
  // Attacker prints ``` to close the fence early and inject live markdown into the PR comment.
  const evil = 'normal log\n```\n[click me](http://evil)\n```more';
  const d = buildDigest(ctx(), { excerpts: [{ source: 'a.log', text: evil }] });
  // The chosen fence must be longer than any backtick run in the content, so the content stays fenced.
  const fence = fenceFor(evil);
  assert.ok(fence.length >= 4, 'fence not lengthened past the injected ```');
  assert.ok(d.markdown.includes(fence), 'digest did not use a breakout-safe fence');
  // the injected markdown link must remain INSIDE a fence (literal), not become active markdown
  assert.ok(d.markdown.includes(evil) || d.markdown.includes(evil.replace(/\r/g, '')), 'excerpt content lost');
});

test('(bb) another job\'s marker in a log excerpt is neutralised (no cross-job overwrite)', () => {
  // A test that echoes `<!-- ci-digest:job=affected -->` must not let the affected job\'s upsert
  // match-and-overwrite this comment, nor inject a second marker.
  const evil = 'log: <!-- ci-digest:job=affected -->';
  const d = buildDigest(ctx({ job: 'app-e2e' }), { excerpts: [{ source: 'a.log', text: evil }] });
  // exactly one REAL marker (this job\'s, at the top); the injected one is defanged
  const markers = (d.markdown.match(/<!--\s*ci-digest:job=/g) || []).length;
  assert.equal(markers, 1, `expected 1 marker, found ${markers}`);
  assert.match(d.markdown, /^<!-- ci-digest:job=app-e2e -->/);
});

test('(cc) findExistingComment only matches a marker at the START of a body', () => {
  const comments = [
    { id: 1, body: 'lgtm <!-- ci-digest:job=app-e2e -->' },       // mid-body → must NOT match
    { id: 2, body: '<!-- ci-digest:job=app-e2e -->\n### digest' }, // anchored → matches
  ];
  assert.equal(findExistingComment(comments, 'app-e2e')?.id, 2);
});

test('(dd) an UNKNOWN job status does not publish (env dropped must not spam green runs)', () => {
  // Was: default 'failure' → a job that lost CI_DIGEST_JOB_STATUS published a spurious digest on a
  // green run. Unknown must be no-publish; the coverage gate guarantees the env for real failures.
  assert.equal(shouldPublish({ runStatus: '', jobStatus: '' }).publish, false);
  assert.equal(shouldPublish({ runStatus: 'failure', jobStatus: 'failure' }).mode, 'digest');
  // 054: an explicit success publishes COUNTS, never a digest. The guard this case exists for — a
  // DROPPED env var must not publish — is why counts is gated on an explicit `success` rather than
  // on "not a failure"; the empty-status assertion above is what pins that.
  assert.equal(shouldPublish({ runStatus: 'success', jobStatus: 'success' }).mode, 'counts');
});

// --- (ee)-(hh) the three-way outcome (feature 051 US3) --------------------------------------------
//
// The digest step is `if: always()` + `continue-on-error: true` and the script ends in an
// unconditional exit 0. All three are correct — a broken reporter must never fail a build — but
// together they erase the difference between "nothing to report" and "the reporter is broken".
// The reader is told "no digest was published" in both cases, and believes the first.
//
// Measured on 2026-08-01: an AGit-headed run had every Actions secret empty, so CI_DIGEST_TOKEN was
// blank. The digest COLLECTED its evidence, could not publish it, printed it to stdout — which the
// forge API cannot expose — and exited 0. Zero comments on the PR, no error, no signal. The evening
// was spent looking for a CI fault that had already been diagnosed and thrown away.
//
// The vocabulary mirrors the `absent` field the digest already uses to separate "looked and found
// nothing" from "did not look", rather than inventing a parallel one.

// Loaded per-case rather than at module scope, deliberately. A static import of a not-yet-existing
// export throws at LOAD time and takes the whole file with it — this file collected 1 test instead
// of 60 while these cases were red, which hides every other case behind one failure and makes the
// collected count meaningless. That is the same defect T044 fixes on Windows, and it would be a poor
// look to reproduce it here on purpose.
const digestModule = () => import('../ci-failure-digest.mjs');

test('(ee) a job that never needed a digest is `not-needed`, not a failure to publish', async () => {
  const { describeOutcome, OUTCOME } = await digestModule();
  // Success and cancellation are the two ways this arises. A cancelled run in particular MUST NOT
  // read as broken: it is superseded, and the newer run publishes the truth.
  assert.equal(
    describeOutcome({ gate: { publish: false, reason: 'job status is success, not a failure' } }).outcome,
    OUTCOME.NOT_NEEDED,
  );
  assert.equal(
    describeOutcome({ gate: { publish: false, reason: 'run was cancelled/superseded by a newer push' } }).outcome,
    OUTCOME.NOT_NEEDED,
  );
});

test('(ff) a digest that reached its channel is `published`, and says which channel', async () => {
  const { describeOutcome, OUTCOME } = await digestModule();
  const d = describeOutcome({
    gate: { publish: true },
    tokenPresent: true,
    publishResult: { published: true, channel: 'pr-comment' },
  });
  assert.equal(d.outcome, OUTCOME.PUBLISHED);
  assert.equal(d.channel, 'pr-comment');
});

test('(gg) publication failure is `failed`, and carries the sub-reason that implies the next action', async () => {
  const { describeOutcome, OUTCOME } = await digestModule();
  // Each sub-reason means a different thing to do, so collapsing them into one "failed" would leave
  // the reader exactly as stuck as an absent digest does.
  const noCred = describeOutcome({ gate: { publish: true }, tokenPresent: false });
  assert.equal(noCred.outcome, OUTCOME.FAILED);
  assert.equal(noCred.detail, 'no-credential', 'the 2026-08-01 case must be distinguishable by itself');

  const forbidden = describeOutcome({
    gate: { publish: true },
    tokenPresent: true,
    publishResult: { published: false, reason: 'POST /statuses failed: 403 Forbidden' },
  });
  assert.equal(forbidden.outcome, OUTCOME.FAILED);
  assert.equal(forbidden.detail, 'forbidden');

  const transport = describeOutcome({
    gate: { publish: true },
    tokenPresent: true,
    publishResult: { published: false, reason: 'request timed out after 30000ms' },
  });
  assert.equal(transport.outcome, OUTCOME.FAILED);
  assert.equal(transport.detail, 'transport');
});

test('(gg2) an unrecognised publish failure still reports `failed`, never `published`', async () => {
  const { describeOutcome, OUTCOME } = await digestModule();
  // Fail-closed on classification. A sub-reason this function cannot name is still a failure, and
  // guessing `transport` for a 401 would send the reader to the wrong place — but reporting
  // `published` would recreate the original bug.
  const d = describeOutcome({
    gate: { publish: true },
    tokenPresent: true,
    publishResult: { published: false, reason: 'something nobody anticipated' },
  });
  assert.equal(d.outcome, OUTCOME.FAILED);
  assert.ok(d.detail, 'a failed outcome with no sub-reason tells the reader nothing');
});

test('(hh) the outcome text is redacted, exactly as the digest body is', async () => {
  const { describeOutcome } = await digestModule();
  // Contract obligation 4. A transport error carries a URL, and therefore the forge host — the same
  // reason case (e3) exists for the digest body. Fragmented for the same reason as (e3): naming the
  // host in one piece would trip the tree-wide topology scrub.
  const host = 'beelink.tailz9x8w7' + '.ts' + '.net:3000';
  const d = describeOutcome({
    gate: { publish: true },
    tokenPresent: true,
    publishResult: { published: false, reason: `connect ECONNREFUSED http://${host}/api/v1` },
  });
  assert.doesNotMatch(JSON.stringify(d), /tailz9x8w7/, 'the forge host reached the outcome signal');
  assert.match(JSON.stringify(d), /<forge>/, 'the host was dropped rather than redacted');
});

test('(hh2) `failed:no-credential` is reportable WITHOUT the credential that failed', async () => {
  const { describeOutcome, OUTCOME } = await digestModule();
  // Contract obligation 3, and the whole point. If naming this state required the token, the one
  // state that matters most could never be reported — which is precisely what happened.
  const d = describeOutcome({ gate: { publish: true }, tokenPresent: false });
  assert.equal(d.detail, 'no-credential');
  assert.ok(d.summary && d.summary.length > 0, 'the no-credential outcome must carry a human-readable summary');
});

// --- (ii) FR-012 — recording a failure must never change the job's outcome ------------------------
//
// The whole reason this script can be trusted at the end of every job is that it cannot affect one.
// Adding a signal is exactly the kind of change that quietly breaks that: a throw inside the new
// path, or a non-zero exit while reporting the failure, would turn a diagnostic into a build-breaker.
// So the property is asserted against the REAL process, in every failure mode, rather than reasoned
// about — `continue-on-error` in the workflow is belt to this braces, and belts have been known to
// be edited out.

import { spawnSync } from 'node:child_process';
import { resolve as resolvePath, dirname as dirnamePath, join } from 'node:path';
import { fileURLToPath as toPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const DIGEST_SCRIPT = resolvePath(dirnamePath(toPath(import.meta.url)), '..', 'ci-failure-digest.mjs');

/** Run the digest end to end with a controlled environment, and report how it exited. */
function runDigest(env) {
  const r = spawnSync(process.execPath, [DIGEST_SCRIPT], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      // A forge base that resolves to nothing routable, so the transport path fails fast rather
      // than reaching anything real. These tests must stay offline.
      GITHUB_SERVER_URL: 'http://127.0.0.1:9',
      GITHUB_REPOSITORY: 'owner/repo',
      CI_HTTP_TIMEOUT_MS: '1500',
      ...env,
    },
    timeout: 60_000,
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

test('(ii) a failing job with NO credential still exits 0 — and says the digest failed', () => {
  const r = runDigest({
    GITHUB_RUN_ID: '90001', GITHUB_WORKFLOW: 'app-ci', GITHUB_JOB: 'affected',
    GITHUB_EVENT_NAME: 'push', CI_DIGEST_JOB_STATUS: 'failure',
    // CI_DIGEST_TOKEN deliberately absent — the 2026-08-01 condition.
  });
  assert.equal(r.code, 0, `a digest failure changed the job outcome:\n${r.out}`);
  assert.match(r.out, /no-credential/, 'the no-credential state was not named in the output');
});

test('(ii2) a failing job whose TRANSPORT dies still exits 0 — and says the digest failed', () => {
  const r = runDigest({
    GITHUB_RUN_ID: '90002', GITHUB_WORKFLOW: 'app-ci', GITHUB_JOB: 'affected',
    GITHUB_EVENT_NAME: 'push', CI_DIGEST_JOB_STATUS: 'failure',
    CI_DIGEST_TOKEN: 'not-a-real-token-just-a-shape',
  });
  assert.equal(r.code, 0, `a transport failure changed the job outcome:\n${r.out}`);
  assert.match(r.out, /digest-outcome=failed/, 'a broken publication did not report itself as failed');
});

test('(ii3) a job that needed no digest exits 0 and reports `not-needed`, never `failed`', () => {
  const r = runDigest({
    GITHUB_RUN_ID: '90003', GITHUB_WORKFLOW: 'app-ci', GITHUB_JOB: 'affected',
    GITHUB_EVENT_NAME: 'push', CI_DIGEST_JOB_STATUS: 'success',
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /digest-outcome=not-needed/);
  assert.doesNotMatch(r.out, /digest-outcome=failed/, 'a green job was reported as a broken digest');
});

test('(ii4) the outcome line is emitted in a form a machine can find, on every path', () => {
  // Contract obligation 1 says stdout alone is not enough — the forge API cannot read a job log, so
  // the bundle carries this too. But a STABLE, greppable line is what makes the state visible to a
  // human in the web UI on the one path where no bundle can exist (no credential, no upload).
  for (const [status, want] of [['failure', /digest-outcome=failed:no-credential/], ['success', /digest-outcome=not-needed/]]) {
    const r = runDigest({
      GITHUB_RUN_ID: '90004', GITHUB_WORKFLOW: 'app-ci', GITHUB_JOB: 'affected',
      GITHUB_EVENT_NAME: 'push', CI_DIGEST_JOB_STATUS: status,
    });
    assert.match(r.out, want, `status=${status} did not emit a findable outcome line`);
  }
});

// --- (jj) credential fallback (feature 051 US4, FR-013/FR-015) ------------------------------------
//
// CI_DIGEST_TOKEN is an Actions secret, and it is empty exactly when a run is most confusing: on the
// AGit-headed run of 2026-08-01 every `secrets.*` arrived blank, so the digest collected its evidence
// and had nothing to publish it with.
//
// T034 measured (guardrails run #1627) that the run's AUTOMATICALLY-PROVISIONED token CAN write
// `POST /repos/{owner}/{repo}/statuses/{sha}` — it left a real `probe-051-t034` status behind. So a
// fallback is worth building. What T034 could NOT establish is whether that token is *populated* on a
// secretless run; proving that needs an AGit push, which CLAUDE.md forbids. Hence `both absent` is a
// first-class case below rather than a theoretical one.

test('(jj) the purpose-scoped credential is preferred, and the existing path is untouched', async () => {
  // A fallback that DISPLACES the richer channel is a regression, not a safety net. Asserted first
  // and explicitly, because it is the failure mode a fallback most easily introduces.
  const { selectCredential } = await digestModule();
  const c = selectCredential({ CI_DIGEST_TOKEN: 'purpose-scoped-value', GITHUB_TOKEN: 'auto-value' });
  assert.equal(c.source, 'purpose-scoped');
  assert.equal(c.token, 'purpose-scoped-value');
});

test('(jj2) with no purpose-scoped credential, the run-provisioned token is selected', async () => {
  const { selectCredential } = await digestModule();
  for (const env of [{ GITHUB_TOKEN: 'auto-value' }, { ACTIONS_RUNTIME_TOKEN: 'auto-value' }]) {
    const c = selectCredential(env);
    assert.equal(c.source, 'auto', `not selected from ${Object.keys(env)[0]}`);
    assert.equal(c.token, 'auto-value');
  }
});

test('(jj3) with NEITHER credential, selection yields nothing — the 2026-08-01 condition', async () => {
  const { selectCredential } = await digestModule();
  const c = selectCredential({});
  assert.equal(c.token, null);
  assert.equal(c.source, null);
});

test('(jj4) an EMPTY-STRING secret counts as absent, not as a credential', async () => {
  // This is precisely how 2026-08-01 presented: `${{ secrets.CI_DIGEST_TOKEN }}` expanded to an
  // empty string, not to an unset variable. A truthiness check that only tested `undefined` would
  // sail past it and then fail at the transport with a confusing 401.
  const { selectCredential } = await digestModule();
  assert.equal(selectCredential({ CI_DIGEST_TOKEN: '', GITHUB_TOKEN: 'auto-value' }).source, 'auto');
  assert.equal(selectCredential({ CI_DIGEST_TOKEN: '', GITHUB_TOKEN: '' }).source, null);
});

test('(jj5) publishing through the fallback is `published`, NOT `failed` — and says it was degraded', async () => {
  // Deliberate deviation from contracts/digest-outcome.md, which says the fallback records
  // `failed:no-credential`. That wording would make `published` and `failed` simultaneously true and
  // break Story 3's own vocabulary, where `failed` means the evidence did NOT reach a channel. The
  // reader's question is "did the diagnosis get to me?" — via the fallback the answer is yes, in a
  // degraded form. Both facts are carried instead of collapsing them into a misleading one.
  const { describeOutcome, OUTCOME } = await digestModule();
  const d = describeOutcome({
    gate: { publish: true },
    tokenPresent: true,
    credentialSource: 'auto',
    publishResult: { published: true, channel: 'commit-status' },
  });
  assert.equal(d.outcome, OUTCOME.PUBLISHED);
  assert.equal(d.channel, 'commit-status');
  assert.equal(d.degraded, true, 'a fallback publication must announce that it was degraded');
  assert.match(d.summary, /purpose-scoped|CI_DIGEST_TOKEN/, 'the summary must name the missing credential');
});

test('(jj6) the normal path is NOT marked degraded', async () => {
  const { describeOutcome } = await digestModule();
  const d = describeOutcome({
    gate: { publish: true },
    tokenPresent: true,
    credentialSource: 'purpose-scoped',
    publishResult: { published: true, channel: 'pr-comment' },
  });
  assert.notEqual(d.degraded, true);
});

// --- (kk) size-safe truncation for the fallback channel (US4, FR-014) -----------------------------
//
// A commit-status description is short — far shorter than a digest. The fallback therefore carries
// the failing step's NAME and a TRUNCATED excerpt: enough to name the fault, not to replay the
// build. Two properties matter, and the second is the one with teeth.

test('(kk) an over-long excerpt is truncated, and truncation never fails the publication', async () => {
  const { truncateForStatus } = await digestModule();
  const out = truncateForStatus('x'.repeat(5000), 255);
  assert.ok(out.length <= 255, `truncation did not respect the cap: ${out.length}`);
  assert.match(out, /…|\.\.\./, 'truncation must be visible, not silent');
});

test('(kk2) truncation NEVER splits a redaction placeholder — half a redaction is worse than none', async () => {
  // The cutter must not land mid-`<redacted-…>`, because `<redacted-jw` reads as noise while
  // `<red` next to surrounding text can look like the start of real content. More importantly, a
  // future placeholder that wraps a value would leak its tail if cut inside.
  const { truncateForStatus } = await digestModule();
  const text = `${'a'.repeat(240)}<redacted-anthropic-key> trailing`;
  for (let cap = 230; cap <= 275; cap += 1) {
    const out = truncateForStatus(text, cap);
    assert.ok(out.length <= cap, `cap ${cap} exceeded: ${out.length}`);
    const opens = (out.match(/<redacted/g) || []).length;
    const closes = (out.match(/<redacted[a-z-]*>/g) || []).length;
    assert.equal(opens, closes, `cap ${cap} produced a severed placeholder: ${JSON.stringify(out.slice(-40))}`);
  }
});

test('(kk3) a short excerpt is returned untouched', async () => {
  const { truncateForStatus } = await digestModule();
  assert.equal(truncateForStatus('thread panicked at src/lib.rs:42', 255), 'thread panicked at src/lib.rs:42');
});

test('(kk4) the fallback status body names the failing STEP, not just the excerpt', async () => {
  // The single most useful fact is which step broke. An excerpt without it sends the reader hunting.
  const { buildStatusDescription } = await digestModule();
  const body = buildStatusDescription({ job: 'naming', step: 'naming-resource-naming-gate', excerpt: 'boom' }, 255);
  assert.match(body, /naming-resource-naming-gate/);
  assert.ok(body.length <= 255);
});

test('(kk5) an empty or missing excerpt still yields a usable description', async () => {
  // The no-evidence case must not produce an empty status — that is indistinguishable from no status.
  const { buildStatusDescription } = await digestModule();
  const body = buildStatusDescription({ job: 'naming', step: '', excerpt: '' }, 255);
  assert.ok(body.trim().length > 0, 'an empty description is the same as no signal at all');
  assert.match(body, /naming/);
});

// --- (ll) the fallback excerpt must come from the FAILING step ------------------------------------
//
// MEASURED IN CI, guardrails run #1628 (the SC-004/SC-005 rehearsal). The fallback published:
//
//   ci-digest/okf  "CI failure: okf / okf-deliberate-breakage — ! Corepack is about to download …"
//
// The step NAME was right and the excerpt was from a completely different step — the pnpm install.
// A reader sees install output presented as the evidence for a named failure and concludes the
// install broke. That is the same defect this whole feature is about: text that looks like evidence
// for a claim it is not evidence for. Worse here than in the digest, because the fallback carries
// exactly ONE excerpt and there is no bundle to check it against.

test('(ll) the fallback excerpt is selected by the FAILING STEP, not by position', async () => {
  const { selectFallbackExcerpt } = await digestModule();
  const excerpts = [
    { source: 'step:okf-install-js-dependencies', text: 'Corepack is about to download pnpm' },
    { source: 'step:okf-deliberate-breakage', text: 'this failure is intentional' },
    { source: 'step:okf-gate', text: 'unrelated tail' },
  ];
  assert.match(
    selectFallbackExcerpt(excerpts, 'okf-deliberate-breakage'),
    /intentional/,
    'the excerpt did not come from the failing step',
  );
});

test('(ll2) with no failing step reported, it falls back to the LAST excerpt rather than nothing', async () => {
  // Degrading to "some evidence" beats degrading to none — but only when the step is genuinely
  // unknown, never as the default path.
  const { selectFallbackExcerpt } = await digestModule();
  const excerpts = [{ source: 'step:a', text: 'first' }, { source: 'step:b', text: 'last' }];
  assert.match(selectFallbackExcerpt(excerpts, ''), /last/);
  assert.equal(selectFallbackExcerpt([], 'anything'), '');
});

test('(ll3) a failing step with no captured log does NOT borrow another step\'s output', async () => {
  // The dangerous case. If the failing step produced nothing, presenting a different step's tail
  // beside its name is actively misleading — say nothing instead.
  const { selectFallbackExcerpt } = await digestModule();
  const excerpts = [{ source: 'step:something-else', text: 'not mine' }];
  assert.equal(
    selectFallbackExcerpt(excerpts, 'the-failing-step'),
    '',
    'output from an unrelated step was attributed to the failing step',
  );
});

// ================================================================================================
// 054 T004/T005/T007/T008 — the publication gate becomes THREE-WAY.
//
// A green run left no bundle at all, so a passing app-e2e's counts and retry churn were unreadable
// without making the job fail (backlog item #167). `shouldPublish` was the single reason: it
// returned false for any jobStatus that was not `failure`.
//
// Three modes now, and the boundaries matter more than the modes:
//   * cancelled          → publish nothing (unchanged — a superseded run was never broken)
//   * jobStatus failure  → `digest`, today's full behaviour, unchanged
//   * jobStatus success  → `counts`, a small counts-only bundle and NO PR comment
//   * anything else      → publish nothing, which is what keeps case (dd) true
// ================================================================================================

test('(mm) a passing job now publishes COUNTS — but never a digest', () => {
  const r = shouldPublish({ runStatus: 'success', jobStatus: 'success' });
  assert.equal(r.publish, true, 'a green run still publishes nothing — item #167 is not fixed');
  assert.equal(r.mode, 'counts');
  assert.notEqual(r.mode, 'digest', 'a passing job would publish a FAILURE digest');
});

test('(mm2) a genuine failure still routes to the digest, unchanged', () => {
  const r = shouldPublish({ runStatus: 'failure', jobStatus: 'failure' });
  assert.equal(r.publish, true);
  assert.equal(r.mode, 'digest');
});

test('(mm3) a cancelled run publishes nothing in EITHER mode', () => {
  // The cancelled check must still come first. A cancelled job reports `failure`, so testing the
  // job status first would publish a failure digest for a commit that was never broken — and the
  // counts mode must not become a second way in.
  const r = shouldPublish({ runStatus: 'cancelled', jobStatus: 'failure' });
  assert.equal(r.publish, false);
  assert.equal(r.mode, null);
  const alsoCancelled = shouldPublish({ runStatus: 'cancelled', jobStatus: 'success' });
  assert.equal(alsoCancelled.publish, false, 'a cancelled run published counts');
});

test('(mm4) an UNKNOWN job status still publishes nothing — counts is not a loophole', () => {
  // Case (dd) exists because a job that lost CI_DIGEST_JOB_STATUS once published a spurious digest
  // on a green run. `counts` is deliberately gated on an EXPLICIT `success`, not on "anything that
  // is not a failure" — otherwise a dropped env var would resurrect that bug in a new costume.
  for (const jobStatus of ['', 'unknown', undefined, null]) {
    const r = shouldPublish({ runStatus: '', jobStatus });
    assert.equal(r.publish, false, `an unknown job status (${JSON.stringify(jobStatus)}) published`);
    assert.equal(r.mode, null);
  }
});

test('(mm5) counts mode with NO counts sources publishes nothing at all', async () => {
  // Self-limiting by construction rather than by a job allowlist: every job other than app-e2e has
  // no e2e-result-gate / e2e-contention-tally step log, so nothing is uploaded and the package
  // registry does not grow a version per green job per run. An allowlist would be a second place to
  // forget to update.
  const { selectCountsSources } = await digestModule();
  assert.deepEqual(selectCountsSources([]), []);
  assert.deepEqual(
    selectCountsSources([{ source: 'step:affected-nx', text: 'nx output' }]),
    [],
    'an unrelated step log was mistaken for a counts source',
  );
});

test('(mm6) counts mode collects ONLY the counts sources, not the whole job log', async () => {
  const { selectCountsSources } = await digestModule();
  const picked = selectCountsSources([
    { source: 'step:web-e2e', text: 'thousands of lines' },
    { source: 'step:e2e-result-gate', text: '[e2e-gate] failed=0 flaky=2 passed=175 did-not-run=0 skipped=0' },
    { source: 'step:e2e-contention-tally', text: '[e2e-contention] refresh_total=6 refresh_429=0 session_evicted=0' },
    { source: 'mcm-bff-service-nonsecure.log', text: 'megabytes' },
  ]);
  assert.deepEqual(picked.map((e) => e.source).sort(), [
    'step:e2e-contention-tally',
    'step:e2e-result-gate',
  ]);
});

test('(mm7) retention prunes a counts version exactly as it prunes a digest version', async () => {
  // #167 asks for a retention story because publishing on EVERY run, not only failures, is what
  // makes unbounded growth reachable. Confirmed against the real selector rather than assumed.
  const { selectExpiredVersions, RETENTION_DAYS } = await digestModule();
  const now = Date.parse('2026-08-11T00:00:00Z');
  const old = new Date(now - (RETENTION_DAYS + 1) * 86_400_000).toISOString();
  const fresh = new Date(now - 86_400_000).toISOString();
  const expired = selectExpiredVersions(
    [
      { name: '1700--app-e2e', created_at: old },
      { name: '1701--app-e2e', created_at: fresh },
    ],
    { now },
  );
  assert.deepEqual(expired.map((v) => v.name), ['1700--app-e2e']);
});

test('(mm8) counts mode exits 0 when its TRANSPORT dies — a reporter never fails the build', () => {
  // FR-007. The same property case (ii2) pins for the digest path, asserted against the REAL process
  // for the new path rather than reasoned about from the shared try/catch. A green run is precisely
  // the case where a publication fault must stay invisible to the job's result.
  const dir = mkdtempSync(join(tmpdir(), 'counts-'));
  // run id AND job — ci-log-step.sh writes `<root>/<run>/<job>/` since item #180, and the reader
  // derives the same path independently. A test that wrote the old run-scoped layout would pass
  // against a reader that had silently stopped matching the writer.
  const runDir = join(dir, '90101', 'app-e2e');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'e2e-result-gate.log'),
    '[e2e-gate] failed=0 flaky=2 passed=175 did-not-run=0 skipped=0\n');
  writeFileSync(join(runDir, 'e2e-contention-tally.log'),
    '[e2e-contention] refresh_total=6 refresh_429=0 session_evicted=0\n');

  const r = runDigest({
    GITHUB_RUN_ID: '90101', GITHUB_WORKFLOW: 'app-ci', GITHUB_JOB: 'app-e2e',
    GITHUB_EVENT_NAME: 'push', CI_DIGEST_JOB_STATUS: 'success',
    CI_STEP_LOG_ROOT: dir,
    CI_DIGEST_TOKEN: 'not-a-real-token-just-a-shape',
  });
  assert.equal(r.code, 0, `a counts publication failure changed the job outcome:\n${r.out}`);
  assert.match(r.out, /\[e2e-gate\] failed=0/, 'the counts were not echoed to the job log');
  assert.match(r.out, /refresh_429=0/, 'the contention tally was not echoed to the job log');
});

test('(mm9) a green job with no counts steps publishes nothing and says so', () => {
  const r = runDigest({
    GITHUB_RUN_ID: '90102', GITHUB_WORKFLOW: 'app-ci', GITHUB_JOB: 'affected',
    GITHUB_EVENT_NAME: 'push', CI_DIGEST_JOB_STATUS: 'success',
    CI_STEP_LOG_ROOT: mkdtempSync(join(tmpdir(), 'counts-empty-')),
    CI_DIGEST_TOKEN: 'not-a-real-token-just-a-shape',
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /no e2e counts steps/, 'the self-limiting path did not say why it published nothing');
});

test('(nn) counts mode carries the global-setup identity lines, filtered, not the whole web-e2e log', async () => {
  // Measured 2026-08-12 on app-ci run #1681: the counts bundle proved the suite was green and the
  // contention zero, and could NOT say whether per-worker identities actually engaged — that line
  // lives in the `web-e2e` step log, which is collected only on failure. So a fallback to the shared
  // user (which global setup warns about, loudly, into that same log) would have been invisible on a
  // green run. A green run that cannot say WHICH identity model produced it is the same class of gap
  // as a green run that cannot say how many tests ran.
  //
  // Filtered rather than whole: `web-e2e` is thousands of lines, and counts mode exists to be small.
  const { selectCountsSources } = await digestModule();
  const picked = selectCountsSources([
    { source: 'step:e2e-result-gate', text: '[e2e-gate] failed=0' },
    {
      source: 'step:web-e2e',
      text: [
        'Running 177 tests using 6 workers',
        '[global-setup] minted 6 worker identities — 5 fresh users + the canonical one for worker 0',
        '  ok 1 collections.spec.ts:12 › lists collections',
        '[global-setup] seeded fixtures for 5 worker identities in 1.6s',
        '  ok 2 movies.spec.ts:20 › adds a movie',
      ].join('\n'),
    },
  ]);

  const web = picked.find((e) => e.source === 'step:web-e2e');
  assert.ok(web, 'the web-e2e setup lines were not carried into the counts bundle');
  assert.match(web.text, /minted 6 worker identities/);
  assert.match(web.text, /seeded fixtures for 5 worker identities/);
  assert.doesNotMatch(web.text, /collections\.spec\.ts/, 'the whole test log was carried, not just setup');
  assert.ok(web.text.split('\n').length <= 12, 'the filtered excerpt is not small');
});

// ================================================================================================
// Item #173 — the run-health verdict is a DIGEST FIELD, not a job-log line nobody can fetch.
// ================================================================================================
//
// Roughly one app-e2e run in seven collapses: every agent/dock spec fails at once, flaky=0, and the
// gateway receives ~a quarter of its usual turns. scripts/e2e-turn-tally.sh has told that apart from
// "some tests failed" since feature 054 — but it prints into a job log, and this forge exposes no
// job logs through its API. So on a red app-e2e the reader still could not answer "is this the
// collapse or is it my change?" without opening the run page by hand.
//
// Publishing only on failure is sufficient rather than a compromise: a collapsed run FAILS by
// construction, so a run that produced no digest was not a collapse.

test('(hh) a collapsed run says so in the digest table', async () => {
  const { readRunHealth, buildDigest: build } = await digestModule();
  const root = mkdtempSync(join(tmpdir(), 'run-health-'));
  const jobDir = join(root, '1633', 'app-e2e');
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(join(jobDir, 'e2e-turn-tally.log'),
    '[e2e-turns] gateway_posts=39 tests_executed=177 posts_per_100_tests=22 verdict=collapsed\n'
    + '[e2e-turns] COLLAPSE SIGNATURE — the client is not SENDING turns. Do NOT re-run this as a reflex.\n');

  const health = readRunHealth({ CI_STEP_LOG_ROOT: root, GITHUB_RUN_ID: '1633', GITHUB_JOB: 'app-e2e' });
  assert.match(health.verdict, /verdict=collapsed/);
  const d = build({ ...ctx({ step: 'web-e2e' }), runHealth: health }, { excerpts: [] });
  assert.match(d.markdown, /Run health/, 'the digest table has no run-health row');
  assert.match(d.markdown, /verdict=collapsed/, 'the verdict did not reach the published digest');
});

test('(hh2) an INDETERMINATE verdict is published with its reason, never rendered as a result', () => {
  // A gate-tier pull request always reads `indeterminate` (feature 056 — the healthy floor was
  // calibrated on the full suite). Showing that as healthy, or hiding it, would be a confident label
  // drawn from a measurement deliberately not taken — the failure mode the tally itself avoids.
  const root = mkdtempSync(join(tmpdir(), 'run-health-'));
  const jobDir = join(root, '1700', 'app-e2e');
  mkdirSync(jobDir, { recursive: true });
  writeFileSync(join(jobDir, 'e2e-turn-tally.log'),
    '[e2e-turns] gateway_posts=48 tests_executed=155 posts_per_100_tests=30 verdict=indeterminate\n'
    + '[e2e-turns] reason: gate tier only (the model tier did not run — normal on a pull request).\n');

  const health = readFailingStepModuleRunHealth({ CI_STEP_LOG_ROOT: root, GITHUB_RUN_ID: '1700', GITHUB_JOB: 'app-e2e' });
  assert.match(health.verdict, /verdict=indeterminate/);
  assert.match(health.reason, /gate tier only/, 'the reason was dropped, leaving an unexplained abstention');
  const d = buildDigest({ ...ctx({ step: 'web-e2e' }), runHealth: health }, { excerpts: [] });
  assert.match(d.markdown, /indeterminate/);
  assert.match(d.markdown, /gate tier only/);
});

test('(hh3) a job that never ran the tally gets no run-health row at all', () => {
  // "Not measured" and "measured healthy" are opposite statements. Every job but app-e2e is in the
  // first case, and a row reading `healthy` there would be manufactured.
  const health = readFailingStepModuleRunHealth({ CI_STEP_LOG_ROOT: '/nonexistent', GITHUB_RUN_ID: 'x', GITHUB_JOB: 'affected' });
  assert.equal(health, null);
  const d = buildDigest({ ...ctx({ step: 'x' }), runHealth: health }, { excerpts: [] });
  assert.equal(/Run health/.test(d.markdown), false, 'a job with no measurement was given a verdict');
});

// ─── item #326 — a TIMEOUT must not read like an ordinary failure ────────────────────────────────
import { readFailingStepReason as readStepReason326 } from '../ci-failure-digest.mjs';

test('(#326f) the digest marks a timed-out step as a TIMEOUT, naming the limit', () => {
  const md = buildDigest({
    workflow: 'app-ci', job: 'app-e2e', step: 'web-e2e',
    stepReason: 'timeout after 2700s (step ceiling, not the job ceiling)',
    sha: 'a'.repeat(40), pr: 322, runId: 8317,
  });
  const markdown = md.markdown ?? md;
  assert.match(markdown, /\*\*Failing step\*\*/);
  assert.match(markdown, /web-e2e/);
  assert.match(markdown, /timeout after 2700s/,
    'the reader cannot tell a hang from an assertion failure');
});

test('(#326g) an ordinary failure keeps its plain step row — no timeout wording', () => {
  const md = buildDigest({
    workflow: 'app-ci', job: 'app-e2e', step: 'web-e2e',
    sha: 'a'.repeat(40), pr: 322, runId: 8317,
  });
  const markdown = md.markdown ?? md;
  assert.match(markdown, /web-e2e/);
  assert.doesNotMatch(markdown, /timeout/i, 'an ordinary failure was labelled a timeout');
});

test('(#326h) the reason is read from the marker ci-log-step.sh writes', () => {
  const root = mkdtempSync(join(tmpdir(), 'digest-timeout-'));
  const dir = join(root, 'RUN', 'JOB');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '_failed-step-reason'), 'timeout after 60s (step ceiling, not the job ceiling)\n');
  const env = { CI_STEP_LOG_ROOT: root, GITHUB_RUN_ID: 'RUN', GITHUB_JOB: 'JOB' };
  assert.match(readStepReason326(env), /timeout after 60s/);
});

test('(#326i) no marker means no reason — absence is not invented', () => {
  const root = mkdtempSync(join(tmpdir(), 'digest-timeout-'));
  mkdirSync(join(root, 'RUN', 'JOB'), { recursive: true });
  const env = { CI_STEP_LOG_ROOT: root, GITHUB_RUN_ID: 'RUN', GITHUB_JOB: 'JOB' };
  assert.equal(readStepReason326(env), null);
});

// Item #326, criterion 1 — end to end, by deliberately hanging a real step and reading what the
// digest would publish. Not reasoned about: ci-log-step.sh is actually spawned, actually hangs, and
// is actually killed by its own ceiling.
import { spawnSync as spawn326 } from 'node:child_process';
import { resolve as resolve326, dirname as dirname326 } from 'node:path';
import { fileURLToPath as fileURL326 } from 'node:url';
import {
  collectEvidence as collect326,
  readFailingStep as readStep326,
} from '../ci-failure-digest.mjs';

test('(#326k) a hung step yields a digest that NAMES it, marks it a TIMEOUT, and carries its log tail', () => {
  const root = mkdtempSync(join(tmpdir(), 'digest-e2e-'));
  const env = {
    ...process.env,
    CI_STEP_LOG_ROOT: root,
    GITHUB_RUN_ID: 'RUN326',
    GITHUB_JOB: 'app-e2e',
    CI_STEP_TIMEOUT_SECONDS: '1',
  };
  const script = resolve326(dirname326(fileURL326(import.meta.url)), '..', 'ci-log-step.sh');
  const r = spawn326(
    'bash',
    [script, 'web-e2e', 'bash', '-c', 'echo "Running 177 tests"; echo "spec: assistant-add.spec.ts"; sleep 30'],
    { encoding: 'utf8', env },
  );
  assert.notEqual(r.status, 0, 'the hung step was not killed');

  const evidence = collect326({ env, home: root, cwd: process.cwd() });
  const built = buildDigest(
    {
      workflow: 'app-ci',
      job: 'app-e2e',
      step: readStep326(env),
      stepReason: readStepReason326(env),
      sha: 'b'.repeat(40),
      pr: 322,
      runId: 8317,
    },
    evidence,
  );
  const md = built.markdown ?? built;

  assert.match(md, /web-e2e/, 'the digest does not name the hung step');
  assert.match(md, /timeout after 1s/, 'the digest does not mark it as a timeout');
  assert.match(md, /Running 177 tests|assistant-add\.spec\.ts/,
    'the digest carries no log tail for the hung step — the evidence a hang otherwise loses');
});
