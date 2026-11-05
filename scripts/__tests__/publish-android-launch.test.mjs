// Feature 087 (T029) — the mapping from a launch check's result file to the commit status it posts.
//
// A pure function with its own tests because this is a decision, not formatting: the status is how
// tasks.md gets a quotable launch result on a pass, and this forge has no log API to check it against.
// Each row of the status table in specs/087-expo-sdk-58/data-model.md has a case here. The one row with
// no case is "emulator gate false, no status", because that is the step's `if:`, pinned in
// app-ci-mobile-full.guard.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTEXT, launchStatusFor, resultFilePath } from '../publish-android-launch.mjs';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'publish-android-launch.mjs');
const PASSED = { launch: 'ok', loginScreen: 'visible', fatal: 0 };

test('the context is exactly the one the data model names', () => {
  assert.equal(CONTEXT, 'app-ci / android-launch');
});

test('all three checks passed: success, with the line tasks.md quotes', () => {
  assert.deepEqual(launchStatusFor(PASSED), {
    state: 'success',
    description: 'launch=ok login-screen=visible fatal=0',
  });
});

test('the result file is absent: failure, and says the checks never ran', () => {
  const status = launchStatusFor(null);
  assert.equal(status.state, 'failure');
  assert.match(status.description, /^launch=not-run /);
});

for (const [label, result, expected] of [
  ['launch failed', { ...PASSED, launch: 'failed' }, 'launch=failed login-screen=visible fatal=0'],
  ['login screen absent', { ...PASSED, loginScreen: 'absent' }, 'launch=ok login-screen=absent fatal=0'],
  ['one fatal line', { ...PASSED, fatal: 1 }, 'launch=ok login-screen=visible fatal=1'],
]) {
  test(`any one check failing is a failure: ${label}`, () => {
    assert.deepEqual(launchStatusFor(result), { state: 'failure', description: expected });
  });
}

test('a malformed result is a failure, never a guess at success', () => {
  for (const bad of [{}, { launch: 'ok' }, { ...PASSED, fatal: '0' }, { ...PASSED, fatal: -1 }, 'ok', 7]) {
    const status = launchStatusFor(bad);
    assert.equal(status.state, 'failure', JSON.stringify(bad));
    assert.match(status.description, /^launch=not-run /, JSON.stringify(bad));
  }
});

test('the description holds only the three values, never text from the file', () => {
  const status = launchStatusFor({ launch: 'token=abc', loginScreen: 'visible', fatal: 0 });
  assert.equal(status.state, 'failure');
  assert.doesNotMatch(status.description, /abc/);
});

test('the result file is named by run, so a persistent runner cannot serve a stale one', () => {
  assert.equal(resultFilePath({ HOME: '/h', GITHUB_RUN_ID: '42' }), '/h/android-launch-42.json');
});

function runScript(args, env = {}) {
  return spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
  });
}

test('an unrecognised argument exits 2 and posts nothing', () => {
  const r = runScript(['--dry_run']);
  assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
});

test('with the forge variables missing it reads and deletes the file, posts nothing, and exits 0', () => {
  const home = mkdtempSync(join(tmpdir(), 'android-launch-'));
  const file = join(home, 'android-launch-7.json');
  writeFileSync(file, JSON.stringify(PASSED));
  const r = runScript([], { HOME: home, GITHUB_RUN_ID: '7' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /launch=ok login-screen=visible fatal=0/);
  assert.equal(existsSync(file), false, 'the result file must be deleted once read');
});

test('a cancelled job publishes nothing: superseded is not a failed launch', () => {
  const home = mkdtempSync(join(tmpdir(), 'android-launch-'));
  const r = runScript([], { HOME: home, GITHUB_RUN_ID: '8', MEASURED_JOB_STATUS: 'cancelled' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.doesNotMatch(r.stdout, /state=/);
});
