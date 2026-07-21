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

const job = (name, { digest = true, guarded = true } = {}) => {
  let step = DIGEST_STEP;
  if (digest && !guarded) step = step.replace('        if: always()\n', '').replace('        continue-on-error: true\n', '');
  return `  ${name}:
    runs-on: ubuntu-latest
    steps:
      - run: echo work${digest ? step : ''}`;
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
