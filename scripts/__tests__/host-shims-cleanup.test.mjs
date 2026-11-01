// Guards item #901: a host-shim suite (and the two other measured leakers) leaves no temp root behind.
//
// makeShimEnv() writes ~20 MB per call under os.tmpdir(), and before #901 nothing removed it:
// 2,418 `host-shims-*` roots (50 GB) filled the sandbox disk on 2026-11-01. Each run below gets a
// PRIVATE TMPDIR, so the count is this run's alone — /tmp is shared with other sessions, whose
// suites would make a before/after count on it race. The probe proves the count can see a root at
// all, so a TMPDIR the helper ignored would fail here rather than read as "nothing leaked".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIM_SUITES = ['host-shims', 'backup-alert', 'backup-script', 'backup-staleness'].map((n) => join(HERE, `${n}.test.mjs`));
const HELPER = join(HERE, 'host-shims.mjs');

const OTHER_LEAKERS = ['check-toolchain-consistency', 'check-dependency-downgrade'].map((n) => join(HERE, `${n}.test.mjs`));

const roots = (dir, prefix = 'host-shims-') => readdirSync(dir).filter((n) => n.startsWith(prefix));

/** Run node --test on `files` with a fresh private TMPDIR; returns the run and what it left there. */
function runWithPrivateTmp(t, files) {
  const priv = mkdtempSync(join(tmpdir(), 'shim-guard-'));
  t.after(() => rmSync(priv, { recursive: true, force: true }));
  const before = roots(priv).length;
  // NODE_TEST_CONTEXT is dropped: inherited from this runner, it makes the child report to US over
  // IPC instead of printing, and its stdout comes back empty.
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], {
    env: { ...env, TMPDIR: priv },
    encoding: 'utf8',
  });
  return { r, before, after: roots(priv), all: readdirSync(priv) };
}

/** A throwaway test file importing the real helper, outside any private TMPDIR. */
function fixtureFile(t, name, body) {
  const dir = mkdtempSync(join(tmpdir(), 'shim-guard-fx-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const p = join(dir, name);
  writeFileSync(p, `import { test } from 'node:test';\nimport { makeShimEnv } from ${JSON.stringify(HELPER)};\n${body}\n`);
  return p;
}

test('the four host-shim suites leave as many host-shims-* roots as they found (zero)', (t) => {
  const { r, before, after } = runWithPrivateTmp(t, SHIM_SUITES);
  assert.equal(r.status, 0, `the shim suites must pass for this count to mean anything:\n${r.stdout.slice(-3000)}`);
  assert.match(r.stdout, /# fail 0/);
  assert.match(r.stdout, /# skipped 0/);
  assert.deepEqual(after, [], `leaked ${after.length} root(s); before=${before}`);
});

test('the toolchain-* and downgrade-* fixtures are removed too (5,366 toolchain roots were measured)', (t) => {
  const { r, all } = runWithPrivateTmp(t, OTHER_LEAKERS);
  assert.equal(r.status, 0, r.stdout.slice(-3000));
  assert.match(r.stdout, /# skipped 0/);
  assert.deepEqual(all.filter((n) => /^(toolchain|downgrade)-/.test(n)), []);
});

test('a FAILING test still removes its root', (t) => {
  const f = fixtureFile(t, 'fails.test.mjs', `test('boom', (t) => { makeShimEnv(t); throw new Error('boom'); });`);
  const { r, after } = runWithPrivateTmp(t, [f]);
  assert.notEqual(r.status, 0, 'the fixture test must actually fail');
  assert.match(r.stdout, /boom/);
  assert.deepEqual(after, []);
});

test('the count is not vacuous: a root exists under the private TMPDIR while its test runs', (t) => {
  const f = fixtureFile(t, 'probe.test.mjs', [
    "import assert from 'node:assert/strict';",
    "import { existsSync } from 'node:fs';",
    "test('probe', (t) => {",
    '  const env = makeShimEnv(t);',
    '  assert.ok(existsSync(env.root));',
    "  assert.ok(env.root.startsWith(process.env.TMPDIR + '/host-shims-'), env.root);",
    '});',
  ].join('\n'));
  const { r, after } = runWithPrivateTmp(t, [f]);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /# pass 1/);
  assert.deepEqual(after, []);
});

test('makeShimEnv refuses to run without a test context (a caller cannot forget the cleanup)', async () => {
  const { makeShimEnv } = await import(HELPER);
  assert.throws(() => makeShimEnv(), /pass the test context/);
  assert.throws(() => makeShimEnv({ shims: ['curl'] }), /pass the test context/);
});
