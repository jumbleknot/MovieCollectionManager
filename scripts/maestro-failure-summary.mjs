#!/usr/bin/env node
// What a failed full-suite Maestro flow was LOOKING AT — printed by app-ci's `maestro-full-results`
// step, which is published on a green run as well as a red one (item #985).
//
// THE GAP THIS CLOSES. scripts/ci-mobile-full-flows.sh captures device diagnostics for every failed
// attempt, non-blocking ones included, but only the job's `failure()` steps publish them. A
// CI_FULL_NON_BLOCKING flow cannot fail the job, so on a green run its capture was thrown away and
// the results table said FAIL-NONBLOCKING and nothing else — identical whether the flow failed for
// its documented reason or because of a new app regression. `login-invalid` sat there for five full
// runs with an exemption nobody could re-verify; when a red run finally carried its capture, the
// screen contradicted the exemption's stated cause.
//
// WHAT IT PRINTS, per attempt of each flow that did not pass: the failing step's name, Maestro's
// failure message, and the elements on screen at that step (ids and visible text). That is small
// enough for the counts bundle and specific enough to compare against an entry's stated cause.
//
// WHAT IT NEVER PRINTS: the value of an editable field. The login flows type the test account's
// username into Keycloak's form, and a hierarchy captured mid-login carries it. An EditText is
// reported as `[input, filled]`, never with its text.
//
// Read-only, and it never fails the step: a missing or malformed capture is reported as such.
//
//   node scripts/maestro-failure-summary.mjs [mobile-diagnostics-dir]   (default: mobile-diagnostics)

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ArgvError, partitionArgs, wantsHelp } from './lib/argv-contract.mjs';
import { isMain } from './lib/is-main.mjs';

const USAGE = 'usage: node scripts/maestro-failure-summary.mjs [mobile-diagnostics-dir]';
export const RESULTS_FILE = 'full-suite-results.log';
/** Elements listed per screen. A Keycloak form is ~20; a collection screen can be hundreds. */
export const MAX_SCREEN_LINES = 40;

/** Rows of the results table whose result is a failure (FAIL, FAIL-NONBLOCKING). */
export function failedFlows(table) {
  return String(table)
    .split('\n')
    .slice(1)
    .map((line) => line.split('\t'))
    .filter((cols) => cols.length >= 3 && /^FAIL/.test(cols[1]))
    .map(([flow, result, attempts]) => ({ flow, result, attempts: Number(attempts) || 1 }));
}

/** Maestro's message for the command that failed: the last `CommandFailed:` in its log. */
export function failureMessage(log) {
  const hits = String(log).match(/CommandFailed: .*/g);
  return hits ? hits.at(-1).replace(/^CommandFailed: /, '').trim() : null;
}

const area = (bounds) => {
  const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(bounds ?? '');
  return m ? (Number(m[3]) - Number(m[1])) * (Number(m[4]) - Number(m[2])) : 0;
};

/** One line per visible, identifiable element; system UI dropped; typed values withheld. */
export function screenLines(hierarchy, max = MAX_SCREEN_LINES) {
  const lines = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    const a = n.attributes ?? {};
    const id = a['resource-id'] ?? '';
    const label = a.text || a.accessibilityText || a.hintText || '';
    // Status-bar notification icons carry no id, only a "<app> notification: …" description.
    const systemChrome = id.startsWith('com.android.systemui') || (!id && / notification: /.test(label));
    if (!systemChrome && area(a.bounds) > 0) {
      if (/EditText/.test(a.class ?? '')) {
        const flags = ['input', a.text ? 'filled' : 'empty', a.focused === 'true' ? 'focused' : null].filter(Boolean);
        lines.push(`${id || '(no id)'} [${flags.join(', ')}]`);
      } else if (id || label) {
        lines.push(label ? `${id || '(no id)'} "${label}"` : id);
      }
    }
    for (const c of n.children ?? []) walk(c);
  };
  walk(hierarchy);
  const unique = [...new Set(lines)];
  if (unique.length <= max) return unique;
  return [...unique.slice(0, max), `… ${unique.length - max} more element(s) not listed`];
}

const listDir = (p) => {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
};

/** Every file under `dir` whose path matches `re`, depth-bounded (the capture is a few levels deep). */
function findFiles(dir, re, depth = 5) {
  if (depth < 0) return [];
  const out = [];
  for (const name of listDir(dir).sort()) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...findFiles(p, re, depth - 1));
    else if (re.test(p)) out.push(p);
  }
  return out;
}

const stepNumber = (p) => Number(/step-(\d+)/.exec(p)?.[1] ?? -1);

/** The summary for one flow: one block per attempt the table says it made. */
export function summarizeFlow(diagDir, { flow, result, attempts }) {
  const blocks = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const head = `${flow} — ${result} — attempt ${attempt}`;
    const dir = join(diagDir, `${flow}-attempt${attempt}`);
    if (!existsSync(dir)) {
      blocks.push(`${head}: no device capture in ${dir}`);
      continue;
    }
    const logs = findFiles(dir, /maestro\.log$/);
    let message = null;
    for (const l of logs) message = failureMessage(readFileSync(l, 'utf8')) ?? message;
    // The failing step is the LAST hierarchy Maestro wrote — it captures one on a failed assertion.
    const hierarchies = findFiles(dir, /screen-hierarchy\/.*\.json$/).sort((a, b) => stepNumber(a) - stepNumber(b));
    const last = hierarchies.at(-1);
    const out = [head, `  failed: ${message ?? '(no CommandFailed line in the Maestro log)'}`];
    if (!last) {
      out.push('  screen: (no hierarchy captured)');
    } else {
      out.push(`  step:   ${last.split('/').pop().replace(/\.json$/, '')}`);
      try {
        const lines = screenLines(JSON.parse(readFileSync(last, 'utf8')));
        out.push('  on screen:', ...(lines.length ? lines : ['(nothing identifiable)']).map((l) => `    ${l}`));
      } catch (err) {
        out.push(`  screen: hierarchy unreadable (${err.message})`);
      }
    }
    blocks.push(out.join('\n'));
  }
  return blocks.join('\n');
}

/** Every failed flow in the results table, or '' when nothing failed. */
export function summarizeAll(diagDir) {
  const table = readFileSync(join(diagDir, RESULTS_FILE), 'utf8');
  return failedFlows(table).map((row) => summarizeFlow(diagDir, row)).join('\n\n');
}

function main(argv) {
  if (wantsHelp(argv)) {
    console.log(USAGE);
    return;
  }
  const { positionals } = partitionArgs(argv, { accepted: [], maxPositionals: 1, usage: USAGE });
  const dir = positionals[0] ?? 'mobile-diagnostics';
  if (!existsSync(join(dir, RESULTS_FILE))) {
    console.log(`no full-suite results in ${dir} — nothing to summarize`);
    return;
  }
  const text = summarizeAll(dir);
  console.log(text ? `=== what each failed flow was looking at ===\n${text}` : 'every flow passed — nothing to summarize');
}

if (isMain(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    if (err instanceof ArgvError) {
      console.error(err.message);
      process.exit(2);
    }
    // Never fail the results step over a diagnostic: say what broke and exit 0.
    console.log(`maestro-failure-summary: could not summarize (${err.message})`);
  }
}
