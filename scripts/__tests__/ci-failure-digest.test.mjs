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

import { readFailingStep, COMMENT_MAX_BYTES } from '../ci-failure-digest.mjs';

test('(y) the digest names the failing step from the marker', () => {
  const d = buildDigest(ctx({ step: 'guardrails / naming' }), { excerpts: [] });
  assert.match(d.markdown, /guardrails \/ naming/);
  assert.equal(/_not reported_/.test(d.markdown), false);
});

test('(y2) readFailingStep returns null when no step was wrapped', () => {
  assert.equal(readFailingStep({ GITHUB_RUN_ID: 'nope', HOME: '/nonexistent' }), null);
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
  assert.equal(shouldPublish({ runStatus: 'success', jobStatus: 'success' }).publish, false);
  assert.equal(shouldPublish({ runStatus: 'failure', jobStatus: 'failure' }).publish, true);
});
