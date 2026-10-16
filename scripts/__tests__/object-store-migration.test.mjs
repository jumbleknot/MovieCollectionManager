// Feature 080 (item #560) — the pure logic of the MinIO → RustFS migration tool.
//
// The tool moves PRODUCTION data, so every decision it takes from facts — "may this drive be
// migrated?", "did every object arrive?", "which objects do we checksum?", "what did the operator
// actually ask for?" — is a pure function tested here, in `guardrails`, with no Docker. The
// Docker-driving half is proved end to end by object-store-migration.rehearsal.mjs (deliberately not
// a *.test.mjs, so guardrails' glob, which has no daemon, never runs it).
//
// WHY EACH GROUP EXISTS:
//
//   * classifyDrive — RustFS reads MinIO's `xl-single` erasure layout and nothing else (research R6):
//     the legacy FS layout is unreadable, a multi-drive set must match drive-for-drive, SSE objects
//     fail closed, tiered objects are not fixture-proven, and a notification target exists in no
//     stack. Each is a REFUSAL, and a refusal must name its reason — "refused" alone sends the
//     operator back to grep.
//
//   * diffManifests — the parity check IS the evidence that production data survived (SC-001). A
//     diff that cannot see an ETag change is a diff that passes a corrupted copy.
//
//   * checksumSample — the sample must be the SAME on both sides, or the old and new checksums are
//     of different objects; and it must contain every multipart object, because a multipart ETag is
//     not an MD5 of the content and proves nothing about the bytes on its own.
//
//   * resolveCommand — CLAUDE.md: an unrecognised `--dry-run` once meant "delete for real". The tool
//     is read-only by default, `copy` acts only with `--apply`, and anything unrecognised is refused
//     through the shared rejecting parser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ArgvError, usageNamesEveryFlag } from '../lib/argv-contract.mjs';
import {
  USAGE,
  ACCEPTED_FLAGS,
  VALUE_FLAGS,
  resolveCommand,
  classifyDrive,
  parseInventoryOutput,
  diffManifests,
  checksumSample,
  parityReport,
  parseListBuckets,
  parseListObjects,
  parseListVersions,
  s3Path,
  pinnedRustfsRef,
} from '../object-store-migration.mjs';

// A real `format.json` shape, as T003 read it on the production host (both drives).
const XL_SINGLE = {
  version: '1',
  format: 'xl-single',
  id: 'b0d8d7c6-0000-4000-8000-000000000001',
  xl: {
    version: '3',
    this: 'a1b2c3d4-0000-4000-8000-000000000002',
    sets: [['a1b2c3d4-0000-4000-8000-000000000002']],
    distributionAlgo: 'SIPMOD+PARITY',
  },
};
const CLEAN = { sseObjects: 0, tieredObjects: 0, notificationBuckets: [], selfTest: { sse: 1, tiered: 1 } };

// ── classifyDrive ───────────────────────────────────────────────────────────────────────────────

test('classifyDrive accepts a single-drive xl-single layout with nothing blocking', () => {
  const r = classifyDrive(XL_SINGLE, CLEAN);
  assert.equal(r.verdict, 'migratable');
  assert.deepEqual(r.reasons, []);
  assert.equal(r.format, 'xl-single');
});

test('classifyDrive refuses the legacy FS layout and says so', () => {
  const r = classifyDrive({ version: '1', format: 'fs', fs: { version: '2' } }, CLEAN);
  assert.equal(r.verdict, 'refused');
  assert.match(r.reasons.join('\n'), /format.*fs/i);
});

test('classifyDrive refuses a missing or unreadable format record', () => {
  for (const bad of [null, undefined, {}, 'not json']) {
    const r = classifyDrive(bad, CLEAN);
    assert.equal(r.verdict, 'refused', `accepted ${JSON.stringify(bad)}`);
  }
});

test('classifyDrive refuses a multi-set layout', () => {
  const two = structuredClone(XL_SINGLE);
  two.format = 'xl';
  two.xl.sets = [['a'], ['b']];
  const r = classifyDrive(two, CLEAN);
  assert.equal(r.verdict, 'refused');
  assert.match(r.reasons.join('\n'), /set/i);
});

test('classifyDrive refuses a multi-drive set even when the format string says xl-single', () => {
  const wide = structuredClone(XL_SINGLE);
  wide.xl.sets = [['a', 'b', 'c', 'd']];
  const r = classifyDrive(wide, CLEAN);
  assert.equal(r.verdict, 'refused');
  assert.match(r.reasons.join('\n'), /drive/i);
});

