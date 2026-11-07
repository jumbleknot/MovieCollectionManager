// Feature 087 (T031): runs the launch check's own selftest in guardrails, which runs no emulator, so a
// broken classifier is caught where it is cheap. A grep that matches nothing looks identical to a clean
// launch, so this is the only thing proving the check can see a crash before an APK needs it to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'android-launch-smoke.sh');
const run = (...args) => spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8' });

test('--selftest passes: each fatal pattern is detected, and a clean log and another process are not', () => {
  const r = run('--selftest');
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /selftest ok/);
});

test('an unrecognised argument exits 2 rather than running against a device', () => {
  for (const args of [['--bogus'], ['--selftest', 'extra']]) {
    const r = run(...args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /usage:/);
  }
});
