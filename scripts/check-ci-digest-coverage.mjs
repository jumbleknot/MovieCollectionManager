#!/usr/bin/env node
// CI failure-digest coverage gate (feature 042 durability).
//
// Why this exists: the self-serve diagnostics feature (042) works only because EVERY job publishes a
// failure digest — one `if: always()` step, copy-pasted across 16 jobs in 6 workflows. Nothing stops
// job #17 (or a whole new workflow) being added WITHOUT it, and when that happens the omission is
// invisible: the job just silently produces no digest, and its failures go back to needing a human to
// paste the log. That is exactly the decay a diagnostics tool must not suffer. This gate makes digest
// coverage a REQUIRED, self-enforcing property — a new job without one turns CI red with a clear
// message instead of quietly eroding the feature.
//
// Rule (per job in every .forgejo/workflows/*.yml):
//   - The job MUST contain a step that runs `scripts/ci-failure-digest.mjs`.
//   - That step MUST be guarded `if: always()` + `continue-on-error: true` — a digest step that can
//     change the job's outcome is worse than none (FR-009).
//   - A job may opt out ONLY with a visible, justified marker on the job:
//       `# ci-digest-exempt: <reason>`
//     mirroring the conftest _LEGITIMATE_SKIPS pattern — silence is allowed only where a human wrote
//     down why. A blank reason is rejected.
//
// Usage:
//   node scripts/check-ci-digest-coverage.mjs            # scan; exit 0 clean / 1 gap
//   node scripts/check-ci-digest-coverage.mjs --selftest # prove detection; exit 0/1
//   node scripts/check-ci-digest-coverage.mjs --dir <d>  # scan a different workflows dir (tests)
//
// Exit codes: 0 clean / selftest passed · 1 uncovered job / selftest broken · 2 bad args / unparseable.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { parse } from 'yaml';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DIR = resolve(REPO_ROOT, '.forgejo/workflows');
const DIGEST_SCRIPT = /ci-failure-digest\.mjs/;

const isAlways = (v) => v === 'always()' || (typeof v === 'string' && /\balways\(\)/.test(v));

/**
 * Find the exemption reasons declared per job. Comments are stripped by the YAML parser, so the raw
 * text is scanned: a `# ci-digest-exempt: <reason>` line associates with the nearest job header above
 * or below it within the job block. Returns a Map<jobName, reason|''>.
 */
export function parseExemptions(text) {
  const lines = text.split('\n');
  const out = new Map();
  const jobHeader = /^ {2}([A-Za-z0-9_-]+):\s*$/;
  let current = null;
  for (const line of lines) {
    const h = line.match(jobHeader);
    if (h) current = h[1];
    const m = line.match(/#\s*ci-digest-exempt:(.*)$/);
    if (m && current) out.set(current, m[1].trim());
  }
  return out;
}

/** @returns {{job: string, problem: string}[]} one entry per uncovered job. */
export function findCoverageGaps(text) {
  const doc = parse(text);
  const exemptions = parseExemptions(text);
  const gaps = [];

  for (const [name, job] of Object.entries(doc?.jobs ?? {})) {
    if (exemptions.has(name)) {
      if (!exemptions.get(name)) gaps.push({ job: name, problem: 'ci-digest-exempt marker has no reason — state why this job opts out' });
      continue;
    }
    const steps = Array.isArray(job?.steps) ? job.steps : [];
    const digestSteps = steps.filter((s) => DIGEST_SCRIPT.test(String(s?.run ?? '')));
    if (digestSteps.length === 0) {
      gaps.push({ job: name, problem: 'no failure-digest step (add one, or a justified `# ci-digest-exempt:` marker)' });
      continue;
    }
    const guarded = digestSteps.some((s) => isAlways(s.if) && s['continue-on-error'] === true);
    if (!guarded) {
      gaps.push({ job: name, problem: 'digest step is missing `if: always()` + `continue-on-error: true` (it could mask the job outcome — FR-009)' });
    }
  }
  return gaps;
}

function runScan(dir) {
  if (!existsSync(dir)) {
    console.error(`✗ workflows dir not found: ${dir}`);
    process.exit(2);
  }
  const files = readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  const findings = [];
  for (const f of files) {
    let text;
    try {
      text = readFileSync(join(dir, f), 'utf8');
      for (const g of findCoverageGaps(text)) findings.push({ file: f, ...g });
    } catch (e) {
      console.error(`✗ could not parse ${f}: ${e.message}`);
      process.exit(2);
    }
  }
  if (findings.length) {
    console.error(`✗ ci-digest coverage gate FAILED: ${findings.length} job(s) not covered:`);
    for (const { file, job, problem } of findings) console.error(`  ${file.replace(/\.ya?ml$/, '')} / ${job} — ${problem}`);
    console.error('\nEvery CI job must publish a failure digest so a failure is diagnosable without a human pasting logs (feature 042).');
    process.exit(1);
  }
  console.log(`✓ ci-digest coverage gate passed (every job in ${files.length} workflow(s) publishes a guarded failure digest)`);
}

function selftest() {
  const fails = [];
  const check = (text, wantGaps, label) => {
    const n = findCoverageGaps(text).length;
    if ((n > 0) !== (wantGaps > 0)) fails.push(`${label}: expected ${wantGaps ? 'gap(s)' : 'clean'}, got ${n}`);
  };
  const guarded = `      - name: Publish failure digest\n        if: always()\n        continue-on-error: true\n        run: node scripts/ci-failure-digest.mjs`;
  const base = (steps) => `jobs:\n  build:\n    steps:\n${steps}\n`;

  check(base(`      - run: echo work\n${guarded}`), 0, 'guarded digest step is clean');
  check(base(`      - run: echo work`), 1, 'missing digest step is caught');
  check(base(`      - run: echo work\n      - run: node scripts/ci-failure-digest.mjs`), 1, 'unguarded digest step is caught');
  check(`jobs:\n  probe:\n    # ci-digest-exempt: trigger-only\n    steps:\n      - run: echo x\n`, 0, 'justified exemption is honoured');
  check(`jobs:\n  probe:\n    # ci-digest-exempt:\n    steps:\n      - run: echo x\n`, 1, 'blank exemption reason is caught');

  if (fails.length) {
    console.error('✗ ci-digest coverage gate --selftest FAILED:\n  ' + fails.join('\n  '));
    process.exit(1);
  }
  console.log('✓ ci-digest coverage gate --selftest passed (catches missing/unguarded steps; honours justified exemptions)');
}

const args = process.argv.slice(2);
const dirIdx = args.indexOf('--dir');
const dir = dirIdx >= 0 ? args[dirIdx + 1] : DEFAULT_DIR;
const unknown = args.filter((a, i) => a !== '--selftest' && a !== '--dir' && !(dirIdx >= 0 && i === dirIdx + 1));
if (unknown.length) {
  console.error(`Unknown argument(s): ${unknown.join(', ')}. Usage: check-ci-digest-coverage.mjs [--selftest] [--dir <path>]`);
  process.exit(2);
}
if (args.includes('--selftest')) selftest();
else runScan(dir);
