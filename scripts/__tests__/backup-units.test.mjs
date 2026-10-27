// The systemd units that turn a backup problem into an alert (spec 084 FR-001/FR-002, research R2/R3).
//
// The July outage's unit had no OnFailure= and no timeout: a failure was a journal line, and a hang
// would have been nothing at all. These guards pin the wiring the scripts depend on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../infrastructure-as-code/backup');

/** A unit file as { Section: { Key: [values…] } }; systemd keys may repeat. */
function unit(name) {
  const path = join(DIR, name);
  assert.ok(existsSync(path), `${name} does not exist`);
  const out = {};
  let section = null;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const s = line.match(/^\[(.+)\]$/);
    if (s) { section = s[1]; out[section] ??= {}; continue; }
    const [k, ...v] = line.split('=');
    (out[section][k.trim()] ??= []).push(v.join('=').trim());
  }
  return out;
}

test('the backup unit alerts on failure, and a hang becomes a failure after 2 h', () => {
  const u = unit('homelab-backup.service');
  assert.deepEqual(u.Unit.OnFailure, ['homelab-backup-alert@%n.service']);
  assert.deepEqual(u.Service.TimeoutStartSec, ['2h']);
  assert.deepEqual(u.Service.Type, ['oneshot']);
  assert.deepEqual(u.Service.ExecStart, ['/home/prod/backup/backup.sh']);
});

test('the alert unit is a template that reports the failed unit by name', () => {
  const u = unit('homelab-backup-alert@.service');
  assert.deepEqual(u.Service.Type, ['oneshot']);
  assert.deepEqual(u.Service.ExecStart, ['/home/prod/backup/backup-alert.sh failed %i']);
  assert.equal(u.Unit.OnFailure, undefined, 'an alert that fails must not recurse into another alert');
});

test('the staleness check runs every 6 h, catches up after downtime, and is enabled by timers.target', () => {
  const t = unit('homelab-backup-staleness.timer');
  assert.deepEqual(t.Timer.OnCalendar, ['*-*-* 00/6:15:00']);
  assert.deepEqual(t.Timer.Persistent, ['true']);
  assert.deepEqual(t.Install.WantedBy, ['timers.target']);
  const s = unit('homelab-backup-staleness.service');
  assert.deepEqual(s.Service.Type, ['oneshot']);
  assert.deepEqual(s.Service.ExecStart, ['/home/prod/backup/backup-staleness.sh']);
  assert.equal(s.Unit?.OnFailure, undefined, 'it alerts by itself; OnFailure would double-report every stale check');
});

test('the nightly timer keeps 03:30 and catches up a missed night', () => {
  const t = unit('homelab-backup.timer');
  assert.deepEqual(t.Timer.OnCalendar, ['*-*-* 03:30:00']);
  assert.deepEqual(t.Timer.Persistent, ['true']);
});
