// Feature 082 D1: ONE drift comparison, shared by V12 (check-openwiki-okf), verifySlice's stale-page
// check (wiki-maintain #587/#616) and the drift planner, so the three cannot disagree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sourceCommitAfterStamp } from '../openwiki-drift.mjs';

/** A repo whose `docs/a.md` and `specs/x/spec.md` are committed at a fixed date. */
function repo(date = '2026-10-01T12:00:00Z') {
  const root = mkdtempSync(join(tmpdir(), 'drift-'));
  const git = (...args) => spawnSync('git', args, { cwd: root, env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } });
  git('init', '-q');
  git('config', 'user.email', 't@example.invalid');
  git('config', 'user.name', 't');
  mkdirSync(join(root, 'docs'));
  mkdirSync(join(root, 'specs', 'x'), { recursive: true });
  writeFileSync(join(root, 'docs', 'a.md'), 'a\n');
  writeFileSync(join(root, 'specs', 'x', 'spec.md'), 's\n');
  git('add', '-A');
  git('commit', '-qm', 'sources');
  return root;
}

test('082 D1: a source committed after the stamp is stale, one committed before is not', () => {
  const root = repo();
  try {
    const before = sourceCommitAfterStamp({ root, fields: { resource: 'docs/a.md', timestamp: '2026-09-30T00:00:00Z' } });
    assert.equal(before.stale, true);
    assert.equal(before.source, 'docs/a.md');
    assert.equal(before.directory, false);
    const after = sourceCommitAfterStamp({ root, fields: { resource: 'docs/a.md', timestamp: '2026-10-02T00:00:00Z' } });
    assert.equal(after.stale, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('082 D1: the stamp is the NEWEST of generated.at, verified.at and timestamp', () => {
  const root = repo();
  try {
    const r = sourceCommitAfterStamp({ root, fields: {
      resource: 'docs/a.md', timestamp: '2026-09-01T00:00:00Z',
      generated: { by: 'x', at: '2026-09-15T00:00:00Z' }, verified: [{ by: 'x', at: '2026-10-05T00:00:00Z' }],
    } });
    assert.equal(r.stale, false, 'verified.at after the commit wins');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('082 D1: an untracked source cannot be judged unless the caller asks for the mtime fallback (V12 only)', () => {
  const root = repo();
  try {
    writeFileSync(join(root, 'docs', 'new.md'), 'n\n');
    const fields = { resource: 'docs/new.md', timestamp: '2000-01-01T00:00:00Z' };
    assert.equal(sourceCommitAfterStamp({ root, fields }), null);
    assert.equal(sourceCommitAfterStamp({ root, fields, fallbackToMtime: true }).stale, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('082 D1: an external, absent or missing resource cannot be judged; a missing stamp is unstampable', () => {
  const root = repo();
  try {
    assert.equal(sourceCommitAfterStamp({ root, fields: { timestamp: '2026-09-30T00:00:00Z' } }), null);
    assert.equal(sourceCommitAfterStamp({ root, fields: { resource: 'https://example.com/x', timestamp: '2026-09-30T00:00:00Z' } }), null);
    assert.equal(sourceCommitAfterStamp({ root, fields: { resource: 'docs/gone.md', timestamp: '2026-09-30T00:00:00Z' } }), null);
    assert.deepEqual(sourceCommitAfterStamp({ root, fields: { resource: 'docs/a.md' } }), { unstampable: true, source: 'docs/a.md' });
    assert.deepEqual(sourceCommitAfterStamp({ root, fields: { resource: 'docs/a.md', timestamp: 'not a date' } }), { unstampable: true, source: 'docs/a.md' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('082 D1: a directory resource is judged by its newest commit and flagged as a directory', () => {
  const root = repo();
  try {
    const r = sourceCommitAfterStamp({ root, fields: { resource: 'specs/', timestamp: '2026-09-30T00:00:00Z' } });
    assert.deepEqual([r.stale, r.directory, r.source], [true, true, 'specs/']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('082 D1: a fragment or query on the resource is ignored', () => {
  const root = repo();
  try {
    const r = sourceCommitAfterStamp({ root, fields: { resource: 'docs/a.md#section?x=1', timestamp: '2026-09-30T00:00:00Z' } });
    assert.deepEqual([r.stale, r.source], [true, 'docs/a.md']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
