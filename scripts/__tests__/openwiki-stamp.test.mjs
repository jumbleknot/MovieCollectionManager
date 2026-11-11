// The concept provenance stamp (scripts/openwiki-stamp.mjs): which front-matter date says "this page
// was last brought up to date".
//
// The rule is the NEWEST of `generated.at` and `timestamp`. `verified.at` was a third candidate while
// openwiki's Grounded Claims existed (operator decision 2026-09-28); feature 098 retired Claims
// (ADR-0004), so `verified` is a forbidden field (V17) and is IGNORED here (research R2) — a stray one
// can never make a page look fresher than it is.

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

test('stamp: conceptStamp ignores verified.at, even when it is the newest value (feature 098, R2)', () => {
  const fields = { timestamp: '2026-07-04T21:46:33-04:00', verified: [{ by: 'openwiki/0.5.2', at: '2026-09-27T17:17:48.446Z' }] };
  assert.deepEqual(conceptStamp(fields), { value: '2026-07-04T21:46:33-04:00', field: 'timestamp' });
  assert.equal(conceptStamp({ verified: [{ at: '2026-09-27T00:00:00Z' }] }), null, 'verified alone is no stamp at all');
});

test('stamp: the NEWEST of generated.at and timestamp wins, and a newer verified.at is not a candidate', () => {
  const fields = {
    timestamp: '2026-01-01T00:00:00Z',
    generated: { by: 'openwiki/0.6.0', at: '2026-09-01T00:00:00Z' },
    verified: [{ by: 'a', at: '2026-09-20T00:00:00Z' }, { by: 'b', at: '2026-08-01T00:00:00Z' }],
  };
  assert.deepEqual(conceptStamp(fields), { value: '2026-09-01T00:00:00Z', field: 'generated.at' });
  // …and a session refresh's `timestamp`, newer than the last generation, wins over it.
  assert.equal(conceptStamp({ ...fields, timestamp: '2026-11-10T00:00:00Z' }).field, 'timestamp');
});

test('stamp: a single mapping-shaped verified event is ignored too', () => {
  assert.equal(conceptStamp({ timestamp: '2001-01-01T00:00:00Z', verified: { by: 'x', at: '2026-09-27T00:00:00Z' } }).field, 'timestamp');
});

test('stamp: an unparseable value never wins over a parseable one', () => {
  assert.equal(conceptStamp({ timestamp: '2026-01-01T00:00:00Z', generated: { at: 'nope' } }).field, 'timestamp');
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
  assert.equal(conceptStamp({ generated: { at: '2026-09-27T00:00:00Z\r' } }).value, '2026-09-27T00:00:00Z');
});

test('stampValues: every candidate, list entries included, for V5 to validate — verified is not one', () => {
  const values = stampValues({ timestamp: 't', generated: [{ at: 'g1' }, { at: 'g2' }, { by: 'no-at' }], verified: [{ at: 'v1' }] });
  assert.deepEqual(values.map((v) => `${v.field}=${v.value}`), ['generated.at=g1', 'generated.at=g2', 'timestamp=t']);
});
