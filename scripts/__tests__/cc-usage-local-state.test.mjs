// Feature 105 — local state under $CLAUDE_CONFIG_DIR/usage (data-model.md "Local state";
// US1-AC4 offline queueing, US1-AC5 overlap safety; FR-009, FR-010).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireLock, backoffActive, log, paths, readSessionState, readSpoolDrops, releaseLock, spoolClaim,
  spoolComplete, spoolDepth, spoolRelease, spoolWrite, writeAtomic, writeBackoff, writeCwdMarker, writeSessionState,
} from '../lib/cc-usage/local-state.mjs';

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-usage-state-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SID = '11111111-1111-4111-8111-111111111111';
const batch = (n, pad = 0) => ({ sessionId: SID, range: { file: 'main', from: n * 100, to: n * 100 + 100 }, batches: { turns: [{ turn_seq: n, pad: 'p'.repeat(pad) }] } });

test('session state is written via temp-and-rename and an offset never moves backwards', () => withDir((dir) => {
  writeSessionState(dir, SID, { files: { main: { offset: 100 } }, lastShipAt: 1 });
  writeSessionState(dir, SID, { files: { main: { offset: 50 }, 'agent-x': { offset: 10 } }, lastShipAt: 2 });
  const s = readSessionState(dir, SID);
  assert.equal(s.files.main.offset, 100, 'the older, smaller offset did not win');
  assert.equal(s.files['agent-x'].offset, 10);
  assert.equal(s.lastShipAt, 2);
  assert.deepEqual(readdirSync(paths(dir).state).filter((n) => n.includes('.tmp')), [], 'no temp file left behind');
  assert.equal(readSessionState(dir, 'no-such-session'), null);
}));

test('writeAtomic can set mode 0600', () => withDir((dir) => {
  const f = join(dir, 'secret.json');
  writeAtomic(f, '{}', { mode: 0o600 });
  assert.equal(statSync(f).mode & 0o777, 0o600);
}));

test('a lock is taken once, refused while fresh, and reclaimable after expiry', () => withDir((dir) => {
  assert.equal(acquireLock(dir, 'sweep', { now: 1000, ttlMs: 60_000 }), true);
  assert.equal(acquireLock(dir, 'sweep', { now: 2000, ttlMs: 60_000 }), false);
  assert.equal(acquireLock(dir, 'sweep', { now: 1000 + 60_001, ttlMs: 60_000 }), true, 'stale lock reclaimed');
  releaseLock(dir, 'sweep');
  assert.equal(acquireLock(dir, 'sweep', { now: 70_000, ttlMs: 60_000 }), true, 'released lock is free');
}));

test('a spool file is claimed by rename and removed only after a confirmed send', () => withDir((dir) => {
  spoolWrite(dir, batch(1), { configured: true, now: 1 });
  assert.equal(spoolDepth(dir).files, 1);
  const [claim] = spoolClaim(dir, { sessionId: SID });
  assert.equal(claim.entry.range.from, 100);
  assert.match(claim.claimedPath, /\.claimed-\d+$/);
  assert.deepEqual(spoolClaim(dir, { sessionId: SID }), [], 'a claimed file is not claimable twice');
  spoolRelease(claim.claimedPath);
  const [again] = spoolClaim(dir, { sessionId: SID });
  assert.ok(again, 'a released claim (send failed) is back in the spool');
  spoolComplete(again.claimedPath);
  assert.equal(spoolDepth(dir).files, 0);
}));

test('spool claims come oldest first and can be limited to one session', () => withDir((dir) => {
  spoolWrite(dir, batch(1), { configured: true, now: 10 });
  spoolWrite(dir, { ...batch(2), sessionId: '22222222-2222-4222-8222-222222222222' }, { configured: true, now: 20 });
  spoolWrite(dir, batch(3), { configured: true, now: 30 });
  assert.deepEqual(spoolClaim(dir, { sessionId: SID }).map((c) => c.entry.range.from), [100, 300]);
}));

test('the spool never exceeds its cap: the oldest files go first and each drop is recorded', () => withDir((dir) => {
  const cap = 1500;
  for (let n = 1; n <= 5; n++) spoolWrite(dir, batch(n, 300), { configured: true, now: n, capBytes: cap });
  const depth = spoolDepth(dir);
  assert.ok(depth.bytes <= cap, `spool ${depth.bytes} > cap ${cap}`);
  const drops = readSpoolDrops(dir);
  assert.ok(drops.length >= 1);
  assert.deepEqual(drops[0], { sessionId: SID, range: { file: 'main', from: 100, to: 200 }, at: new Date(drops[0].at).toISOString() });
  const kept = spoolClaim(dir, {}).map((c) => c.entry.range.from);
  assert.equal(kept.at(-1), 500, 'the newest batch is kept');
  assert.ok(!kept.includes(100), 'the oldest batch was dropped');
}));

test('nothing is spooled when capture is not configured (FR-010)', () => withDir((dir) => {
  spoolWrite(dir, batch(1), { configured: false, now: 1 });
  assert.equal(spoolDepth(dir).files, 0);
  assert.equal(existsSync(paths(dir).spool), false);
}));

test('a fresh back-off marker suppresses network use; an old one does not', () => withDir((dir) => {
  assert.equal(backoffActive(dir, { now: 0 }), false);
  writeBackoff(dir, 1_000_000);
  assert.equal(backoffActive(dir, { now: 1_000_000 + 1000, windowMs: 300_000 }), true);
  assert.equal(backoffActive(dir, { now: 1_000_000 + 300_001, windowMs: 300_000 }), false);
}));

test('the log is JSON lines, size-capped and rotated, and logging never throws', () => withDir((dir) => {
  for (let i = 0; i < 200; i++) log(dir, { level: 'info', msg: 'shipped', session_id: SID, n: i }, { capBytes: 2000 });
  const p = paths(dir);
  assert.ok(statSync(p.log).size <= 2000 + 300, 'current log stays near the cap');
  assert.ok(existsSync(`${p.log}.1`), 'rotated once');
  const line = JSON.parse(readFileSync(p.log, 'utf8').trim().split('\n').at(-1));
  assert.equal(line.service, 'cc-usage');
  assert.equal(line.session_id, SID);
  assert.match(line.ts, /Z$/);
  assert.doesNotThrow(() => log(join(dir, 'missing', '\0bad'), { msg: 'x' }));
}));

test('the by-cwd marker names a hash, never the path', () => withDir((dir) => {
  writeCwdMarker(dir, '/home/coder/worktrees/feat-a', SID, 5);
  const names = readdirSync(join(paths(dir).state, 'by-cwd'));
  assert.equal(names.length, 1);
  assert.match(names[0], /^[0-9a-f]{16}\.json$/);
}));
