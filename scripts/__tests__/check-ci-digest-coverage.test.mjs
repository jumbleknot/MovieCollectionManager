// Guards scripts/check-ci-digest-coverage.mjs (feature 042 durability).
//
// The digest that makes CI self-diagnosing is one copy-pasted `if: always()` step per job, spread
// across 16 jobs. Nothing stops job #17 being added without it — at which point that job's failures
// silently go back to "paste the log by hand". This gate turns that silent decay into a red CI.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'check-ci-digest-coverage.mjs');

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