test('classifyDrive refuses server-side-encrypted objects (RustFS fails closed on them)', () => {
  const r = classifyDrive(XL_SINGLE, { ...CLEAN, sseObjects: 1 });
  assert.equal(r.verdict, 'refused');
  assert.match(r.reasons.join('\n'), /encrypt|SSE/i);
});

test('classifyDrive refuses tiered objects (not fixture-proven upstream)', () => {
  const r = classifyDrive(XL_SINGLE, { ...CLEAN, tieredObjects: 3 });
  assert.equal(r.verdict, 'refused');
  assert.match(r.reasons.join('\n'), /tier/i);
});

test('classifyDrive refuses a bucket with a notification configuration, naming the bucket', () => {
  const r = classifyDrive(XL_SINGLE, { ...CLEAN, notificationBuckets: ['langfuse'] });
  assert.equal(r.verdict, 'refused');
  assert.match(r.reasons.join('\n'), /notification.*langfuse/i);
});

test('classifyDrive reports EVERY blocking reason, not just the first', () => {
  const r = classifyDrive({ format: 'fs' }, { sseObjects: 2, tieredObjects: 1, notificationBuckets: ['x'] });
  assert.equal(r.verdict, 'refused');
  assert.ok(r.reasons.length >= 4, `only ${r.reasons.length} reason(s): ${r.reasons.join(' | ')}`);
});

test('classifyDrive refuses when a count is missing — an absent measurement is not a zero', () => {
  const r = classifyDrive(XL_SINGLE, { tieredObjects: 0, notificationBuckets: [], selfTest: { sse: 1, tiered: 1 } });
  assert.equal(r.verdict, 'refused');
  assert.match(r.reasons.join('\n'), /sse/i);
});

test('classifyDrive refuses when the grep instrument failed its self-test, or none was run', () => {
  // MEASURED 2026-10-11: BusyBox grep in its default locale MISSES a pattern that follows non-UTF-8
  // bytes on the same line, which is every real marker in a binary xl.meta. On a drive holding one
  // real SSE-S3 object it printed 0; with LC_ALL=C, 1. The `XL2 ` control did not catch it, because
  // that header precedes every high byte. So the instrument must find a planted marker AFTER high
  // bytes before its zeros are believed.
  for (const selfTest of [{ sse: 0, tiered: 1 }, { sse: 1, tiered: 0 }, undefined]) {
    const r = classifyDrive(XL_SINGLE, { ...CLEAN, selfTest });
    assert.equal(r.verdict, 'refused', JSON.stringify(selfTest));
    assert.match(r.reasons.join('\n'), /self-test|instrument/i);
  }
});

// ── parseInventoryOutput ──────────────────────────────────────────────────────────────────────

test('parseInventoryOutput reads the in-container report and refuses a failed control count', () => {
  const text = [
    `FORMAT ${JSON.stringify(XL_SINGLE)}`,
    'SELFTEST 1 1',
    'XLMETA 36',
    'CONTROL 36',
    'SSE 0',
    'TIERED 0',
    'OWNER 1000',
    'IAMUSERS 0',
    'BUCKET langfuse 36 1234567 1 0 0 0',
    'TREEDIGEST ' + 'a'.repeat(64),
    'FILES 120',
  ].join('\n');
  const inv = parseInventoryOutput(text);
  assert.equal(inv.xlMetaFiles, 36);
  assert.equal(inv.control, 36);
  assert.equal(inv.sseObjects, 0);
  assert.equal(inv.ownerUid, 1000);
  assert.equal(inv.treeDigest, 'a'.repeat(64));
  assert.deepEqual(inv.buckets, [
    { name: 'langfuse', objects: 36, bytes: 1234567, hasMetadataBin: true, versioning: false, lifecycle: false, notification: false },
  ]);
  assert.equal(inv.format.format, 'xl-single');
  assert.deepEqual(inv.selfTest, { sse: 1, tiered: 1 });
});

test('parseInventoryOutput: a control count below the xl.meta count invalidates the zeros', () => {
  // T003's first attempt printed `0` for SSE and tiered because BusyBox grep had no --include —
  // the zeros were `wc -l` of empty output. The control count is what tells a measurement from
  // a broken instrument, so a mismatch must surface as a refusal reason, never be ignored.
  const text = [`FORMAT ${JSON.stringify(XL_SINGLE)}`, 'SELFTEST 1 1', 'XLMETA 36', 'CONTROL 0', 'SSE 0', 'TIERED 0',
    'OWNER 1000', 'IAMUSERS 0', 'TREEDIGEST ' + 'b'.repeat(64), 'FILES 40'].join('\n');
  const inv = parseInventoryOutput(text);
  const r = classifyDrive(inv.format, inv);
  assert.equal(r.verdict, 'refused');
  assert.match(r.reasons.join('\n'), /control/i);
});

