// The `maestro-debug` artifact must carry THIS run's Maestro output, not the CI host's history.
//
// app-e2e runs ON the ci host (`runs-on: kvm`), so `~/.maestro/tests` is the ci user's persistent
// home directory, and Maestro only prunes it at ~14 days. The upload used to take
// `~/.maestro/tests/**` whole, so every failure re-shipped every earlier run. Measured 2026-10-26
// from the forge database (spec 084 FR-019b): rows per upload went 6, 9, 12, 15, 18 … 5,819 — three
// more each run — and `maestro-debug` reached 330,497 rows / 11 GB, half of all Actions artifacts and
// half of the nightly backup. The host directory held 967 entries / 5.8 G.
//
// `scripts/ci-maestro-debug.sh start` marks the run's start; `collect` copies only entries newer
// than the mark into the staging directory the upload reads. Pinned here by RUNNING it, plus a guard
// that the workflow is wired to it rather than back to the home directory.
//
// Deterministic, offline, node: built-ins only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = resolve(REPO_ROOT, 'scripts/ci-maestro-debug.sh');

/** A fake ci HOME holding two OLD Maestro run directories (an hour ago), and a work dir. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'maestro-debug-'));
  const home = join(root, 'home');
  const work = join(root, 'work');
  mkdirSync(work, { recursive: true });
  const past = new Date(Date.now() - 3600_000);
  for (const name of ['2026-10-12_232420', '2026-10-12_232445']) {
    const d = join(home, '.maestro/tests', name);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'screenshot.png'), 'old');
    utimesSync(join(d, 'screenshot.png'), past, past);
    utimesSync(d, past, past);
  }
  return { home, work };
}

const run = (args, { home, work }) =>
  spawnSync('bash', [SCRIPT, ...args], { cwd: work, env: { ...process.env, HOME: home }, encoding: 'utf8' });

/** A Maestro run that happens after `start` — dated a minute ahead so mtime ordering is unambiguous. */
function newRun({ home }, name) {
  const d = join(home, '.maestro/tests', name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'commands.json'), 'new');
  const future = new Date(Date.now() + 60_000);
  utimesSync(join(d, 'commands.json'), future, future);
  utimesSync(d, future, future);
}

test('collect stages ONLY the Maestro runs made after start, never the host history', () => {
  const fx = fixture();
  assert.equal(run(['start'], fx).status, 0);
  newRun(fx, '2026-10-26_000621');
  newRun(fx, '2026-10-26_000700');
  const r = run(['collect'], fx);
  assert.equal(r.status, 0, r.stderr);
  const staged = readdirSync(join(fx.work, 'maestro-debug/tests')).sort();
  assert.deepEqual(staged, ['2026-10-26_000621', '2026-10-26_000700']);
  assert.equal(readFileSync(join(fx.work, 'maestro-debug/tests/2026-10-26_000621/commands.json'), 'utf8'), 'new');
});

test('collect with no new runs stages nothing, and says so (an empty artifact is the right answer)', () => {
  const fx = fixture();
  assert.equal(run(['start'], fx).status, 0);
  const r = run(['collect'], fx);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(join(fx.work, 'maestro-debug/tests')), []);
  assert.match(r.stdout, /0 Maestro run\(s\)/);
});

test('start clears a staging directory left by an earlier run in a reused workspace', () => {
  const fx = fixture();
  mkdirSync(join(fx.work, 'maestro-debug/tests/stale'), { recursive: true });
  assert.equal(run(['start'], fx).status, 0);
  assert.equal(existsSync(join(fx.work, 'maestro-debug/tests/stale')), false);
});

test('collect without a start mark never falls back to the whole history, and never fails the job', () => {
  const fx = fixture();
  const r = run(['collect'], fx);
  assert.equal(r.status, 0, 'a diagnostic step must not change the job outcome');
  assert.match(r.stdout, /no start mark/);
  assert.equal(existsSync(join(fx.work, 'maestro-debug/tests/2026-10-12_232420')), false);
});

test('an unknown or missing subcommand is REJECTED, not treated as one of the two', () => {
  const fx = fixture();
  for (const args of [[], ['--help'], ['collect', 'extra'], ['strat']]) {
    const r = run(args, fx);
    assert.equal(r.status, 2, `args ${JSON.stringify(args)} must exit 2, got ${r.status}`);
    assert.match(r.stderr, /usage/);
  }
});

// ── The workflow is wired to the script, not to the home directory ─────────────────────────────

const workflow = parseYaml(readFileSync(resolve(REPO_ROOT, '.forgejo/workflows/app-ci.yml'), 'utf8'));
const steps = workflow.jobs['app-e2e'].steps;
const idx = (pred) => steps.findIndex(pred);
const uploadIdx = idx((s) => s.with?.name === 'maestro-debug');
const upload = steps[uploadIdx];

test('the maestro-debug upload reads the staged directory, never ~/.maestro', () => {
  assert.ok(upload, 'no maestro-debug upload step in app-e2e');
  assert.doesNotMatch(String(upload.with.path), /\.maestro/);
  assert.equal(upload.with.path, 'maestro-debug/tests/**');
});

test('collect runs just before the upload, under the same condition', () => {
  const c = steps[uploadIdx - 1];
  assert.match(String(c?.run), /scripts\/ci-maestro-debug\.sh collect/);
  assert.equal(c.if, upload.if, 'collect must run whenever the upload does');
});

test('start runs in the Install Maestro step, before any Maestro flow can write output', () => {
  const startIdx = idx((s) => /scripts\/ci-maestro-debug\.sh start/.test(String(s.run)));
  const firstFlow = idx((s) => /ci-mobile-(agent|full)-flows\.sh|maestro test/.test(String(s.run)));
  assert.ok(startIdx >= 0, 'nothing runs `ci-maestro-debug.sh start`');
  assert.equal(steps[startIdx].name, 'Install Maestro');
  assert.ok(firstFlow > startIdx, 'the start mark must precede the first Maestro flow');
});
