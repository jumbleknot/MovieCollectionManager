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
//   - The digest step MUST wire `CI_DIGEST_JOB_STATUS: ${{ job.status }}` — the publish decision keys on it.
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
const LOG_STEP_SCRIPT = /ci-log-step\.sh/;

const isAlways = (v) => v === 'always()' || (typeof v === 'string' && /\balways\(\)/.test(v));

/**
 * Find the exemption reasons declared per job. Comments are stripped by the YAML parser, so the raw
 * text is scanned: a `# ci-digest-exempt: <reason>` line associates with the nearest job header above
 * or below it within the job block. Returns a Map<jobName, reason|''>.
 *
 * Splitting on /\r?\n/ rather than '\n' is load-bearing, not tidiness. With '\n', a CRLF checkout
 * leaves a trailing '\r' on every line and `markerRe` below cannot match: '.' will not consume '\r'
 * (it is a line terminator in JS regexes) and a non-multiline '$' demands end-of-input. `jobHeader`
 * survives the same input because its `\s*` absorbs the '\r' — so the parser saw the jobs but not
 * their exemptions, and reported three correctly-exempt jobs as uncovered. That was PRD §1.3, whose
 * author was on Windows while the agent measured on Linux and pronounced it resolved.
 *
 * Fix it HERE, at the split. Adding the `m` flag to `markerRe`, or appending `\r?` to it, would make
 * this one pattern work and leave the next pattern added to this file to inherit the trap.
 * `.gitattributes` also declares eol=lf for *.yml — that stops the condition being produced, but it
 * governs future checkouts only, so it cannot be the sole layer.
 */
export function parseExemptions(text, marker = 'ci-digest-exempt') {
  const lines = text.split(/\r?\n/);
  const out = new Map();
  const jobHeader = /^ {2}([A-Za-z0-9_-]+):\s*$/;
  const stepsHeader = /^ {4}steps:\s*$/;
  const markerRe = new RegExp(`#\\s*${marker}:(.*)$`);
  let current = null;
  let inSteps = false;
  for (const line of lines) {
    const h = line.match(jobHeader);
    if (h) { current = h[1]; inSteps = false; }
    if (stepsHeader.test(line)) inSteps = true;
    // A JOB-level marker is one written above the job's `steps:` — which is where all three of the
    // real ones live. Markers inside the steps block are STEP-level and belong to parseJobSteps;
    // treating them as job-level (the old behaviour) would let one step's exemption silently cover
    // every later step in the job, rebuilding the exact "one compliant thing stands in for many"
    // defect this feature removes.
    if (inSteps) continue;
    const m = line.match(markerRe);
    if (m && current) out.set(current, m[1].trim());
  }
  return out;
}

/**
 * Per-job, per-step view: each `run:` step paired with its own step-level exemption marker, if any.
 *
 * Steps come from the YAML parse (ordered, and it already knows what a step is); markers come from a
 * line scan, because the parser strips comments. The two are zipped by ORDER, and the zip is
 * abandoned if the counts disagree — a silently mis-associated marker would attach an exemption to
 * the wrong step, which is worse than reporting nothing.
 *
 * @returns Map<jobName, Array<{name, run, exempt: boolean, reason: string|null}>>
 */
export function parseJobSteps(text, doc) {
  const lines = text.split(/\r?\n/);
  const jobHeader = /^ {2}([A-Za-z0-9_-]+):\s*$/;
  const stepsHeader = /^ {4}steps:\s*$/;
  const markerRe = /#\s*ci-log-step-exempt:(.*)$/;

  /** @type {Map<string, Array<string|null>>} per job, one entry per step start, in order */
  const markersByJob = new Map();
  let job = null;
  let inSteps = false;
  let stepIndent = null;
  let pending = null;
  let started = 0;

  for (const line of lines) {
    const h = line.match(jobHeader);
    if (h) { job = h[1]; inSteps = false; stepIndent = null; pending = null; started = 0; markersByJob.set(job, []); continue; }
    if (!job) continue;
    if (stepsHeader.test(line)) { inSteps = true; continue; }
    if (!inSteps) continue;

    const indent = line.search(/\S/);
    if (indent === -1) continue;
    // Dedent out of the steps block (e.g. the next top-level job key).
    if (indent <= 2) { inSteps = false; continue; }

    const isStepStart = /^\s*-\s/.test(line) && (stepIndent === null || indent === stepIndent);
    if (isStepStart) {
      if (stepIndent === null) stepIndent = indent;
      markersByJob.get(job)[started] = pending;
      pending = null;
      started += 1;
      continue;
    }

    const m = line.match(markerRe);
    if (!m) continue;
    const reason = m[1].trim();
    if (started > 0 && stepIndent !== null && indent > stepIndent) {
      // Written INSIDE the step body — belongs to the step already open.
      markersByJob.get(job)[started - 1] = reason;
    } else {
      // Written above a step — belongs to the step about to start.
      pending = reason;
    }
  }

  const out = new Map();
  for (const [name, jobDef] of Object.entries(doc?.jobs ?? {})) {
    const steps = Array.isArray(jobDef?.steps) ? jobDef.steps : [];
    const markers = markersByJob.get(name) ?? [];
    // If the line scan and the YAML parse disagree about how many steps exist, do not guess which
    // marker belongs to which step. Report no step-level exemptions rather than a wrong one.
    const aligned = markers.length === steps.length;
    out.set(
      name,
      steps.map((s, i) => ({
        name: typeof s?.name === 'string' ? s.name : null,
        run: typeof s?.run === 'string' ? s.run : null,
        exempt: aligned ? markers[i] != null : false,
        reason: aligned ? (markers[i] ?? null) : null,
      })),
    );
  }
  return out;
}