test('parseInventoryOutput throws on a report with a missing line rather than defaulting it', () => {
  assert.throws(() => parseInventoryOutput('XLMETA 3\nCONTROL 3'), /missing/i);
});

// ── diffManifests / parityReport ────────────────────────────────────────────────────────────────

const obj = (key, size, etag, extra = {}) => ({ bucket: 'langfuse', key, size, etag, ...extra });
const OLD = {
  takenAt: '2026-10-11T10:00:00.000Z',
  objects: [obj('a.json', 10, '"aaa"'), obj('media/big.bin', 90_000_000, '"bbb-18"'), obj('b.json', 20, '"ccc"')],
};

test('diffManifests: identical listings produce no discrepancy', () => {
  const d = diffManifests(OLD, structuredClone(OLD));
  for (const k of ['missing', 'unexpected', 'sizeMismatch', 'etagMismatch', 'writtenAfterManifest']) {
    assert.deepEqual(d[k], [], k);
  }
});

test('diffManifests names a missing object', () => {
  const d = diffManifests(OLD, { objects: OLD.objects.slice(1) });
  assert.deepEqual(d.missing.map((o) => o.key), ['a.json']);
});

test('diffManifests names a size mismatch and an ETag mismatch separately', () => {
  const now = structuredClone(OLD);
  now.objects[0].size = 11;
  now.objects[2].etag = '"zzz"';
  const d = diffManifests(OLD, now);
  assert.deepEqual(d.sizeMismatch.map((o) => o.key), ['a.json']);
  assert.deepEqual(d.etagMismatch.map((o) => o.key), ['b.json']);
});

test('diffManifests compares ETags with or without quotes — the S3 XML and a HEAD differ in quoting', () => {
  const now = structuredClone(OLD);
  now.objects[0].etag = 'aaa';
  assert.deepEqual(diffManifests(OLD, now).etagMismatch, []);
});

test('diffManifests: an object the old store never had is unexpected — unless it was written after the manifest', () => {
  const now = structuredClone(OLD);
  now.objects.push(obj('stray.json', 1, '"x"', { lastModified: '2026-10-11T09:00:00.000Z' }));
  now.objects.push(obj('new-trace.json', 1, '"y"', { lastModified: '2026-10-11T12:00:00.000Z' }));
  const d = diffManifests(OLD, now);
  assert.deepEqual(d.unexpected.map((o) => o.key), ['stray.json']);
  assert.deepEqual(d.writtenAfterManifest.map((o) => o.key), ['new-trace.json']);
});

test('diffManifests keys by bucket AND key — the same key in two buckets is two objects', () => {
  const old = { objects: [obj('k', 1, '"e"'), { bucket: 'other', key: 'k', size: 1, etag: '"e"' }] };
  const d = diffManifests(old, { objects: [obj('k', 1, '"e"')] });
  assert.deepEqual(d.missing.map((o) => `${o.bucket}/${o.key}`), ['other/k']);
});

test('diffManifests compares object VERSIONS when the manifest carries them, delete markers included', () => {
  const v = (key, versionId, extra = {}) => ({ bucket: 'versioned', key, versionId, size: 3, etag: '"v"', ...extra });
  const old = { objects: [], versions: [v('doc', 'v1'), v('doc', 'v2'), v('doc', 'dm1', { deleteMarker: true, size: 0, etag: '' })] };
  const d = diffManifests(old, { objects: [], versions: [v('doc', 'v1'), v('doc', 'v2')] });
  assert.deepEqual(d.missing.map((o) => o.versionId), ['dm1']);
});

test('parityReport passes only when every discrepancy list is empty', () => {
  const ok = parityReport(OLD, structuredClone(OLD), []);
  assert.equal(ok.verdict, 'pass');
  assert.deepEqual(ok.totals.old, { objects: 3, bytes: 90_000_030 });
  assert.deepEqual(ok.totals.new, { objects: 3, bytes: 90_000_030 });

  const bad = parityReport(OLD, structuredClone(OLD), [{ bucket: 'langfuse', key: 'a.json', old: 'x', new: 'y' }]);
  assert.equal(bad.verdict, 'fail');
  assert.equal(bad.checksumMismatch.length, 1);

  const now = structuredClone(OLD);
  now.objects[1].etag = '"bbb-19"';
  assert.equal(parityReport(OLD, now, []).verdict, 'fail');
});

