// Feature 054 US7 (backlog item #178) — the probe's own coverage.
//
// `shell-probe.mjs` decides whether a suite may shell out. It had no tests of its own, which is how a
// helper whose failure mode is SILENCE went wrong unnoticed: it asked one question — `test -r` through
// the shell — and used the answer for two different ones. That predicate is false for a script that
// does not EXIST just as it is for one the shell cannot REACH, and the reason it returned described
// only the second, blaming WSL for a file that was simply not there yet.
//
// The cost, measured 2026-08-11 on Linux with a perfectly usable bash, while writing the RED half of
// `e2e-turn-tally.test.mjs`:
//
//   test file written, script not yet created  → 15 tests, 0 pass, 3 fail, 12 SKIPPED
//   identical file, empty stub script created  → 15 tests, 1 pass, 14 fail, 0 skipped
//
// Twelve cases that should have been RED reported as skips. Under this repository's own rule — a skip
// reads as a pass — that is the failure class feature 051 exists to remove, reproduced inside the
// helper written to prevent it. And it bites exactly when the discipline is being followed, because
// test-before-implementation is the only order in which the script is missing.
//
// Deterministic, offline, token-free, node: built-ins only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { shellCanRunScript, needsShell } from './shell-probe.mjs';

const tempDir = () => mkdtempSync(join(tmpdir(), 'shell-probe-'));

test('an ABSENT script reports usable — so its cases FAIL rather than skip', () => {
  // The fix, and the counter-intuitive half of it. Reporting a missing script as "runnable" is right:
  // the resulting failure is true and legible (a 127, or an assertion about output never produced),
  // whereas the skip is false and invisible.
  const dir = tempDir();
  try {
    const probe = shellCanRunScript('bash', join(dir, 'does-not-exist.sh'));
    assert.equal(probe.usable, true,
      'an absent script was reported as an unusable shell — its RED cases would silently skip');
    assert.equal(probe.reason, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an absent script is never blamed on a filesystem namespace', () => {
  const dir = tempDir();
  try {
    const probe = shellCanRunScript('bash', join(dir, 'nope.sh'));
    assert.doesNotMatch(String(probe.reason ?? ''), /WSL|namespace/i,
      'a missing file was diagnosed as a Windows/WSL problem');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a PRESENT but shell-unreadable script still skips, naming the namespace condition', () => {
  // The case the probe was written for, which must not be traded away. Simulated with a file the
  // shell genuinely cannot read: `test -r` is false, and node's existsSync is true — which is exactly
  // the pair of views the fix distinguishes.
  const dir = tempDir();
  const script = join(dir, 'unreadable.sh');
  try {
    writeFileSync(script, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(script, 0o000);

    // Running as root defeats permission bits entirely, so the condition cannot be staged. Skipping
    // WITH a reason is the honest outcome — and is itself the behaviour this whole feature is about.
    if (shellCanRunScript('bash', script).usable && process.getuid?.() === 0) {
      assert.ok(true, 'staged condition unreachable as root; asserted nothing rather than pretending');
      return;
    }

    const probe = shellCanRunScript('bash', script);
    assert.equal(probe.usable, false, 'an unreadable script was reported runnable');
    assert.match(probe.reason, /namespace|cannot read/i,
      'the skip did not name the condition that caused it');
  } finally {
    try { chmodSync(script, 0o600); } catch { /* best effort */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a shell that cannot be STARTED skips, naming that', () => {
  const dir = tempDir();
  const script = join(dir, 'present.sh');
  try {
    writeFileSync(script, '#!/usr/bin/env bash\nexit 0\n');
    const probe = shellCanRunScript('definitely-not-a-real-shell-054', script);
    assert.equal(probe.usable, false);
    assert.match(probe.reason, /could not be started/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a readable script on a working shell is usable', () => {
  const dir = tempDir();
  const script = join(dir, 'fine.sh');
  try {
    writeFileSync(script, '#!/usr/bin/env bash\nexit 0\n');
    const probe = shellCanRunScript('bash', script);
    assert.equal(probe.usable, true);
    assert.equal(probe.reason, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('needsShell turns a usable probe into a NON-skip, and never a reasonless skip', () => {
  // `{ skip: false }` runs the case; `{ skip: '<reason>' }` skips WITH the reason. A reasonless skip
  // is the thing this file exists to make impossible — US5-AC4 of feature 051, one level up.
  const dir = tempDir();
  const script = join(dir, 'fine.sh');
  try {
    writeFileSync(script, '#!/usr/bin/env bash\nexit 0\n');
    assert.deepEqual(needsShell('bash', script), { skip: false });

    const absent = needsShell('bash', join(dir, 'absent.sh'));
    assert.equal(absent.skip, false, 'an absent script produced a skip');

    const unstartable = needsShell('definitely-not-a-real-shell-054', script);
    assert.equal(typeof unstartable.skip, 'string');
    assert.ok(unstartable.skip.length > 0, 'skipped without a reason');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