/**
 * Shell scaffolding that cannot carry diagnostic output of its own: control keywords and block
 * terminators, `set -o` lines, and pure variable assignments. Everything else in a `run:` block is
 * treated as a COMMAND that can fail the step, and therefore has to be inside the wrapper.
 *
 * Deliberately conservative in the direction of flagging: `echo` is NOT scaffolding here, because
 * the existing rule "a job whose only step is `- run: echo work` publishes an empty digest" is one
 * this gate already enforces and must keep enforcing.
 */
const SHELL_KEYWORD = /^(if|then|elif|else|fi|for|while|until|do|done|case|esac|function)\b|^[;)}{&|]/;
const SHELL_ASSIGNMENT = /^(export|local|declare|readonly|typeset)\s+[A-Za-z_]|^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const SHELL_SETOPT = /^set\s+[-+]/;

/**
 * Split a `run:` block into logical command lines, with heredoc BODIES removed.
 *
 * The heredoc removal is the load-bearing part. The idiom this repo uses to wrap a whole multi-line
 * block is `bash scripts/ci-log-step.sh <name> bash -e /dev/stdin <<'CI_LOG_STEP' … CI_LOG_STEP` —
 * everything between the delimiters already runs INSIDE the wrapper, so counting those lines as
 * unwrapped commands would report every correctly-wrapped block in the repository as a gap.
 *
 * Continuation lines (`\` at end of line) are joined, so a wrapper invocation split across lines is
 * still recognised as one command rather than as a wrapped line followed by bare arguments.
 */
export function commandLines(run) {
  const out = [];
  let heredoc = null;
  let logical = '';
  for (const raw of String(run).split(/\r?\n/)) {
    if (heredoc !== null) {
      if (raw.trim() === heredoc) heredoc = null;
      continue;
    }
    const t = raw.trim();
    if (!t || t.startsWith('#')) continue;
    logical += (logical ? ' ' : '') + t.replace(/\\$/, '');
    if (/\\$/.test(t)) continue; // continued on the next line
    const hd = logical.match(/<<-?\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?/);
    if (hd) heredoc = hd[1];
    out.push(logical);
    logical = '';
  }
  if (logical) out.push(logical);
  return out;
}

/**
 * The commands in a `run:` block that execute OUTSIDE `ci-log-step.sh` (feature 042 durability,
 * item #177 variant 4).
 *
 * WHY THIS EXISTS, and why it is not just another shape check. The three shapes already pinned by
 * cases (x), (x2) and (x3) in the test file are all environmental — the wrapper is invoked but
 * cannot run where the step runs. This one is a hole in the GATE'S OWN RULE: coverage was decided by
 * `/ci-log-step\.sh/.test(step.run)`, a substring test against the whole block, so a 40-line `run:`
 * block passed if the wrapper appeared anywhere in it. Every command before that line failed
 * unwrapped — no log, and no `_failed-step` marker either, so the digest named nothing.
 *
 * MEASURED 2026-08-29: three live steps had a failure path outside their wrapper —
 * `cd-deploy / prod-apk` (`exit 1` on the BASE_DOMAIN guard), `devcontainer-image / build-publish`
 * (`: "${REGISTRY:?…}"`), and `wiki-maintain / maintain` (`exit 2` on a malformed dispatch input,
 * plus the step's final exit expression). The gate reported all three clean.
 *
 * It is the same class the per-step rule closed one level up: "one compliant thing stands in for
 * many". `guardrails / naming` once passed with 2 of 16 steps wrapped; this passed with 1 of N
 * COMMANDS wrapped.
 *
 * HEURISTIC, and knowingly so: it reads shell as lines, not as a parse tree, so a command hidden
 * inside a single-line `case … esac` or behind an `&&` on a keyword line is not seen. It is a floor,
 * not a proof — see docs/runbooks/ci-diagnostics.md, "presence, not reachability".
 */