test('parityReport does not fail on objects written after the manifest, but reports them', () => {
  const now = structuredClone(OLD);
  now.objects.push(obj('later.json', 1, '"l"', { lastModified: '2026-10-11T12:00:00.000Z' }));
  const r = parityReport(OLD, now, []);
  assert.equal(r.verdict, 'pass');
  assert.equal(r.writtenAfterManifest.length, 1);
});

// ── checksumSample ──────────────────────────────────────────────────────────────────────────────

const many = (n, multipartEvery = 0) =>
  Array.from({ length: n }, (_, i) =>
    obj(`events/${i}.json`, i, multipartEvery && i % multipartEvery === 0 ? `"m${i}-2"` : `"e${i}"`));

test('checksumSample takes every object when there are fewer than 200', () => {
  assert.equal(checksumSample(many(199)).length, 199);
});

test('checksumSample is deterministic and independent of listing order', () => {
  const objs = many(500);
  const a = checksumSample(objs).map((o) => o.key);
  const b = checksumSample([...objs].reverse()).map((o) => o.key);
  assert.deepEqual(a, b);
  assert.equal(a.length, 50);
});

test('checksumSample includes EVERY multipart object on top of the 50-key sample', () => {
  const objs = many(1000, 10); // 100 multipart ETags
  const s = checksumSample(objs);
  const multipart = objs.filter((o) => o.etag.includes('-')).map((o) => o.key);
  for (const k of multipart) assert.ok(s.some((o) => o.key === k), `multipart ${k} not sampled`);
  assert.ok(s.length >= 100 && s.length <= 150, `unexpected sample size ${s.length}`);
  assert.equal(new Set(s.map((o) => `${o.bucket}/${o.key}`)).size, s.length, 'duplicates in sample');
});

// ── S3 XML parsing and paths ──────────────────────────────────────────────────────────────────

test('parseListBuckets reads bucket names', () => {
  const xml = '<?xml version="1.0"?><ListAllMyBucketsResult><Buckets><Bucket><Name>langfuse</Name>' +
    '<CreationDate>2026-01-01T00:00:00.000Z</CreationDate></Bucket><Bucket><Name>nx-cache</Name></Bucket>' +
    '</Buckets></ListAllMyBucketsResult>';
  assert.deepEqual(parseListBuckets(xml), ['langfuse', 'nx-cache']);
});

test('parseListObjects reads keys, sizes, ETags, entities and the continuation token', () => {
  const xml = '<ListBucketResult><IsTruncated>true</IsTruncated>' +
    '<NextContinuationToken>tok/1=</NextContinuationToken>' +
    '<Contents><Key>events/a&amp;b.json</Key><LastModified>2026-10-11T10:00:00.000Z</LastModified>' +
    '<ETag>&quot;abc&quot;</ETag><Size>12</Size></Contents>' +
    '<Contents><Key>media/x.bin</Key><LastModified>2026-10-11T10:00:01.000Z</LastModified>' +
    '<ETag>"def-3"</ETag><Size>99</Size></Contents></ListBucketResult>';
  const r = parseListObjects(xml, 'langfuse');
  assert.equal(r.truncated, true);
  assert.equal(r.nextToken, 'tok/1=');
  assert.deepEqual(r.objects, [
    { bucket: 'langfuse', key: 'events/a&b.json', size: 12, etag: '"abc"', lastModified: '2026-10-11T10:00:00.000Z' },
    { bucket: 'langfuse', key: 'media/x.bin', size: 99, etag: '"def-3"', lastModified: '2026-10-11T10:00:01.000Z' },
  ]);
});

test('parseListObjects refuses a response that is not a listing (an S3 error body is not "empty")', () => {
  assert.throws(() => parseListObjects('<Error><Code>AccessDenied</Code></Error>', 'b'), /AccessDenied|not a listing/i);
});

test('parseListVersions reads versions and delete markers', () => {
  const xml = '<ListVersionsResult><IsTruncated>false</IsTruncated>' +
    '<Version><Key>doc</Key><VersionId>v2</VersionId><IsLatest>false</IsLatest><ETag>"e2"</ETag><Size>3</Size></Version>' +
    '<DeleteMarker><Key>doc</Key><VersionId>dm</VersionId><IsLatest>true</IsLatest></DeleteMarker>' +
    '</ListVersionsResult>';
  const r = parseListVersions(xml, 'versioned');
  assert.equal(r.truncated, false);
  assert.deepEqual(
    r.versions.map((v) => [v.key, v.versionId, Boolean(v.deleteMarker), v.isLatest]),
    [['doc', 'v2', false, false], ['doc', 'dm', true, true]],
  );
});

