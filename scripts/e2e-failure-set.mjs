#!/usr/bin/env node
// Feature 052 US4 (SC-002, SC-004) — extract and diff a Playwright run's FAILURE SET by test identity.
//
// WHY BY IDENTITY, NOT BY COUNT: `app-e2e` on one unchanged commit produced 33 failures in one run and
// 61 in the next. Two runs that both report "33 failed" can still be failing on different tests, and a
// remedy that merely moves the variance around would look like progress. SC-004 therefore requires the
// failure-set DIFF to be empty, which needs identities, not totals.
//
// This script is the instrument SC-004 is judged with, so it is itself tested
// (scripts/__tests__/e2e-failure-set.test.mjs) and validated against two runs whose numbers are
// independently stated in docs/proposals/PRD-E2EWorkerSessionContention.md §1.1.
//
// Input is the `dot`-reporter tail that Playwright prints, as captured in `logs/step:web-e2e` inside a
// CI failure bundle:
//
//     33 failed
//       [chromium] › tests/e2e/web/movies.spec.ts:1004:7 › movie sort (013 US1) › opens in default …
//       …
//     15 flaky
//       …
//     3 did not run
//     126 passed (17.9m)
//
// Usage:
//   node scripts/e2e-failure-set.mjs summary <web-e2e.log>
//   node scripts/e2e-failure-set.mjs diff <run-a.log> <run-b.log>
//
// Exit status is NOT the verdict — print and read the counts (this whole feature exists because a
// green tick was trusted over a count). Always exits 0 unless its arguments are unusable.

import { readFileSync } from 'node:fs';

/** Section headers Playwright prints in its summary, e.g. "  33 failed" / "  126 passed (17.9m)". */
const SECTION_RE = /^\s*(\d+)\s+(failed|flaky|passed|did not run|interrupted|skipped)\b/;

/** A test line, e.g. "    [chromium] › tests/e2e/web/movies.spec.ts:1004:7 › movie sort › opens …". */
const TEST_RE = /^\s*\[([^\]]+)\]\s+›\s+(.+?)\s*$/;

/**
 * Parse a Playwright summary into per-section counts and the test identities listed under each.
 *
 * The reported COUNT is taken from the section header, not from how many identity lines follow: a
 * truncated log would otherwise silently report fewer failures than the run actually had, which is
 * the precise class of quiet under-reporting this feature exists to remove. `listed` vs `count` is
 * surfaced so a caller can tell the two apart.
 */
export function parsePlaywrightSummary(text) {
  const sections = {};
  let current = null;

  for (const line of text.split(/\r?\n/)) {
    const header = SECTION_RE.exec(line);
    if (header) {
      current = header[2];
      sections[current] ??= { count: 0, tests: [] };
      sections[current].count = Number(header[1]);
      continue;
    }
    if (!current) continue;

    const test = TEST_RE.exec(line);
    if (test) {
      sections[current].tests.push(normalizeIdentity(test[2]));
    } else if (line.trim() !== '') {
      // A non-empty, non-test line ends the section (e.g. the trailing "Force exiting Jest" noise).
      current = null;
    }
  }
  return sections;
}

/**
 * Test identity: `file:line:col › title`, whitespace-collapsed.
 *
 * Line/column are KEPT. Two runs of the same commit have identical line numbers, so keeping them
 * distinguishes the parameterised cases that share a title (movies.spec.ts:897 appears five times
 * under one describe, differing only in the filter). Dropping them would silently merge distinct
 * failures and shrink the diff — making a still-varying failure set look empty.
 */
export function normalizeIdentity(raw) {
  return raw.replace(/\s+/g, ' ').trim();
}

/** The failure set of a run, as a Set of identities. */
export function failureSet(text) {
  const s = parsePlaywrightSummary(text);
  return new Set(s.failed?.tests ?? []);
}

/** Counts a run should be judged by — never its exit status. */
export function runCounts(text) {
  const s = parsePlaywrightSummary(text);
  const get = (k) => s[k]?.count ?? 0;
  return {
    failed: get('failed'),
    flaky: get('flaky'),
    passed: get('passed'),
    didNotRun: get('did not run'),
    skipped: get('skipped'),
    failedListed: s.failed?.tests.length ?? 0,
  };
}

/** Symmetric difference of two runs' failure sets. Empty `onlyA`+`onlyB` is what SC-004 requires. */
export function diffFailureSets(textA, textB) {
  const a = failureSet(textA);
  const b = failureSet(textB);
  const both = [...a].filter((t) => b.has(t));
  const onlyA = [...a].filter((t) => !b.has(t));
  const onlyB = [...b].filter((t) => !a.has(t));
  return { both, onlyA, onlyB, empty: onlyA.length === 0 && onlyB.length === 0 };
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────

function main(argv) {
  const [mode, ...files] = argv;

  if (mode === 'summary' && files.length === 1) {
    const text = readFileSync(files[0], 'utf8');
    const c = runCounts(text);
    console.log(
      `failed=${c.failed} flaky=${c.flaky} passed=${c.passed} did-not-run=${c.didNotRun} skipped=${c.skipped}`,
    );
    if (c.failedListed !== c.failed) {
      console.log(
        `  note: header says ${c.failed} failed but ${c.failedListed} identities are listed — ` +
          'the log is truncated, so a diff built from it would be incomplete.',
      );
    }
    return 0;
  }

  if (mode === 'diff' && files.length === 2) {
    const [a, b] = files.map((f) => readFileSync(f, 'utf8'));
    const d = diffFailureSets(a, b);
    console.log(`both=${d.both.length} onlyA=${d.onlyA.length} onlyB=${d.onlyB.length}`);
    console.log(d.empty ? 'DIFF EMPTY — SC-004 satisfied' : 'DIFF NON-EMPTY — contention reduced, not removed');
    for (const t of d.onlyA) console.log(`  only in A: ${t}`);
    for (const t of d.onlyB) console.log(`  only in B: ${t}`);
    return 0;
  }

  console.error('usage: e2e-failure-set.mjs summary <log> | diff <log-a> <log-b>');
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
