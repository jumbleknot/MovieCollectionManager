// The concept provenance stamp (scripts/openwiki-stamp.mjs): which front-matter date says "this page
// was last brought up to date", shared by the OKF gate's V12 drift warning and wiki-maintain's #587
// stale-skip check so the two can never disagree.
//
// The rule is the NEWEST of `generated.at`, `verified.at` and `timestamp` (operator decision
// 2026-09-28). openwiki 0.5.x/0.6.0 can re-verify a page's Grounded Claims against its sources and
// leave the body — and so `generated` and `timestamp` — untouched; measured on
// openwiki/decisions/adr-0001-prod-secrets-management.md, verified 17:17Z after its source changed at
// 16:17Z yet reported stale, and on projects/agent-gateway.md, whose body was rewritten by 0.6.0 with
// only `verified` added. `verified` is written as a LIST of events, which a path reader that does not
// descend arrays silently never sees.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { conceptStamp, stampValues } = await import(pathToFileURL(join(REPO_ROOT, 'scripts', 'openwiki-stamp.mjs')).href);

test('stamp: a v0.1 page is read by its timestamp', () => {
  assert.deepEqual(conceptStamp({ timestamp: '2026-07-04T21:46:33-04:00' }), { value: '2026-07-04T21:46:33-04:00', field: 'timestamp' });
});

test('stamp: generated.at wins over an older legacy timestamp', () => {
  assert.equal(conceptStamp({ timestamp: '2001-01-01T00:00:00Z', generated: { by: 'openwiki/0.6.0', at: '2026-09-27T19:35:04.178Z' } }).field, 'generated.at');
});

test('stamp: a verified list newer than timestamp wins — the adr-0001 shape', () => {
  const fields = { timestamp: '2026-07-04T21:46:33-04:00', verified: [{ by: 'openwiki/0.5.2', at: '2026-09-27T17:17:48.446Z' }] };
  assert.deepEqual(conceptStamp(fields), { value: '2026-09-27T17:17:48.446Z', field: 'verified.at' });
});

test('stamp: the NEWEST event wins, whichever field and list position holds it', () => {
  const fields = {
    timestamp: '2026-01-01T00:00:00Z',
    generated: { by: 'openwiki/0.6.0', at: '2026-09-01T00:00:00Z' },
    verified: [{ by: 'a', at: '2026-09-20T00:00:00Z' }, { by: 'b', at: '2026-08-01T00:00:00Z' }],
  };
  assert.deepEqual(conceptStamp(fields), { value: '2026-09-20T00:00:00Z', field: 'verified.at' });
  // …and an OLDER verification never drags a newer generation backwards.
  assert.equal(conceptStamp({ ...fields, generated: { at: '2026-09-25T00:00:00Z' } }).field, 'generated.at');
});

test('stamp: a single mapping-shaped verified event is read too', () => {
  assert.equal(conceptStamp({ timestamp: '2001-01-01T00:00:00Z', verified: { by: 'x', at: '2026-09-27T00:00:00Z' } }).field, 'verified.at');
});

test('stamp: an unparseable value never wins over a parseable one', () => {
  assert.equal(conceptStamp({ timestamp: '2026-01-01T00:00:00Z', verified: [{ at: 'nope' }] }).field, 'timestamp');
});

test('stamp: when nothing parses, the first present value comes back so the caller counts it unstampable', () => {
  const s = conceptStamp({ timestamp: 'someday' });
  assert.equal(s.value, 'someday');
  assert.ok(Number.isNaN(Date.parse(s.value)));
});

test('stamp: no stamp at all is null', () => {
  assert.equal(conceptStamp({ type: 'R' }), null);
  assert.equal(conceptStamp({ verified: [] }), null);
});

test('stamp: values are trimmed, so a CRLF checkout cannot turn a date into NaN', () => {
  assert.equal(conceptStamp({ verified: [{ at: '2026-09-27T00:00:00Z\r' }] }).value, '2026-09-27T00:00:00Z');
});

test('stampValues: every candidate, list entries included, for V5 to validate', () => {
  const values = stampValues({ timestamp: 't', generated: { at: 'g' }, verified: [{ at: 'v1' }, { at: 'v2' }, { by: 'no-at' }] });
  assert.deepEqual(values.map((v) => `${v.field}=${v.value}`), ['generated.at=g', 'verified.at=v1', 'verified.at=v2', 'timestamp=t']);
});