export function unwrappedCommands(run) {
  return commandLines(run).filter((line) => {
    if (LOG_STEP_SCRIPT.test(line)) return false;
    return !(SHELL_KEYWORD.test(line) || SHELL_ASSIGNMENT.test(line) || SHELL_SETOPT.test(line));
  });
}

/** @returns {{job: string, problem: string}[]} one entry per uncovered job. */
export function findCoverageGaps(text) {
  const doc = parse(text);
  const exemptions = parseExemptions(text);
  const logStepExemptions = parseExemptions(text, 'ci-log-step-exempt');
  const stepView = parseJobSteps(text, doc);
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
      continue;
    }
    // The digest step MUST wire CI_DIGEST_JOB_STATUS — shouldPublish keys off it, and without it a
    // dropped env means the job publishes nothing on a real failure (safe default is now no-publish).
    const wiresJobStatus = digestSteps.some((s) => s.env && 'CI_DIGEST_JOB_STATUS' in s.env);
    if (!wiresJobStatus) {
      gaps.push({ job: name, problem: 'digest step does not set `CI_DIGEST_JOB_STATUS: ${{ job.status }}` env (publish decision depends on it)' });
      continue;
    }
    // A PUBLISHED-BUT-EMPTY digest is worse than none: it looks like coverage. Measured 2026-07-26
    // (PR #107) — `affected` and `mc-service-checks` both failed, both published, and both digests
    // read "no step in this job was wrapped with scripts/ci-log-step.sh … no log output was captured
    // for this job". The real cause had to be read off the workflow config by hand, which is the
    // human-in-the-loop diagnosis this feature exists to remove. So publishing is necessary but not
    // sufficient — at least one step must mirror its output into the digest.
    if (logStepExemptions.has(name)) {
      if (!logStepExemptions.get(name)) {
        gaps.push({ job: name, problem: 'ci-log-step-exempt marker has no reason — state why this job has nothing worth capturing' });
      }
      continue;
    }

    // PER-STEP coverage (feature 051 US2). The rule used to be "at least one wrapped step per job",
    // and one was enough: `guardrails / naming` passed with 2 of 16 wrapped, NEITHER of them a gate.
    // So when that job failed for the reason it exists to catch, the digest published the logs of two
    // unrelated steps and said nothing about the failure — fully compliant, completely undiagnosable.
    // Now every `run:` step must be wrapped or carry its own justified marker.
    //
    // PER-COMMAND, not per-block (item #177 variant 4). `LOG_STEP_SCRIPT.test(step.run)` was a
    // substring test against the WHOLE `run:` block, so one wrapper line covered every other command
    // in it — three live steps had a failure path outside their wrapper and the gate called them
    // clean. See unwrappedCommands() for the measurement.
    for (const step of stepView.get(name) ?? []) {
      if (step.run === null) continue;                       // `uses:`-only — no command to capture
      if (DIGEST_SCRIPT.test(step.run)) continue;            // wrapping the reporter in what it reports on is circular
      const bare = unwrappedCommands(step.run);
      if (bare.length === 0) continue;
      const where = step.name ? `step "${step.name}"` : 'an unnamed run: step';
      if (step.exempt) {
        if (!step.reason) {
          gaps.push({ job: name, problem: `${where} has a ci-log-step-exempt marker with no reason — state why this step has nothing worth capturing` });
        }
        continue;
      }
      // Naming the offending command matters: on a long block the reader cannot otherwise tell
      // WHICH line the gate objects to, and the whole point is that the block LOOKS wrapped.
      const cited = bare.length === 1 ? `\`${bare[0].slice(0, 80)}\`` : `${bare.length} commands, first \`${bare[0].slice(0, 80)}\``;
      gaps.push({
        job: name,
        problem:
          `${where} runs ${cited} outside \`scripts/ci-log-step.sh\`, so a failure there reaches the ` +
          'digest with no output and no failing-step marker. Wrap the whole block (the ' +
          '`bash scripts/ci-log-step.sh <name> bash -e /dev/stdin <<\'CI_LOG_STEP\'` idiom), or add a ' +
          'justified `# ci-log-step-exempt:` marker above the step',
      });
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
  const guarded = `      - name: Publish failure digest\n        if: always()\n        continue-on-error: true\n        env:\n          CI_DIGEST_JOB_STATUS: x\n        run: node scripts/ci-failure-digest.mjs`;
  const noEnv = `      - name: Publish failure digest\n        if: always()\n        continue-on-error: true\n        run: node scripts/ci-failure-digest.mjs`;
  const base = (steps) => `jobs:\n  build:\n    steps:\n${steps}\n`;
  // A COMPLIANT work step is instrumented — publishing a digest that captures nothing is the gap
  // this gate closed on 2026-07-26, so "clean" fixtures must satisfy both halves of the rule.
  const work = `      - run: bash scripts/ci-log-step.sh work echo work`;

  check(base(`${work}\n${guarded}`), 0, 'guarded + instrumented is clean');
  check(base(`${work}`), 1, 'missing digest step is caught');
  check(base(`${work}\n      - run: node scripts/ci-failure-digest.mjs`), 1, 'unguarded digest step is caught');
  check(base(`${work}\n${noEnv}`), 1, 'digest step without CI_DIGEST_JOB_STATUS env is caught');
  check(base(`      - run: echo work\n${guarded}`), 1, 'digest with NO instrumented step is caught (empty digest)');
  check(`jobs:\n  probe:\n    # ci-digest-exempt: trigger-only\n    steps:\n      - run: echo x\n`, 0, 'justified exemption is honoured');
  check(`jobs:\n  probe:\n    # ci-digest-exempt:\n    steps:\n      - run: echo x\n`, 1, 'blank exemption reason is caught');
  check(`jobs:\n  probe:\n    # ci-log-step-exempt: nothing to capture\n    steps:\n      - run: echo x\n${guarded}\n`, 0, 'justified log-step exemption is honoured');
  check(`jobs:\n  probe:\n    # ci-log-step-exempt:\n    steps:\n      - run: echo x\n${guarded}\n`, 1, 'blank log-step exemption reason is caught');

  // --- per-step coverage (feature 051 US2) --------------------------------------------------------
  // Every other gate in `guardrails / naming` proves its FAIL path before the real scan. A rule that
  // nobody has watched fail is a rule nobody knows works — and the failure this whole feature closes
  // is a gate that reported green without checking.
  const wrapped = (n) => `      - name: Step ${n}\n        run: bash scripts/ci-log-step.sh s${n} node ${n}.mjs`;
  const bare = (n) => `      - name: Step ${n}\n        run: node ${n}.mjs`;

  check(base(`${wrapped('a')}\n${wrapped('b')}\n${guarded}`), 0, 'per-step: every run step wrapped is clean');
  check(base(`${wrapped('a')}\n${bare('b')}\n${guarded}`), 1, 'per-step: ONE bare step among wrapped ones is caught');
  check(
    base(`${wrapped('a')}\n      # ci-log-step-exempt: runs before checkout\n${bare('b')}\n${guarded}`),
    0,
    'per-step: a justified step-level exemption is honoured',
  );
  check(
    base(`${wrapped('a')}\n      # ci-log-step-exempt:\n${bare('b')}\n${guarded}`),
    1,
    'per-step: a blank step-level exemption reason is caught',
  );
  check(
    base(`      # ci-log-step-exempt: only this one\n${bare('a')}\n${bare('b')}\n${guarded}`),
    1,
    'per-step: a step exemption does NOT leak to the following step',
  );
  check(
    base(`${wrapped('a')}\n      # ci-digest-exempt: wrong marker for a step\n${bare('b')}\n${guarded}`),
    1,
    'per-step: ci-digest-exempt does not double as a capture exemption',
  );
  check(base(`      - uses: actions/checkout@v4\n${wrapped('a')}\n${guarded}`), 0, 'per-step: a uses:-only step needs no marker');

  if (fails.length) {
    console.error('✗ ci-digest coverage gate --selftest FAILED:\n  ' + fails.join('\n  '));
    process.exit(1);
  }
  console.log(
    '✓ ci-digest coverage gate --selftest passed (catches missing/unguarded/uninstrumented steps and ' +
      'per-step gaps; honours both justified exemptions at job AND step level, and keeps them independent)',
  );
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
