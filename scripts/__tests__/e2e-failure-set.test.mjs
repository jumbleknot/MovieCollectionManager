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
  gateCounts,
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
  // Exhaustive on purpose: a new key must be added HERE too, so the shape cannot drift unnoticed.
  // Extended (not relaxed) when item #568 made the identities part of the result — the counts it
  // already pinned are unchanged.
  assert.deepEqual(c, {
    failed: 3, flaky: 2, passed: 171, didNotRun: 1, skipped: 0, failedListed: 3,
    // The identity drops the `[chromium] ›` project prefix and keeps `file:line:col › title`.
    flakyTests: [
      'tests/e2e/web/agent-search.spec.ts:20:7 › Assistant search › finds a movie',
      'tests/e2e/web/perf.spec.ts:50:7 › bundle + cold TTI › measure transferred JS',
    ],
    skippedTests: [],
    didNotRunTests: [],
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

// ── `gate` — the assertion that makes a GREEN app-e2e mean something ─────────────────────────────
//
// A passing run's counts are unreadable from outside CI (no job-log API, and the failure digest
// only publishes on failure), so this judgement has to live in the job itself. These pin the three
// ways it could go wrong, each of which reads as success if the gate is careless.

test('gate passes a genuinely clean run', () => {
  const clean = `
Running 177 tests using 6 workers
  177 passed (12.0m)
`;
  const g = gateCounts(clean);
  assert.equal(g.ok, true, g.reasons.join('; '));
  assert.equal(g.counts.passed, 177);
});

test('gate FAILS on a skip — the false green this repository keeps paying for', () => {
  // Feature 040 validated green with 33 specs skipped; five stale agent specs then went unnoticed
  // for three weeks (item #150). Playwright exits 0 here, so only an explicit check catches it.
  const skipped = `
Running 177 tests using 6 workers
  144 passed (10.0m)
  33 skipped
`;
  const g = gateCounts(skipped);
  assert.equal(g.ok, false);
  assert.match(g.reasons.join(' '), /SKIPPED/);
});

test('gate FAILS on "did not run" — a dependent project that never executed', () => {
  const dnr = `
Running 177 tests using 6 workers
  3 did not run
  174 passed (11.0m)
`;
  const g = gateCounts(dnr);
  assert.equal(g.ok, false);
  assert.match(g.reasons.join(' '), /DID NOT RUN/);
});

test('gate FAILS on a log with no summary — "no counts" is not "good counts"', () => {
  // An empty or truncated capture is indistinguishable from a clean run to a grep for "failed".
  for (const text of ['', 'Running 177 tests using 6 workers\n', 'docker: connection refused']) {
    const g = gateCounts(text);
    assert.equal(g.ok, false, `expected a missing summary to fail the gate: ${JSON.stringify(text)}`);
    assert.match(g.reasons.join(' '), /no Playwright summary/);
  }
});

test('gate does NOT double-report a failure the web-e2e step already raised', () => {
  // failed>0 already failed that step; failing again here would just obscure which step found it.
  const failed = `
Running 177 tests using 6 workers
  3 failed
    [chromium] › tests/e2e/web/movies.spec.ts:1:1 › a › b
  174 passed (11.0m)
`;
  const g = gateCounts(failed);
  assert.equal(g.ok, true, 'failed>0 alone must not trip the gate');
  assert.equal(g.counts.failed, 3);
});


// ── Naming what was counted (item #568 follow-up) ────────────────────────────────────────────────
//
// The counts alone were not enough, measured on run 4033: a GREEN `app-e2e` reported
// `failed=0 flaky=1 passed=180`, and which test had needed its retry was **unrecoverable**. Counts
// mode publishes only the three tally step logs, the bundle's own manifest records "playwright
// report — not present", and this forge build 404s `/actions/runs/{id}/jobs` — so the dot-reporter
// output survived nowhere a session could reach. The identities were parsed all along and thrown
// away one function later.
//
// This is the same shape as the defect this script was written for, one level up: that one trusted a
// green tick over a count, this one trusted a count over an identity.

/** Header says 3 flaky but lists one — the truncation case, which must not read as "1 flaky". */
const FLAKY_TRUNCATED = `
  3 flaky
    [chromium] › tests/e2e/web/assistant-add.spec.ts:90:7 › Assistant add flow › approve creates the collection
  170 passed (22.0m)
`;

const WITH_SKIPS = `
  2 skipped
    [chromium] › tests/e2e/web/assistant-add-ambiguous.spec.ts:84:7 › Assistant ambiguous add flow › ordinal pick
    [chromium] › tests/e2e/web/assistant-import.spec.ts:30:7 › Assistant import › applies a workbook
  171 passed (18.2m)
`;

test('the FLAKY tests are NAMED — on a green run this is their only record', () => {
  const { counts: c, notes } = gateCounts(RUN_A);
  assert.equal(c.flaky, 2);
  const text = notes.join('\n');
  assert.ok(text.includes('agent-search.spec.ts:20:7'), `flaky identity missing from notes:\n${text}`);
  assert.ok(text.includes('perf.spec.ts:50:7'), `flaky identity missing from notes:\n${text}`);
  // Naming them must not change the verdict. Asserted on a FLAKY-ONLY run: RUN_A also carries
  // `1 did not run`, so its verdict is legitimately false and would prove nothing about flaky here.
  const flakyOnly = `
  2 flaky
    [chromium] › tests/e2e/web/assistant-add.spec.ts:90:7 › Assistant add flow › approve creates the collection
    [chromium] › tests/e2e/web/perf.spec.ts:50:7 › bundle + cold TTI › measure transferred JS
  179 passed (35.1m)
`;
  assert.equal(gateCounts(flakyOnly).ok, true, 'a flaky test passed on retry — it must not fail the gate');
  assert.equal(gateCounts(flakyOnly).notes.length, 3, 'one label line + two identities');
});

test('a flaky list SHORTER than its header says so — a truncated log must not under-report', () => {
  const { counts: c, notes } = gateCounts(FLAKY_TRUNCATED);
  assert.equal(c.flaky, 3);
  assert.equal(c.flakyTests.length, 1);
  const text = notes.join('\n');
  assert.ok(text.includes('assistant-add.spec.ts:90:7'), 'the one known identity should still be named');
  assert.match(text, /truncated|incomplete/i, `no truncation warning in:\n${text}`);
});

test('SKIPPED tests are named as well — knowing WHICH gate stopped forwarding is the actionable part', () => {
  const { counts: c, notes, ok } = gateCounts(WITH_SKIPS);
  assert.equal(c.skipped, 2);
  assert.equal(ok, false, 'a skip must still FAIL the gate');
  const text = notes.join('\n');
  assert.ok(text.includes('assistant-add-ambiguous.spec.ts:84:7'), `skipped identity missing:\n${text}`);
  assert.ok(text.includes('assistant-import.spec.ts:30:7'), `skipped identity missing:\n${text}`);
});

test('a "did not run" count with no identities listed is reported as incomplete, not as zero', () => {
  // RUN_A carries `1 did not run` with NO identity lines under it — the shape every measured run had.
  const { counts: c, notes } = gateCounts(RUN_A);
  assert.equal(c.didNotRun, 1);
  assert.equal(c.didNotRunTests.length, 0);
  assert.match(notes.join('\n'), /truncated|incomplete/i);
});

test('a genuinely clean run produces NO notes — nothing to name, nothing printed', () => {
  const clean = `
  181 passed (34.2m)
`;
  const { notes, ok } = gateCounts(clean);
  assert.equal(ok, true);
  assert.deepEqual(notes, [], `a clean run should print nothing extra, got:\n${notes.join('\n')}`);
});