test('s3Path encodes each key segment but keeps the slashes', () => {
  assert.equal(s3Path('langfuse', 'events/a b/c+d.json'), '/langfuse/events/a%20b/c%2Bd.json');
  assert.equal(s3Path('langfuse'), '/langfuse');
});

// ── the pinned image is read from compose, not restated ───────────────────────────────────────

test('pinnedRustfsRef reads the one rustfs/rustfs ref from a compose file', () => {
  const ref = 'rustfs/rustfs:1.0.1@sha256:' + 'c'.repeat(64);
  assert.equal(pinnedRustfsRef(`services:\n  s:\n    image: ${ref}\n  t:\n    image: ${ref}\n`), ref);
  assert.throws(() => pinnedRustfsRef('services: {}\n'), /no rustfs/i);
  assert.throws(
    () => pinnedRustfsRef(`a: rustfs/rustfs:1.0.1@sha256:${'c'.repeat(64)}\nb: rustfs/rustfs:1.0.2@sha256:${'d'.repeat(64)}\n`),
    /more than one/i,
  );
  assert.throws(() => pinnedRustfsRef('image: rustfs/rustfs:1.0.1\n'), /digest/i);
});

// ── resolveCommand: the operator's words, and nothing else ──────────────────────────────────────

test('resolveCommand: copy WITHOUT --apply is refused, not run as a dry run', () => {
  assert.throws(
    () => resolveCommand(['copy', '--from', 'a', '--to', 'b', '--out', 'copy.json']),
    (e) => e instanceof ArgvError && /--apply/.test(e.message),
  );
});

test('resolveCommand: copy WITH --apply resolves, carrying every value', () => {
  const r = resolveCommand(['copy', '--from', 'a', '--to', 'b', '--out', 'copy.json', '--apply']);
  assert.equal(r.command, 'copy');
  assert.equal(r.apply, true);
  assert.equal(r.options.from, 'a');
  assert.equal(r.options.to, 'b');
  assert.equal(r.options.out, 'copy.json');
});

test('resolveCommand rejects the near-miss spellings that once meant "act for real"', () => {
  for (const typo of ['--dry-run', '--dryrun', '--dry_run', '-dry-run', '--Apply', '--force']) {
    assert.throws(
      () => resolveCommand(['inventory', '--volume', 'v', '--out', 'i.json', typo]),
      ArgvError,
      `${typo} was accepted`,
    );
  }
});

test('resolveCommand rejects an unknown subcommand and a missing one', () => {
  assert.throws(() => resolveCommand(['migrate', '--apply']), ArgvError);
  assert.throws(() => resolveCommand([]), ArgvError);
});

test('resolveCommand refuses --apply on a read-only subcommand rather than ignoring it', () => {
  // A stray `--apply` on `verify` would otherwise be a no-op that teaches the operator the flag
  // is harmless decoration.
  assert.throws(() => resolveCommand(['verify', '--endpoint', 'http://x:9000', '--network', 'n',
    '--manifest', 'm.json', '--out', 'p.json', '--apply']), ArgvError);
});

test('resolveCommand requires each subcommand\'s values instead of defaulting them', () => {
  assert.throws(() => resolveCommand(['inventory', '--out', 'i.json']), /--volume/);
  assert.throws(() => resolveCommand(['manifest', '--endpoint', 'http://x:9000', '--out', 'm.json']), /--network/);
  assert.throws(() => resolveCommand(['verify', '--endpoint', 'http://x:9000', '--network', 'n', '--out', 'p.json']), /--manifest/);
  assert.throws(() => resolveCommand(['copy', '--from', 'a', '--out', 'c.json', '--apply']), /--to/);
});

test('resolveCommand refuses copying a volume onto itself', () => {
  assert.throws(() => resolveCommand(['copy', '--from', 'a', '--to', 'a', '--out', 'c.json', '--apply']), /itself|same/i);
});

test('resolveCommand: --help never acts', () => {
  assert.equal(resolveCommand(['copy', '--help']).command, 'help');
  assert.equal(resolveCommand(['--help']).command, 'help');
});

test('USAGE names every accepted flag', () => {
  assert.deepEqual(usageNamesEveryFlag(USAGE, [...ACCEPTED_FLAGS, ...VALUE_FLAGS]), []);
});
