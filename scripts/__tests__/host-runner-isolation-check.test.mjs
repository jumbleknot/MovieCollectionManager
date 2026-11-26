// scripts/host-runner-isolation-check.sh (item #1142) — the measurement for "another project's CI left
// nothing in MCM's runner user". Its checks read the CI host (journal, daemon, $HOME), so they are proven
// there: before the switch it reported NOT ISOLATED with three FAILs (2026-11-26, see item #1142). What
// is pinned here, offline, is that a bad invocation is a usage error and never a verdict: a mistyped
// --since must not quietly measure "since the beginning of time" or "since nothing".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'host-runner-isolation-check.sh');
const run = (...args) => spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8' });

test('a missing, malformed or non-UTC --since is a usage error (2), not a measurement', () => {
  for (const args of [[], ['--since'], ['--since', '2026-12-01'], ['--since', '2026-12-01T10:00:00+01:00'], ['--since', 'yesterday']]) {
    const r = run(...args);
    assert.equal(r.status, 2, `${JSON.stringify(args)}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /usage:/);
    assert.doesNotMatch(r.stdout, /PASS|FAIL/);
  }
});

test('an unknown argument or an empty --project is refused before anything is read', () => {
  assert.equal(run('--since', '2026-12-01T10:00:00Z', '--dry-run').status, 2);
  assert.equal(run('--since', '2026-12-01T10:00:00Z', '--project', '').status, 2);
});

test('--help prints the header and measures nothing', () => {
  const r = run('--help');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--since <ISO-8601 UTC>/);
  assert.doesNotMatch(r.stdout, /^(PASS|FAIL)/m);
});
