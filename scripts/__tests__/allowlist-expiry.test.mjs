// Guards scripts/allowlist-expiry.mjs — the single home for allowlist expiry semantics.
//
// Contract: specs/057-dependency-security-loop/contracts/allowlist-expiry.module.md
//
// Expiry used to be BINARY: full suppression until the date, hard fail the next morning, no signal
// between — and the failure surfaced on whichever unrelated pull request happened to run first. This
// module adds the tier in between. It is pure on purpose: `today` is always passed in, never read
// from the clock, so both inclusive boundaries are testable without mocking time and a runner's
// timezone cannot shift a classification.
//
// The unmatched-entry cases are the subtle half. An entry keyed on an exact advisory id silently
// stops suppressing when a scanner switches identifier namespace — measured here when pip-audit
// began reporting CVE-2026-69244 as PYSEC-2026-3545 and the aiohttp/cryptography entries "did not
// expire, they just quietly matched nothing". But reporting every unmatched entry would go red every
// time a scanner was skipped, so the scanner-produced-findings guard is what keeps the weekly signal
// worth reading.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  WARNING_WINDOW_DAYS,
  classifyExpiry,
  daysUntil,
  selectUnmatched,
  formatExpiring,
  formatExpired,
  formatUnmatched,
} from '../allowlist-expiry.mjs';

const TODAY = '2026-08-13';

test('the warning window is 14 days', () => {
  assert.equal(WARNING_WINDOW_DAYS, 14);
});

test('daysUntil counts whole days on UTC boundaries and goes negative once past', () => {
  assert.equal(daysUntil('2026-08-13', TODAY), 0);
  assert.equal(daysUntil('2026-08-27', TODAY), 14);
  assert.equal(daysUntil('2026-08-12', TODAY), -1);
  // Across a month end, and across the DST transition a local-time implementation would fumble.
  assert.equal(daysUntil('2026-09-07', TODAY), 25);
  assert.equal(daysUntil('2026-11-05', '2026-10-29'), 7);
});

test('(1) an entry with no expiry is active', () => {
  assert.equal(classifyExpiry(undefined, TODAY), 'active');
  assert.equal(classifyExpiry(null, TODAY), 'active');
});

test('(2) 15 days out is active — one day beyond the window', () => {
  assert.equal(classifyExpiry('2026-08-28', TODAY), 'active');
});

test('(3) exactly 14 days out is expiring — the upper boundary is inclusive', () => {
  assert.equal(classifyExpiry('2026-08-27', TODAY), 'expiring');
});

test('(4) 1 day out is expiring', () => {
  assert.equal(classifyExpiry('2026-08-14', TODAY), 'expiring');
});

test('(5) expiry === today is expiring, NOT expired — an entry suppresses through its final day', () => {
  assert.equal(classifyExpiry(TODAY, TODAY), 'expiring');
});

test('(6) yesterday is expired', () => {
  assert.equal(classifyExpiry('2026-08-12', TODAY), 'expired');
});

test('(7) formatExpiring names the id, the date, the days remaining and who added it', () => {
  const out = formatExpiring(
    [{ id: 'GHSA-7p8r-x3mc-p8w7', addedBy: 'steve', expiry: '2026-08-23', scanner: 'pnpm-audit' }],
    TODAY,
  );
  assert.match(out, /GHSA-7p8r-x3mc-p8w7/);
  assert.match(out, /2026-08-23/);
  assert.match(out, /\b10\b/, 'the day count must appear, not just the date');
  assert.match(out, /steve/);
});

test('(8) formatExpired states the finding WAS suppressed until the date, and by whom', () => {
  const out = formatExpired({ id: 'GHSA-xxxx', addedBy: 'steve', expiry: '2026-08-01', scanner: 'pnpm-audit' });
  assert.match(out, /GHSA-xxxx/);
  assert.match(out, /suppressed until/i, 'the point of this line is that the failure explains itself');
  assert.match(out, /2026-08-01/);
  assert.match(out, /steve/);
});

test('formatUnmatched names the entry, who added it, and that it matched nothing', () => {
  const out = formatUnmatched([{ id: 'GHSA-yyyy', addedBy: 'steve', scanner: 'pip-audit' }]);
  assert.match(out, /GHSA-yyyy/);
  assert.match(out, /steve/);
  assert.match(out, /matched nothing|suppressed nothing/i);
});

// --- unmatched selection: the clarification-Q2 guard ---------------------------------------------

const ENTRY = (over) => ({ key: 'k1', id: 'GHSA-yyyy', addedBy: 'steve', expiry: undefined, scanner: 'pnpm-audit', ...over });

test('(9) an unmatched entry IS reported when its scanner produced findings', () => {
  const out = selectUnmatched([ENTRY()], new Set(), new Set(['pnpm-audit']));
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'GHSA-yyyy');
});

test('(10) an unmatched entry is NOT reported when its scanner produced no findings', () => {
  // A skipped, failed or genuinely clean scanner must never flag its whole entry set — otherwise the
  // weekly check goes red saying "stale entry" when the truth is "the scanner did not run".
  const out = selectUnmatched([ENTRY()], new Set(), new Set(['semgrep']));
  assert.deepEqual(out, []);
  assert.deepEqual(selectUnmatched([ENTRY()], new Set(), new Set()), []);
});

test('(11) a matched entry is never reported, regardless of scanner activity', () => {
  assert.deepEqual(selectUnmatched([ENTRY()], new Set(['k1']), new Set(['pnpm-audit'])), []);
  assert.deepEqual(selectUnmatched([ENTRY()], new Set(['k1']), new Set()), []);
});

test('matching is by unique key, not by advisory id — two allowlists reuse ids across targets', () => {
  // e.g. CVE-2025-68121 appears against BOTH hashicorp/vault and minio/mc in the infra-image
  // allowlist. Keying on the id alone would let one entry's match silently cover the other's staleness.
  const shared = [ENTRY({ key: 'vault', id: 'CVE-2025-68121' }), ENTRY({ key: 'minio', id: 'CVE-2025-68121' })];
  const out = selectUnmatched(shared, new Set(['vault']), new Set(['pnpm-audit']));
  assert.equal(out.length, 1);
  assert.equal(out[0].key, 'minio');
});

test('an expiring entry can also be unmatched — the two properties are orthogonal', () => {
  const entry = ENTRY({ expiry: '2026-08-20' });
  assert.equal(classifyExpiry(entry.expiry, TODAY), 'expiring');
  assert.equal(selectUnmatched([entry], new Set(), new Set(['pnpm-audit'])).length, 1);
});
