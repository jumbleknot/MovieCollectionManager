// Feature 078 — the launcher the `wiki-update` Nx target runs (plan D2).
//
// Drives the REAL launcher against a fake `openwiki` placed first on PATH, which records the argv and
// environment it was started with. No model is called. The preflight's orchestration is covered in
// wiki-maintain.test.mjs (preflightGate); the live call itself is verified by hand per tasks T015.
//
// What is pinned here, and why each matters:
//   • the run message reaches the generator as ONE argv element, never through a shell — the
//     `nx --args` quoting loss (2026-07-30) ran the generator unscoped;
//   • with no message the refresh is unscoped, as the target always behaved;
//   • the usage tap is loaded into the generator process;
//   • a missing credential stops BEFORE the generator starts (FR-006);
//   • item #516: both telemetry opt-outs are forced on, every run passes `--telemetry-file`, and a
//     record showing the opt-out did not hold exits 3 whatever the generator's own status.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LAUNCHER = join(REPO_ROOT, 'scripts', 'wiki-generate.mjs');

function fakeGenerator() {
  const dir = mkdtempSync(join(tmpdir(), 'fake-openwiki-'));
  const out = join(dir, 'invocation.json');
  const bin = join(dir, 'openwiki');
  writeFileSync(bin, `#!/usr/bin/env node
const tf = process.argv.find((a) => a.startsWith('--telemetry-file='));
if (tf && process.env.FAKE_TELEMETRY_RECORD) require('node:fs').writeFileSync(tf.slice('--telemetry-file='.length), process.env.FAKE_TELEMETRY_RECORD);
require('node:fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({
  argv: process.argv.slice(2),
  env: {
    OPENWIKI_PROVIDER: process.env.OPENWIKI_PROVIDER,
    OPENWIKI_MODEL_ID: process.env.OPENWIKI_MODEL_ID,
    OPENWIKI_PAGE_CONCURRENCY: process.env.OPENWIKI_PAGE_CONCURRENCY,
    OPENWIKI_MAX_OUTPUT_TOKENS: process.env.OPENWIKI_MAX_OUTPUT_TOKENS,
    NODE_OPTIONS: process.env.NODE_OPTIONS,
    hasFireworksKey: Boolean(process.env.FIREWORKS_API_KEY),
    hasAnthropicKey: Boolean(process.env.ANTHROPIC_API_KEY),
    hasMcmAnthropicKey: Boolean(process.env.MCM_ANTHROPIC_API_KEY),
    OPENWIKI_TELEMETRY_DISABLED: process.env.OPENWIKI_TELEMETRY_DISABLED,
    DO_NOT_TRACK: process.env.DO_NOT_TRACK,
  },
}));
process.exit(Number(process.env.FAKE_EXIT ?? 0));
`);
  chmodSync(bin, 0o755);
  return { dir, out };
}

function launch(env, args = []) {
  const { dir, out } = fakeGenerator();
  const r = spawnSync(process.execPath, [LAUNCHER, ...args], {
    encoding: 'utf8',
    env: { PATH: `${dir}:${process.env.PATH}`, HOME: process.env.HOME, OPENWIKI_MAX_OUTPUT_TOKENS: '16384', ...env },
  });
  const invocation = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null;
  rmSync(dir, { recursive: true, force: true });
  return { ...r, invocation };
}

test('the run message reaches the generator as exactly ONE argv element', () => {
  const message = 'Work on exactly one area: openwiki/runbooks/. Write "these" pages; and nothing $ELSE `here`.';
  const r = launch({ MCM_ANTHROPIC_API_KEY: 'k', WIKI_RUN_MESSAGE: message });
  assert.equal(r.status, 0, r.stderr);
  const [telemetryFlag, ...rest] = r.invocation.argv.slice(3);
  assert.deepEqual(r.invocation.argv.slice(0, 3), ['code', '--update', '--print']);
  assert.match(telemetryFlag, /^--telemetry-file=\S+$/);
  assert.deepEqual(rest, [message], 'no shell may split, expand or re-quote the message');
});

