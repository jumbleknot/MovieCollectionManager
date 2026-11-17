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
  failedAttempts,
  deviceLogLines,
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
  writeFileSync(join(root, 'login-invalid-attempt1', 'logcat-full.log'),
    '11-10 16:52:01.000 I/ActivityTaskManager(  514): START u0 {dat=http://localhost:8099/auth?state=X cmp=com.android.chrome/.CustomTab}\n');
  writeFileSync(join(flowDir, 'logs', 'maestro.log'), [
    '16:52:15.188 [ INFO] maestro.cli.runner.MaestroCommandRunner.runCommands$lambda$2: Press Back key COMPLETED',
    '16:52:30.428 [ERROR] maestro.orchestra.Orchestra.executeCommands: [Command execution] CommandFailed: Assertion is false: id: login-screen is visible',
  ].join('\n'));
  return root;
}

test('failedAttempts: a flow that PASSED on retry still reports its failed attempts — item #986 hid there', () => {
  const rows = failedAttempts('flow\tresult\tattempts\tseconds\nauth-guard\tPASS\t2\t134\nhome\tPASS\t1\t40\nb\tFAIL\t2\t9\nc\tFAIL-NONBLOCKING\t1\t5\n');
  assert.deepEqual(rows, [
    { flow: 'auth-guard', result: 'PASS', attempts: [1] },
    { flow: 'b', result: 'FAIL', attempts: [1, 2] },
    { flow: 'c', result: 'FAIL-NONBLOCKING', attempts: [1] },
  ]);
});

test('deviceLogLines: only the app and Chrome lifecycle, the last N, with every URL query withheld', () => {
  const log = [
    '11-10 16:43:01.223 I/Finsky  ( 7943): [2] aoas - Received: android.intent.action.PACKAGE_REMOVED',
    '11-10 16:43:02.000 I/ActivityTaskManager(  514): START u0 {act=android.intent.action.VIEW dat=http://localhost:8099/realms/x/auth?client_id=mcm&state=SECRETSTATE cmp=com.android.chrome/.CustomTab} from uid 10190',
    '11-10 16:43:03.000 I/ActivityTaskManager(  514): START u0 {dat=com.grumpyrobot.mcmapp://redirect?code=SECRETCODE&state=S2 cmp=com.grumpyrobot.mcmapp/.MainActivity}',
    '11-10 16:43:04.000 I/ActivityManager(  514): Process com.android.chrome:sandboxed_process0 (pid 9) has died: fg',
    '11-10 16:43:05.000 E/chromium( 8001): [ERROR:ssl_client_socket_impl.cc] handshake failed',
    '11-10 16:43:05.500 V/chromium( 8001): verbose noise',
    '11-10 16:43:06.000 I/ReactNativeJS( 7001): [auth] login outcome: dismiss',
    '11-10 16:43:07.000 D/BoundBrokerSvc( 7557): onBind: Intent { act=com.google.android.gms.feedback }',
    '11-10 16:43:08.000 I/ActivityManager(  510): Process com.google.android.gms.persistent (pid 1200) has died: fg',
    '11-10 16:43:08.100 I/ActivityManager(  510): Process com.google.android.gms.unstable (pid 1300) has died: cch',
    '11-10 16:43:08.200 I/PackageManager(  510): Update package com.google.android.gms code path',
  ].join('\n');
  const lines = deviceLogLines(log);
  const text = lines.join('\n');
  assert.equal(lines.length, 7);
  assert.match(text, /gms\.persistent .*has died/, 'run 7820: Play services dying is what killed Chrome');
  assert.match(text, /PackageManager.*Update package com\.google\.android\.gms/);
  assert.doesNotMatch(text, /gms\.unstable/);
  assert.match(text, /START u0 .*com\.android\.chrome/);
  assert.match(text, /mcmapp:\/\/redirect\?…/);
  assert.match(text, /has died/);
  assert.match(text, /handshake failed/);
  assert.match(text, /login outcome: dismiss/);
  assert.doesNotMatch(text, /SECRETCODE|SECRETSTATE|client_id/, 'a URL query reached the summary');
  assert.doesNotMatch(text, /Finsky|BoundBrokerSvc|verbose noise/);
  assert.deepEqual(deviceLogLines(log, 2), lines.slice(-2), 'keeps the LAST lines — the failure is at the end');
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
    const text = summarizeFlow(root, { flow: 'login-invalid', result: 'FAIL-NONBLOCKING', attempts: [1] });
    assert.match(text, /login-invalid — FAIL-NONBLOCKING — attempt 1/);
    assert.match(text, /step-033-assertCondition-login-screen/);
    assert.match(text, /Assertion is false: id: login-screen is visible/);
    assert.match(text, /kc-page-title "Sign in to your account"/);
    assert.doesNotMatch(text, /not this one/, 'an earlier step was summarized instead of the failing one');
    assert.match(text, /device log:\n\s+.*START u0 .*com\.android\.chrome/);

    const missing = summarizeFlow(root, { flow: 'movie-sort', result: 'FAIL-NONBLOCKING', attempts: [1] });
    assert.match(missing, /movie-sort — FAIL-NONBLOCKING — attempt 1: no device capture/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('summarizeAll: a retried-then-passed flow is summarized under its PASS, attempt by attempt', () => {
  const root = makeDiagnostics();
  try {
    writeFileSync(join(root, 'full-suite-results.log'), 'flow\tresult\tattempts\tseconds\nlogin-invalid\tPASS\t2\t120\n');
    const text = summarizeAll(root);
    assert.match(text, /login-invalid — PASS on attempt 2 — attempt 1 failed/);
    assert.doesNotMatch(text, /attempt 2 failed/);
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
