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
//   node scripts/e2e-failure-set.mjs gate <web-e2e.log>     # CI: exit 1 if anything was hidden
//
// Exit status is NOT the verdict for `summary`/`diff` — print and read the counts (this whole
// feature exists because a green tick was trusted over a count). Both always exit 0 unless their
// arguments are unusable.
//
// `gate` is the deliberate exception, and the reason it exists is that a PASSING run's counts are
// otherwise unreadable: the forge API exposes no job logs, and the failure digest only publishes on
// failure. So on a green run there is nowhere to read `skipped=` from, and a skip reads as a pass.
// `gate` moves that judgement into CI, where it cannot be skipped by whoever is not looking.

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

  if (mode === 'gate' && files.length === 1) {
    return gate(files[0]);
  }

  console.error('usage: e2e-failure-set.mjs summary <log> | diff <log-a> <log-b> | gate <log>');
  return 2;
}

/**
 * Make a GREEN `app-e2e` mean what it looks like it means.
 *
 * Playwright exits 0 with tests skipped, and the forge API exposes no job logs, so on a passing run
 * nobody can read the counts at all — the failure digest only publishes on failure. That combination
 * is the exact false green this repository keeps paying for: feature 040's final validation reported
 * success with 33 specs skipped, and five stale agent specs then went unnoticed for three weeks
 * (item #150). 051's SC-001 says no agent spec may be re-hidden; this is what enforces it, in the
 * one place that cannot be forgotten.
 *
 * Fails the step — and therefore publishes the digest, which is how the counts become readable — on:
 *   * `skipped > 0`  — a skip reads as a pass. In this job every gate is env-driven, so a skip means
 *     a variable stopped being forwarded, not that a test became irrelevant.
 *   * `did not run > 0` — the `lifecycle` project depends on `chromium`, so these are tests that
 *     never executed. They were reported as `3 did not run` in every measured run for months.
 *   * a MISSING summary — an empty or truncated log is indistinguishable from a clean run to a
 *     grep, and "no counts" must never be treated as "good counts".
 *
 * It deliberately does NOT fail on `failed > 0`: the web-e2e step already did that, and a second
 * failure here would just obscure which step found it.
 */
export function gateCounts(text) {
  const c = runCounts(text);
  const total = c.failed + c.flaky + c.passed + c.didNotRun + c.skipped;
  const reasons = [];
  if (total === 0) {
    reasons.push(
      'no Playwright summary found in the log — the run produced no counts, which is not the same ' +
        'as producing good ones (empty log? step never ran? output not captured?)',
    );
  }
  if (c.skipped > 0) {
    reasons.push(
      `${c.skipped} test(s) SKIPPED — a skip reads as a pass. Every skip gate in this job is ` +
        'env-driven (E2E_AGENT_PRODUCTION, TMDB_API_KEY, ANTHROPIC_API_KEY, ' +
        'KEYCLOAK_SERVICE_CLIENT_SECRET), so this means a variable stopped reaching the ' +
        'Playwright container — see specs/051-ci-diagnostics-closure/contracts/e2e-env-forwarding.md',
    );
  }
  if (c.didNotRun > 0) {
    reasons.push(
      `${c.didNotRun} test(s) DID NOT RUN — the \`lifecycle\` project declares ` +
        "dependencies: ['chromium'], so these never executed at all.",
    );
  }
  return { counts: c, ok: reasons.length === 0, reasons };
}

function gate(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`[e2e-gate] cannot read ${file}: ${err.message}`);
    console.error('[e2e-gate] treating an unreadable log as a FAILURE — silence is not a pass.');
    return 1;
  }
  const { counts: c, ok, reasons } = gateCounts(text);
  console.log(
    `[e2e-gate] failed=${c.failed} flaky=${c.flaky} passed=${c.passed} ` +
      `did-not-run=${c.didNotRun} skipped=${c.skipped}`,
  );
  if (ok) {
    console.log('[e2e-gate] OK — nothing hidden: no skips, nothing left unrun.');
    return 0;
  }
  for (const r of reasons) console.error(`[e2e-gate] FAIL: ${r}`);
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
