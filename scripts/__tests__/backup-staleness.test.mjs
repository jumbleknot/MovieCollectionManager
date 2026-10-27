// infrastructure-as-code/backup/backup-staleness.sh — the check that does NOT depend on the backup
// run reporting its own failure (spec 084 FR-002, research R3).
//
// A run that hangs, a timer that stops, an upload that silently does nothing: none of them fires
// OnFailure. This script reads the newest snapshot's age from the backup repository itself and
// alerts past 36 h. Anything it cannot read is ALSO an alert — "could not tell" must never read as
// "fresh", which is the false green this feature exists to remove.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeShimEnv } from './host-shims.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BACKUP_DIR = resolve(REPO_ROOT, 'infrastructure-as-code/backup');
const SCRIPT = join(BACKUP_DIR, 'backup-staleness.sh');

const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString().replace('Z', '123+00:00');

/** restic's snapshot JSON: nanosecond fractions and an explicit offset, newest NOT first. */
const snapshots = (...ages) => JSON.stringify(ages.map((h, i) => ({
  time: hoursAgo(h).replace(/\.(\d{3})/, '.$1456789'),
  short_id: `snap${i}`,
  tags: ['homelab'],
})));

function staleHost(resticFixture) {
  const env = makeShimEnv({ shims: ['restic'] });
  env.setFixtures([{ cmd: 'restic', ...resticFixture }]);
  const log = join(env.home, 'alerts.log');
  const stub = join(env.home, 'backup/backup-alert.sh');
  writeFileSync(stub, `#!/usr/bin/env bash\n{ echo "ALERT $1"; [ -f "\${2:-}" ] && cat "$2"; } >> "${log}"\n`);
  chmodSync(stub, 0o755);
  return { env, alerts: () => (existsSync(log) ? readFileSync(log, 'utf8') : '') };
}

test('a newest snapshot under 36 h old passes quietly', () => {
  const h = staleHost({ stdout: snapshots(50, 2, 26) });
  const r = h.env.run(SCRIPT);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /snap1/);
  assert.equal(h.alerts(), '');
});

test('a newest snapshot over 36 h old alerts stale, naming its age', () => {
  const h = staleHost({ stdout: snapshots(80, 37) });
  const r = h.env.run(SCRIPT);
  assert.equal(r.status, 1);
  assert.match(h.alerts(), /^ALERT stale$/m);
  assert.match(h.alerts(), /snap1 .* 37 h old/);
});

test('it reads the newest homelab snapshot itself, from every group (the staging path is random)', () => {
  const h = staleHost({ stdout: snapshots(2) });
  h.env.run(SCRIPT);
  const [call] = h.env.calls();
  assert.deepEqual(call.argv.slice(0, 1), ['snapshots']);
  assert.ok(call.argv.includes('--json'));
  assert.ok(call.argv.join(' ').includes('--tag homelab'));
  assert.ok(!call.argv.includes('--latest'), '--latest is per path group, and the path is random');
});

test('anything it cannot read is staleness-unreadable — never fresh', () => {
  for (const [why, fixture] of [
    ['restic fails', { stderr: 'Fatal: unable to open repository', exit: 1 }],
    ['no snapshot at all', { stdout: '[]' }],
    ['an unparsable time', { stdout: JSON.stringify([{ time: 'yesterday', short_id: 'x' }]) }],
    ['not JSON', { stdout: 'oops' }],
  ]) {
    const h = staleHost(fixture);
    const r = h.env.run(SCRIPT);
    assert.equal(r.status, 1, `${why}: ${r.stdout}${r.stderr}`);
    assert.match(h.alerts(), /^ALERT staleness-unreadable$/m, why);
  }
});

test('MCM_BACKUP_STALE_HOURS (tests only) moves the threshold, and no unit sets it', () => {
  const h = staleHost({ stdout: snapshots(2) });
  assert.equal(h.env.run(SCRIPT, [], { MCM_BACKUP_STALE_HOURS: '1' }).status, 1);
  assert.match(h.alerts(), /^ALERT stale$/m);
  for (const unit of readdirSync(BACKUP_DIR).filter((f) => /\.(service|timer)$/.test(f))) {
    assert.doesNotMatch(readFileSync(join(BACKUP_DIR, unit), 'utf8'), /MCM_BACKUP_STALE_HOURS/, unit);
  }
});

test('an argument is refused: the check takes none', () => {
  const h = staleHost({ stdout: snapshots(2) });
  const r = h.env.run(SCRIPT, ['--hours', '1']);
  assert.equal(r.status, 2);
  assert.deepEqual(h.env.calls(), []);
});
