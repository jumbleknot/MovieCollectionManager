// Feature 052 US4 — the instrument SC-004 is judged with.
//
// HONESTY NOTE ON ORDER: unlike the rest of this feature, the script came before this file. It was
// written to be validated against two runs whose numbers are independently published in
// docs/proposals/PRD-E2EWorkerSessionContention.md §1.1, and it reproduced all of them exactly:
//
//   run 1603 → failed=33 flaky=15 passed=126     (PRD: 33 / 15 / 126)
//   run 1604 → failed=61 flaky=37 passed=76      (PRD: 61 / 37 / 76)
//   diff     → both=26 onlyA=7 onlyB=35          (PRD: "26 in both · 7 only in #1603 · 35 only in #1604")
//
// That is a stronger check than any fixture written here, because the expected values were fixed by a
// different session from a different artifact. These tests pin the parsing RULES that the golden run
// exercises only incidentally — the ones where a wrong answer would be quiet rather than obvious.
//
// Deterministic, offline, token-free, node: built-ins only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePlaywrightSummary,
  runCounts,
  failureSet,
  diffFailureSets,
} from '../e2e-failure-set.mjs';

/** A Playwright `dot`-reporter tail, in the shape the CI bundle captures. */
const RUN_A = `
Running 177 tests using 8 workers
··········F·····F
  3 failed
    [chromium] › tests/e2e/web/movies.spec.ts:897:9 › Movie filter exact counts › filter Type = Movie → exactly 5 movies
    [chromium] › tests/e2e/web/movies.spec.ts:897:9 › Movie filter exact counts › filter Type = Concert → exactly 2 movies
    [chromium] › tests/e2e/web/theme.spec.ts:70:7 › Theme toggle + persistence › toggles back to dark and persists
  2 flaky
    [chromium] › tests/e2e/web/agent-search.spec.ts:20:7 › Assistant search › finds a movie
    [chromium] › tests/e2e/web/perf.spec.ts:50:7 › bundle + cold TTI › measure transferred JS
  1 did not run
  171 passed (17.9m)
`;

const RUN_B = `
  3 failed
    [chromium] › tests/e2e/web/movies.spec.ts:897:9 › Movie filter exact counts › filter Type = Movie → exactly 5 movies
    [chromium] › tests/e2e/web/theme.spec.ts:70:7 › Theme toggle + persistence › toggles back to dark and persists
    [chromium] › tests/e2e/web/responsive.spec.ts:55:9 › responsive › home has no horizontal overflow
  0 flaky
  174 passed (1.1h)
`;

test('counts come from the section headers, and every section is read', () => {
  const c = runCounts(RUN_A);
  assert.deepEqual(c, {
    failed: 3, flaky: 2, passed: 171, didNotRun: 1, skipped: 0, failedListed: 3,
  });
});

test('identity keeps line:col — parameterised cases sharing a title must not merge', () => {
  // movies.spec.ts:897 appears repeatedly under one describe, differing only in the filter. Dropping
  // line/col (or the title tail) would collapse them into one identity, silently SHRINKING the diff
  // and making a still-varying failure set look empty — the exact false pass SC-004 exists to catch.
  const s = failureSet(RUN_A);
  assert.equal(s.size, 3);
  assert.ok([...s].some((t) => t.includes('filter Type = Movie')));
  assert.ok([...s].some((t) => t.includes('filter Type = Concert')));
});

test('flaky tests are NOT counted as failures — they are a separate section', () => {
  const s = failureSet(RUN_A);
  assert.ok(![...s].some((t) => t.includes('agent-search')), 'a flaky test leaked into the failure set');
});

test('a non-empty diff reports which side each test came from', () => {
  const d = diffFailureSets(RUN_A, RUN_B);

  assert.equal(d.both.length, 2);
  assert.equal(d.onlyA.length, 1);
  assert.equal(d.onlyB.length, 1);
  assert.equal(d.empty, false);
  assert.ok(d.onlyA[0].includes('filter Type = Concert'));
  assert.ok(d.onlyB[0].includes('responsive'));
});

test('two runs failing identically produce an EMPTY diff — the SC-004 pass condition', () => {
  const d = diffFailureSets(RUN_A, RUN_A);
  assert.equal(d.empty, true);
  assert.equal(d.onlyA.length, 0);
  assert.equal(d.onlyB.length, 0);
  assert.equal(d.both.length, 3);
});

test('equal failure COUNTS with different failures still diff non-empty', () => {
  // Both runs report "3 failed". Judging by count alone would call this stable; it is not. This is
  // why SC-004 is stated as a set diff rather than as a matching total.
  assert.equal(runCounts(RUN_A).failed, runCounts(RUN_B).failed);
  assert.equal(diffFailureSets(RUN_A, RUN_B).empty, false);
});

test('a truncated log is reported, not silently under-counted', () => {
  // If the header says 33 but only 5 identities survived truncation, a diff built from it is
  // incomplete — and would look like a SMALLER, more stable failure set. Surface the mismatch.
  const truncated = `
  33 failed
    [chromium] › tests/e2e/web/movies.spec.ts:897:9 › a › b
    [chromium] › tests/e2e/web/movies.spec.ts:898:9 › a › c
  126 passed (17.9m)
`;
  const c = runCounts(truncated);
  assert.equal(c.failed, 33, 'the count must come from the header');
  assert.equal(c.failedListed, 2, 'and the listed identities must be counted separately');
  assert.notEqual(c.failed, c.failedListed, 'the mismatch is what tells a caller the log is partial');
});

test('an empty or unparseable log yields zero counts rather than throwing', () => {
  assert.deepEqual(parsePlaywrightSummary(''), {});
  assert.equal(runCounts('no summary here at all').failed, 0);
  assert.equal(failureSet('').size, 0);
});
