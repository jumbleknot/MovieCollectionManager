// Item #985: a non-blocking full-suite failure must publish enough to tell "still the known cause"
// from "something new". These tests pin the summary that the always-published
// `maestro-full-results` step prints for every flow that did not pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import {
  failedFlows,
  failureMessage,
  screenLines,
  summarizeFlow,
  summarizeAll,
  MAX_SCREEN_LINES,
} from '../maestro-failure-summary.mjs';

const SCRIPT = new URL('../maestro-failure-summary.mjs', import.meta.url).pathname;

const node = (attributes, children = []) => ({ attributes, children });

/** The shape of run 7296's login-invalid failure: Chrome still on the Keycloak form. */
function chromeOnKeycloak() {
  return node({}, [
    node({ 'resource-id': 'com.android.systemui:id/clock', text: '4:42', bounds: '[50,1][136,128]' }),
    node({ accessibilityText: 'Google Play Protect notification: Google Play Protect is turned on', bounds: '[136,1][194,128]' }),
    node({ 'resource-id': 'com.android.chrome:id/close_button', accessibilityText: 'Close tab', bounds: '[0,128][126,275]' }),
    node({ 'resource-id': 'kc-page-title', text: 'Sign in to your account', bounds: '[84,626][1000,726]' }),
    node({
      'resource-id': 'username', text: 'someone@example.test', class: 'android.widget.EditText',
      focused: 'true', bounds: '[84,836][1000,936]',
    }),
    node({ 'resource-id': 'input-error-container-username', bounds: '[84,931][1000,931]' }),
    node({ 'resource-id': 'kc-login', text: 'Sign In', bounds: '[84,1246][1000,1346]' }),
  ]);
}

function makeDiagnostics() {
  const root = mkdtempSync(join(tmpdir(), 'maestro-summary-'));
  writeFileSync(
    join(root, 'full-suite-results.log'),
    'flow\tresult\tattempts\tseconds\n' +
      'auth-guard\tPASS\t1\t47\n' +
      'login-invalid\tFAIL-NONBLOCKING\t1\t79\n' +
      'movie-sort\tFAIL-NONBLOCKING\t1\t63\n',
  );
  const flowDir = join(root, 'login-invalid-attempt1', 'maestro', 'login-invalid');
  mkdirSync(join(flowDir, 'screen-hierarchy'), { recursive: true });
  mkdirSync(join(flowDir, 'logs'), { recursive: true });
  // Two hierarchies: the summary must pick the LAST step, which is the failing one.
  writeFileSync(join(flowDir, 'screen-hierarchy', 'step-009-assertCondition-Username_or_email.json'),
    JSON.stringify(node({}, [node({ 'resource-id': 'early-step', text: 'not this one', bounds: '[0,0][10,10]' })])));
  writeFileSync(join(flowDir, 'screen-hierarchy', 'step-033-assertCondition-login-screen.json'),
    JSON.stringify(chromeOnKeycloak()));
  writeFileSync(join(flowDir, 'logs', 'maestro.log'), [
    '16:52:15.188 [ INFO] maestro.cli.runner.MaestroCommandRunner.runCommands$lambda$2: Press Back key COMPLETED',
    '16:52:30.428 [ERROR] maestro.orchestra.Orchestra.executeCommands: [Command execution] CommandFailed: Assertion is false: id: login-screen is visible',
  ].join('\n'));
  return root;
}

test('failedFlows: every flow that did not pass, in table order — non-blocking failures included', () => {
  const rows = failedFlows('flow\tresult\tattempts\tseconds\na\tPASS\t1\t1\nb\tFAIL\t2\t9\nc\tFAIL-NONBLOCKING\t1\t5\nd\tPASS-REMOVE-NONBLOCKING\t1\t3\n');
  assert.deepEqual(rows.map((r) => r.flow), ['b', 'c']);
  assert.equal(rows[1].result, 'FAIL-NONBLOCKING');
});

test('failureMessage: the LAST CommandFailed line, without the logger prefix', () => {
  const log = 'x CommandFailed: first\ny [ERROR] maestro.orchestra.Orchestra.executeCommands: [Command execution] CommandFailed: Assertion is false: id: nav-home is visible\n';
  assert.equal(failureMessage(log), 'Assertion is false: id: nav-home is visible');
  assert.equal(failureMessage('nothing failed here'), null);
});

test('screenLines: names what is on screen, drops system chrome, and NEVER prints a typed field value', () => {
  const lines = screenLines(chromeOnKeycloak());
  const text = lines.join('\n');
  assert.match(text, /kc-page-title "Sign in to your account"/);
  assert.match(text, /com\.android\.chrome:id\/close_button "Close tab"/);
  assert.match(text, /username \[input, filled, focused\]/);
  assert.doesNotMatch(text, /someone@example\.test/, 'an EditText value reached the summary');
  assert.doesNotMatch(text, /systemui/, 'status-bar noise is not evidence');
  assert.doesNotMatch(text, /Play Protect/, 'a status-bar notification icon is not evidence');
  // Zero-height nodes are not visible — an empty error container must not read as an error shown.
  assert.doesNotMatch(text, /input-error-container-username/);
});

test('screenLines: bounded, and says so when it cuts', () => {
  const many = node({}, Array.from({ length: MAX_SCREEN_LINES + 15 }, (_, i) =>
    node({ 'resource-id': `row-${i}`, bounds: '[0,0][10,10]' })));
  const lines = screenLines(many);
  assert.equal(lines.length, MAX_SCREEN_LINES + 1);
  assert.match(lines.at(-1), /15 more element/);
});

test('summarizeFlow: the failing step, its message and its screen, per attempt; a missing capture is said, not skipped', () => {
  const root = makeDiagnostics();
  try {
    const text = summarizeFlow(root, { flow: 'login-invalid', result: 'FAIL-NONBLOCKING', attempts: 1 });
    assert.match(text, /login-invalid — FAIL-NONBLOCKING — attempt 1/);
    assert.match(text, /step-033-assertCondition-login-screen/);
    assert.match(text, /Assertion is false: id: login-screen is visible/);
    assert.match(text, /kc-page-title "Sign in to your account"/);
    assert.doesNotMatch(text, /not this one/, 'an earlier step was summarized instead of the failing one');

    const missing = summarizeFlow(root, { flow: 'movie-sort', result: 'FAIL-NONBLOCKING', attempts: 1 });
    assert.match(missing, /movie-sort — FAIL-NONBLOCKING — attempt 1: no device capture/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('summarizeAll: nothing to say on an all-pass table', () => {
  const root = mkdtempSync(join(tmpdir(), 'maestro-summary-'));
  try {
    writeFileSync(join(root, 'full-suite-results.log'), 'flow\tresult\tattempts\tseconds\na\tPASS\t1\t1\n');
    assert.equal(summarizeAll(root), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: prints the summary, exits 0, and REJECTS an unknown flag rather than guessing', () => {
  const root = makeDiagnostics();
  try {
    const out = execFileSync('node', [SCRIPT, root], { encoding: 'utf8' });
    assert.match(out, /login-invalid — FAIL-NONBLOCKING/);
    assert.throws(() => execFileSync('node', [SCRIPT, '--dry_run', root], { stdio: 'pipe' }), /unrecognised/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: an absent diagnostics directory is reported, not a crash — the step must never fail on it', () => {
  const out = execFileSync('node', [SCRIPT, join(tmpdir(), 'definitely-not-here-985')], { encoding: 'utf8' });
  assert.match(out, /no full-suite results/);
});