test('with no message the refresh is unscoped, exactly as the target always behaved', () => {
  const r = launch({ MCM_ANTHROPIC_API_KEY: 'k' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.invocation.argv.length, 4);
  assert.deepEqual(r.invocation.argv.slice(0, 3), ['code', '--update', '--print']);
  assert.match(r.invocation.argv[3], /^--telemetry-file=/, 'no message, so nothing follows the telemetry flag');
});

test('the generator runs with the resolved provider, the cap, and the usage tap loaded', () => {
  const r = launch({ MCM_WIKI_PROVIDER: 'fireworks', MCM_FIREWORKS_API_KEY: 'k', MCM_ANTHROPIC_API_KEY: 'a', MCM_WIKI_PAGE_CONCURRENCY: '3' });
  assert.equal(r.status, 0, r.stderr);
  const env = r.invocation.env;
  assert.equal(env.OPENWIKI_PROVIDER, 'fireworks');
  assert.equal(env.OPENWIKI_MODEL_ID, 'accounts/fireworks/models/deepseek-v4p1-flash');
  assert.equal(env.OPENWIKI_PAGE_CONCURRENCY, '3');
  assert.equal(env.OPENWIKI_MAX_OUTPUT_TOKENS, '65536', 'the Fireworks row raises the target\'s 16384 floor (item #719)');
  assert.equal(env.hasFireworksKey, true);
  assert.equal(env.hasAnthropicKey, false, 'least privilege');
  assert.equal(env.hasMcmAnthropicKey, false, 'least privilege');
  assert.match(env.NODE_OPTIONS, /--import=\S*wiki-usage-tap\.mjs/);
});

test('#719: the Anthropic provider launches with the target\'s 16384 cap, unraised', () => {
  const r = launch({ MCM_ANTHROPIC_API_KEY: 'k' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.invocation.env.OPENWIKI_MAX_OUTPUT_TOKENS, '16384');
});

test('the caller\'s NODE_OPTIONS (e.g. the heap flag) are kept, not replaced', () => {
  const r = launch({ MCM_ANTHROPIC_API_KEY: 'k', NODE_OPTIONS: '--max-old-space-size=8192' });
  assert.match(r.invocation.env.NODE_OPTIONS, /--max-old-space-size=8192/);
  assert.match(r.invocation.env.NODE_OPTIONS, /wiki-usage-tap\.mjs/);
});

test('a missing credential stops BEFORE the generator starts, naming the variables', () => {
  const r = launch({ MCM_WIKI_PROVIDER: 'fireworks', MCM_ANTHROPIC_API_KEY: 'secret-value' });
  assert.notEqual(r.status, 0);
  assert.equal(r.invocation, null, 'the generator must not have been started');
  assert.match(r.stderr, /MCM_FIREWORKS_API_KEY/);
  assert.doesNotMatch(`${r.stdout}${r.stderr}`, /secret-value/);
});

test('a missing output cap stops BEFORE the generator starts (the 4096 lesson)', () => {
  const r = launch({ MCM_ANTHROPIC_API_KEY: 'k', OPENWIKI_MAX_OUTPUT_TOKENS: '' });
  assert.notEqual(r.status, 0);
  assert.equal(r.invocation, null);
  assert.match(r.stderr, /OPENWIKI_MAX_OUTPUT_TOKENS/);
});

test('an unknown argument is rejected, never ignored', () => {
  // The repository's rejecting-parser rule: `--help` once built and deployed a whole stack.
  const r = launch({ MCM_ANTHROPIC_API_KEY: 'k' }, ['--dry-run']);
  assert.notEqual(r.status, 0);
  assert.equal(r.invocation, null);
});

// ── item #516: the telemetry tripwire ─────────────────────────────────────────────────────────────

test('#516: both telemetry opt-outs reach the generator even when the caller sets neither', () => {
  const r = launch({ MCM_ANTHROPIC_API_KEY: 'k' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.invocation.env.OPENWIKI_TELEMETRY_DISABLED, '1');
  assert.equal(r.invocation.env.DO_NOT_TRACK, '1');
});

test('#516: a caller that sets an opt-out to "0" is overridden, not obeyed', () => {
  const r = launch({ MCM_ANTHROPIC_API_KEY: 'k', OPENWIKI_TELEMETRY_DISABLED: '0', DO_NOT_TRACK: 'false' });
  assert.equal(r.invocation.env.OPENWIKI_TELEMETRY_DISABLED, '1');
  assert.equal(r.invocation.env.DO_NOT_TRACK, '1');
});

test('#516: a record showing the opt-out held passes, and the generator status is kept', () => {
  const ok = launch({ MCM_ANTHROPIC_API_KEY: 'k', FAKE_TELEMETRY_RECORD: '{"disabled":true,"sent":false}' });
  assert.equal(ok.status, 0, ok.stderr);
  const failed = launch({ MCM_ANTHROPIC_API_KEY: 'k', FAKE_TELEMETRY_RECORD: '{"disabled":true,"sent":false}', FAKE_EXIT: '1' });
  assert.equal(failed.status, 1);
});

test('#516: a record showing an event was SENT exits 3 and says so, even when the generator succeeded', () => {
  const r = launch({ MCM_ANTHROPIC_API_KEY: 'k', FAKE_TELEMETRY_RECORD: '{"disabled":false,"sent":true,"host":"https://example.invalid"}' });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /TELEMETRY: the opt-out did NOT hold: disabled=false sent=true/);
});

test('#516: an unreadable record fails rather than passing as "no record"', () => {
  const r = launch({ MCM_ANTHROPIC_API_KEY: 'k', FAKE_TELEMETRY_RECORD: 'not json' });
  assert.equal(r.status, 3);
});

test('#516: a run that never reached the telemetry boundary leaves no record and is not judged', () => {
  const r = launch({ MCM_ANTHROPIC_API_KEY: 'k', FAKE_EXIT: '1' });
  assert.equal(r.status, 1, 'the generator status, not the tripwire');
});

test('#516: WIKI_TELEMETRY_FILE chooses the record path, and a stale record there is removed first', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wiki-tele-'));
  const file = join(dir, 'telemetry.json');
  writeFileSync(file, '{"disabled":false,"sent":true}');
  const r = launch({ MCM_ANTHROPIC_API_KEY: 'k', WIKI_TELEMETRY_FILE: file });
  assert.equal(r.status, 0, `a stale record from an earlier run must not be judged as this run's: ${r.stderr}`);
  assert.equal(r.invocation.argv[3], `--telemetry-file=${file}`);
  rmSync(dir, { recursive: true, force: true });
});
