// Guards scripts/check-ci-digest-coverage.mjs (feature 042 durability).
//
// The digest that makes CI self-diagnosing is one copy-pasted `if: always()` step per job, spread
// across 16 jobs. Nothing stops job #17 being added without it — at which point that job's failures
// silently go back to "paste the log by hand". This gate turns that silent decay into a red CI.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const GATE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'check-ci-digest-coverage.mjs');
const REPO_WORKFLOWS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '.forgejo', 'workflows');

/** Run the gate against a throwaway workflows dir. */
function runGate(workflows) {
  const root = mkdtempSync(join(tmpdir(), 'digest-cov-'));
  const dir = join(root, '.forgejo', 'workflows');
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(workflows)) writeFileSync(join(dir, name), body);
  const r = spawnSync('node', [GATE, '--dir', dir], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const DIGEST_STEP = `
      - name: Publish failure digest
        if: always()
        continue-on-error: true
        env:
          CI_DIGEST_TOKEN: \${{ secrets.CI_DIGEST_TOKEN }}
          CI_DIGEST_JOB_STATUS: \${{ job.status }}
        run: node scripts/ci-failure-digest.mjs`;

const job = (name, { digest = true, guarded = true, instrumented = true } = {}) => {
  let step = DIGEST_STEP;
  if (digest && !guarded) step = step.replace('        if: always()\n', '').replace('        continue-on-error: true\n', '');
  // The work step is instrumented by default: a COMPLIANT job both publishes a digest and mirrors
  // at least one step's output into it. Tests that target the instrumentation rule opt out via
  // `instrumented: false` so they isolate that one property.
  return `  ${name}:
    runs-on: ubuntu-latest
    steps:
      - run: ${instrumented ? 'bash scripts/ci-log-step.sh work ' : ''}echo work${digest ? step : ''}`;
};

const wf = (...jobs) => `name: test\non:\n  push:\njobs:\n${jobs.join('\n')}\n`;

test('(a) a workflow where every job has a guarded digest step passes', () => {
  const { code } = runGate({ 'a.yml': wf(job('build'), job('test')) });
  assert.equal(code, 0);
});

test('(b) a job with NO digest step fails, and the message names the job', () => {
  const { code, out } = runGate({ 'a.yml': wf(job('build'), job('deploy', { digest: false })) });
  assert.equal(code, 1);
  assert.match(out, /a \/ deploy/);
});

test('(c) a digest step WITHOUT `if: always()` + continue-on-error fails — it could mask the job', () => {
  // FR-009: a digest step that can change the job outcome is worse than no step. The gate protects
  // the guards, not just the presence.
  const { code, out } = runGate({ 'a.yml': wf(job('build', { guarded: false })) });
  assert.equal(code, 1);
  assert.match(out, /always|continue-on-error/i);
});

test('(d) an explicit exemption marker on a job is honoured', () => {
  // A deliberate exception must be possible, but VISIBLE — mirrors the conftest _LEGITIMATE_SKIPS
  // pattern: silence only where a human wrote down why.
  const exempt = `  probe:
    runs-on: ubuntu-latest
    # ci-digest-exempt: trigger-only job, no step can fail meaningfully
    steps:
      - run: echo work`;
  const { code } = runGate({ 'a.yml': wf(job('build'), exempt) });
  assert.equal(code, 0);
});

test('(d2) an exemption with no reason after the marker is REJECTED', () => {
  const bad = `  probe:
    runs-on: ubuntu-latest
    # ci-digest-exempt:
    steps:
      - run: echo work`;
  const { code, out } = runGate({ 'a.yml': wf(bad) });
  assert.equal(code, 1);
  assert.match(out, /reason|justif/i);
});

test('(e) the real repo workflows all pass — this is the invariant the gate protects', () => {
  const r = spawnSync('node', [GATE], { encoding: 'utf8' });
  assert.equal(r.status, 0, `real workflows failed coverage:\n${r.stdout}${r.stderr}`);
});

test('(f) --selftest passes, and an unknown arg exits 2', () => {
  assert.equal(spawnSync('node', [GATE, '--selftest'], { encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync('node', [GATE, '--bogus'], { encoding: 'utf8' }).status, 2);
});

// --- (g)-(j) a digest with NO instrumented step carries no diagnostic value --------------------
//
// Measured gap (2026-07-26, PR #107): `affected` and `mc-service-checks` failed, both published a
// digest, and both digests said "no step in this job was wrapped with scripts/ci-log-step.sh …
// no log output was captured for this job". The cause (Node 20 vs pnpm 11's engines >= 22.13) had
// to be read off the workflow config by hand — exactly the human-in-the-loop diagnosis feature 042
// exists to remove. The old gate passed those jobs because it only asked "is a digest PUBLISHED?",
// never "does it CONTAIN anything?". An empty digest is arguably worse than none: it looks like
// coverage.

const instrumented = (name) => `  ${name}:
    runs-on: ubuntu-latest
    steps:
      - run: bash scripts/ci-log-step.sh work-log pnpm nx test${DIGEST_STEP}`;

test('(g) a job whose steps are NONE of them instrumented FAILS, naming ci-log-step.sh', () => {
  const r = runGate({ 'a.yml': wf(job('affected', { instrumented: false })) }); // digest present + guarded, no ci-log-step.sh
  assert.equal(r.code, 1, 'an uninstrumented job passed — its digest would be empty');
  assert.match(r.out, /affected/);
  assert.match(r.out, /ci-log-step/);
});

test('(h) a job with at least one instrumented step PASSES', () => {
  const r = runGate({ 'a.yml': wf(instrumented('affected')) });
  assert.equal(r.code, 0, r.out);
});

test('(i) a job may opt out with a justified `# ci-log-step-exempt:` marker', () => {
  // Mirrors the existing ci-digest-exempt escape hatch (marker INSIDE the job block): silence is
  // allowed only where a human wrote down why. `changes` (dorny/paths-filter) genuinely has no
  // command output worth capturing.
  const exempt = `  changes:
    runs-on: ubuntu-latest
    # ci-log-step-exempt: dorny/paths-filter only — no command output to capture
    steps:
      - run: echo work${DIGEST_STEP}`;
  const r = runGate({ 'a.yml': wf(exempt) });
  assert.equal(r.code, 0, r.out);
});

test('(i2) an instrumentation exemption with NO reason is rejected', () => {
  const bad = `  changes:
    runs-on: ubuntu-latest
    # ci-log-step-exempt:
    steps:
      - run: echo work${DIGEST_STEP}`;
  const r = runGate({ 'a.yml': wf(bad) });
  assert.equal(r.code, 1, 'a blank exemption reason was accepted');
  assert.match(r.out, /reason|justif/i);
});

// --- (k)-(l) the verdict must not depend on the contributor's line endings (feature 051, US7) ----
//
// PRD §1.3 reported this gate failing on three jobs — `app-ci / changes`, `app-ci / trigger-cd`,
// `infra-image-scan / changes` — that are all correctly exempt, and recorded the local/CI divergence
// as unexplained. It was line endings. `parseExemptions` split on '\n', leaving a trailing '\r' on
// every line of a CRLF checkout; the marker pattern `#\s*<marker>:(.*)$` then could not match,
// because '.' does not consume '\r' (it is a line terminator in JS regexes) and a non-multiline '$'
// demands end-of-input. The job-header pattern on the adjacent line survived because its `\s*`
// absorbed the '\r' — and THAT asymmetry is the bug: the parser saw the jobs but not their
// exemptions, so it reported correctly-exempt jobs as uncovered. Failed CLOSED: noisy, safe, wrong.
//
// `.gitattributes` now declares eol=lf for *.yml, which stops the condition being produced. These
// two cases are the second layer: a gate's verdict must not depend on a contributor's core.autocrlf,
// because the declaration governs future checkouts and cannot reach a working tree that already
// exists. Both are RED on Linux against the unfixed parser — no Windows host required (FR-024).

/**
 * Exercise an export of the gate in a subprocess, feeding it a string DIRECTLY rather than through a
 * file — the point of FR-024 is to prove the parser, not the checkout.
 *
 * The subprocess is needed because importing the gate runs the real scan as a side effect (it is a
 * script, not a library). `--dir` is pointed at an empty temp dir so that side effect is a no-op:
 * without it, a repo whose workflows are momentarily red would `process.exit(1)` and take the test
 * process with it, reporting a parser bug that does not exist.
 */
function callGateExport(expr) {
  const empty = mkdtempSync(join(tmpdir(), 'digest-cov-empty-'));
  const probe = join(empty, 'probe.mjs');
  writeFileSync(
    probe,
    `import * as m from ${JSON.stringify(pathToFileURL(GATE).href)};\n` +
      `console.log('<<<RESULT>>>' + JSON.stringify((${expr})(m)));\n`,
  );
  // A real file rather than `node -e`, so `--dir` lands in process.argv.slice(2) where the gate
  // reads it; with `-e` there is no script argv slot and node swallows the flag as its own.
  const r = spawnSync('node', [probe, '--dir', empty], { encoding: 'utf8' });
  const marker = `${r.stdout}`.split('<<<RESULT>>>')[1];
  assert.ok(marker, `subprocess produced no result:\n${r.stdout}${r.stderr}`);
  return JSON.parse(marker);
}

test('(k) parseExemptions reads the same markers from CRLF input as from LF input', () => {
  // Assert on the CONTENTS, not just the size: a reason captured as 'because reasons\r' would keep
  // the map's size at 1 while corrupting every message the gate prints and every comparison a future
  // rule makes against it.
  const both = callGateExport(`(m) => {
    const lf = [
      '  covered:',
      '    steps:',
      '      - run: echo hi',
      '  probe:',
      '    # ci-digest-exempt: trigger-only job, no step can fail meaningfully',
      '    steps:',
      '      - run: echo hi',
      '  changes:',
      '    # ci-log-step-exempt: dorny/paths-filter only — no command output to capture',
      '    steps:',
      '      - run: echo hi',
      '',
    ].join('\\n');
    const crlf = lf.replace(/\\n/g, '\\r\\n');
    const pairs = (map) => [...map.entries()];
    return {
      digestLf: pairs(m.parseExemptions(lf)),
      digestCrlf: pairs(m.parseExemptions(crlf)),
      stepLf: pairs(m.parseExemptions(lf, 'ci-log-step-exempt')),
      stepCrlf: pairs(m.parseExemptions(crlf, 'ci-log-step-exempt')),
    };
  }`);

  // Guard the guard: if the LF side ever stops finding anything, the deep-equal below would pass on
  // two empty maps and prove nothing at all.
  assert.deepEqual(both.digestLf, [['probe', 'trigger-only job, no step can fail meaningfully']]);
  assert.deepEqual(both.stepLf, [['changes', 'dorny/paths-filter only — no command output to capture']]);

  assert.deepEqual(both.digestCrlf, both.digestLf, 'ci-digest-exempt markers are invisible on CRLF input');
  assert.deepEqual(both.stepCrlf, both.stepLf, 'ci-log-step-exempt markers are invisible on CRLF input');
});

test('(l) the real repo workflows reach the SAME verdict on CRLF as on LF — PRD §1.3', () => {
  // The regression test for the reported failure itself, end to end through the gate rather than
  // through one exported function. Same bytes, different line endings, same verdict — or the gate is
  // deciding a merge on the contributor's version-control configuration.
  const crlf = {};
  for (const f of readdirSync(REPO_WORKFLOWS).filter((n) => /\.ya?ml$/.test(n))) {
    crlf[f] = readFileSync(join(REPO_WORKFLOWS, f), 'utf8').replace(/\r?\n/g, '\r\n');
  }
  assert.ok(Object.keys(crlf).length > 0, 'no workflow files found — the case would pass vacuously');

  const lfVerdict = spawnSync('node', [GATE], { encoding: 'utf8' }).status;
  assert.equal(lfVerdict, 0, 'the LF baseline is not clean — fix that before reading the CRLF result');

  const r = runGate(crlf);
  assert.equal(
    r.code,
    0,
    `the same workflows fail the gate when checked out with CRLF endings — this is PRD §1.3:\n${r.out}`,
  );
});

test('(j) the two exemption markers are INDEPENDENT — one does not waive the other', () => {
  // A job carrying ONLY the instrumentation exemption must still be required to publish a digest.
  const bad = `  nodigest:
    runs-on: ubuntu-latest
    # ci-log-step-exempt: nothing to capture
    steps:
      - run: echo hi`;
  const r = runGate({ 'a.yml': wf(bad) });
  assert.equal(r.code, 1, 'the instrumentation exemption silently waived the digest requirement');
  assert.match(r.out, /failure-digest step/);
});

// --- (r)-(v) PER-STEP coverage (feature 051 US2) --------------------------------------------------
//
// The old rule asked, per JOB: does it publish a digest, and is AT LEAST ONE step wrapped? One was
// enough. `guardrails / naming` passed with 2 of 16 steps wrapped — and NEITHER of the two was a
// gate. The resource-naming gate, the Komodo-sync gate, the topology scrub, the argv-secret gate,
// the port-collision gate, the restart-policy gate, the CI-digest coverage gate itself, the
// toolchain gate, the DAST selftest and the realm-consistency gate all ran bare. So when that job
// failed for the reason it exists to catch, the digest faithfully published the logs of two
// UNRELATED steps and said nothing about the failure. Fully compliant, completely undiagnosable.
//
// Measured across .forgejo/workflows/ before this change: 85 of 136 `run:` steps were bare.

const stepJob = (name, steps) => `  ${name}:\n    runs-on: ubuntu-latest\n    steps:\n${steps}${DIGEST_STEP}`;

test('(r) a job with one wrapped and one BARE run step now FAILS, naming the job and the step', () => {
  const r = runGate({
    'a.yml': wf(stepJob('naming', '      - name: Wrapped gate\n        run: bash scripts/ci-log-step.sh w node scripts/a.mjs\n      - name: Resource-naming gate\n        run: node scripts/check-resource-naming.mjs')),
  });
  assert.equal(r.code, 1, 'one wrapped step still satisfied the whole job — the old rule survived');
  assert.match(r.out, /naming/);
  assert.match(r.out, /Resource-naming gate/, 'the message does not name the step that is unwrapped');
});

test('(r2) a job whose run steps are ALL wrapped passes', () => {
  const r = runGate({
    'a.yml': wf(stepJob('naming', '      - run: bash scripts/ci-log-step.sh a node a.mjs\n      - run: bash scripts/ci-log-step.sh b node b.mjs')),
  });
  assert.equal(r.code, 0, r.out);
});

test('(s) a STEP-level `# ci-log-step-exempt:` marker with a reason is honoured', () => {
  const r = runGate({
    'a.yml': wf(stepJob('naming', '      - run: bash scripts/ci-log-step.sh a node a.mjs\n      # ci-log-step-exempt: runs before actions/checkout, so ci-log-step.sh is not on disk yet\n      - name: Free disk space\n        run: docker system prune -af')),
  });
  assert.equal(r.code, 0, r.out);
});

test('(s2) a step-level marker with NO reason is rejected, exactly as the job-level one is', () => {
  const r = runGate({
    'a.yml': wf(stepJob('naming', '      - run: bash scripts/ci-log-step.sh a node a.mjs\n      # ci-log-step-exempt:\n      - name: Free disk space\n        run: docker system prune -af')),
  });
  assert.equal(r.code, 1, 'a blank step-level reason was accepted');
  assert.match(r.out, /reason|justif/i);
});

test('(s3) a step-level exemption covers ONLY its own step, not the rest of the job', () => {
  // The whole failure being fixed is one compliant thing standing in for many. An exemption that
  // leaked to the following steps would rebuild it in the escape hatch.
  const r = runGate({
    'a.yml': wf(stepJob('naming', '      # ci-log-step-exempt: pre-checkout\n      - name: Free disk\n        run: docker system prune -af\n      - name: Resource-naming gate\n        run: node scripts/check-resource-naming.mjs')),
  });
  assert.equal(r.code, 1, 'a step-level exemption silently covered a later, unrelated step');
  assert.match(r.out, /Resource-naming gate/);
});

test('(t) the digest step itself needs no marker — wrapping the reporter in what it reports on is circular', () => {
  const r = runGate({ 'a.yml': wf(stepJob('naming', '      - run: bash scripts/ci-log-step.sh a node a.mjs')) });
  assert.equal(r.code, 0, `the digest step was demanded to wrap itself:\n${r.out}`);
});

test('(t2) a `uses:`-only step needs no marker — there is no run: command to capture', () => {
  const r = runGate({
    'a.yml': wf(stepJob('naming', '      - uses: actions/checkout@v4\n      - run: bash scripts/ci-log-step.sh a node a.mjs')),
  });
  assert.equal(r.code, 0, r.out);
});

test('(u) THE TWO MARKERS STAY INDEPENDENT — neither satisfies the other\'s rule', () => {
  // Contract § "there are TWO, and they are not interchangeable". Conflating them would silently
  // disable one of two gates while every test still passed.

  // (1) a step-level ci-DIGEST-exempt must NOT excuse an unwrapped step.
  const digestMarkerOnStep = runGate({
    'a.yml': wf(stepJob('naming', '      - run: bash scripts/ci-log-step.sh a node a.mjs\n      # ci-digest-exempt: not the right marker for a step\n      - name: Bare gate\n        run: node scripts/check-a.mjs')),
  });
  assert.equal(digestMarkerOnStep.code, 1, 'ci-digest-exempt was accepted as a capture exemption');

  // (2) a job-level ci-log-step-exempt must NOT excuse a missing digest step.
  const captureMarkerNoDigest = runGate({
    'a.yml': `name: t\non:\n  push:\njobs:\n  nodigest:\n    runs-on: ubuntu-latest\n    # ci-log-step-exempt: nothing to capture\n    steps:\n      - run: echo hi\n`,
  });
  assert.equal(captureMarkerNoDigest.code, 1, 'ci-log-step-exempt silently waived the digest requirement');
  assert.match(captureMarkerNoDigest.out, /failure-digest step/);
});

test('(v) a JOB-level capture exemption still covers every step in that job', () => {
  // The pre-existing job-scoped behaviour must not be broken by the step-level extension — jobs like
  // `changes` (dorny/paths-filter only) rely on it.
  const r = runGate({
    'a.yml': `name: t\non:\n  push:\njobs:\n  changes:\n    runs-on: ubuntu-latest\n    # ci-log-step-exempt: dorny/paths-filter only — no command output to capture\n    steps:\n      - run: echo a\n      - run: echo b${DIGEST_STEP}\n`,
  });
  assert.equal(r.code, 0, r.out);
});

test('(v2) the REAL repo workflows satisfy the per-step rule — the gate ships with its wrapping', () => {
  // Contract § Implementation constraints 2: a stricter gate landing ahead of the steps it governs
  // fails the very build that introduces it.
  const r = spawnSync('node', [GATE], { encoding: 'utf8' });
  assert.equal(r.status, 0, `the real workflows do not satisfy the per-step rule:\n${r.stdout}${r.stderr}`);
});
