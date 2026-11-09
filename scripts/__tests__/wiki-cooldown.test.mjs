// Feature 078 US7 (amendment 2026-11-09, research R21): a page under a refresh COOLDOWN is not
// re-planned by a source change, or by drift, until `days` have passed since it last landed. The
// skipped change is not lost: once the cooldown expires the page is stale by the V12 rule, and drift
// plans it. Backlog work (a failed or budget-deferred page) is never held.
//
// Fixtures are real git repositories with chosen commit dates, as in wiki-drift-plan.test.mjs, and the
// planner's clock is injected (`now`). Offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as mod from '../wiki-maintain.mjs';

const NOW = '2026-11-09T00:00:00Z';
const RECENT = '2026-11-07T00:00:00Z'; // 2 days before NOW: inside a 7-day cooldown
const EXPIRED = '2026-10-30T00:00:00Z'; // 10 days before NOW: past it
const page = (name, stamp) =>
  `---\ntype: Runbook\ntitle: ${name}\ndescription: Fixture.\nresource: docs/runbooks/${name}\ntimestamp: ${stamp}\n---\nBody.\n`;

/** One concept per entry, each citing docs/runbooks/<name>, its source committed at `sourceAt`; marker = HEAD. */
function repo(pages) {
  const root = mkdtempSync(join(tmpdir(), 'wiki-cooldown-'));
  const g = (args, date = '2026-09-01T00:00:00Z') => spawnSync('git', args, {
    cwd: root, encoding: 'utf8', env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date },
  });
  g(['init', '-q']);
  g(['config', 'user.email', 't@example.invalid']);
  g(['config', 'user.name', 't']);
  mkdirSync(join(root, 'docs', 'runbooks'), { recursive: true });
  mkdirSync(join(root, 'openwiki', 'runbooks'), { recursive: true });
  writeFileSync(join(root, 'openwiki', 'index.md'), '---\nokf_version: "0.1"\n---\n# Bundle\n- [runbooks](runbooks/index.md)\n');
  writeFileSync(join(root, 'openwiki', 'runbooks', 'index.md'), `# Runbooks\n${pages.map((p) => `- [${p.name}](${p.name})`).join('\n')}\n`);
  for (const { name, stamp } of pages) writeFileSync(join(root, 'openwiki', 'runbooks', name), page(name, stamp));
  g(['add', '-A']);
  g(['commit', '-qm', 'bundle']);
  for (const { name, sourceAt = '2026-06-01T00:00:00Z' } of pages) {
    writeFileSync(join(root, 'docs', 'runbooks', name), `# ${name}\n`);
    g(['add', '-A']);
    g(['commit', '-qm', `source ${name}`], sourceAt);
  }
  return { root, head: g(['rev-parse', 'HEAD']).stdout.trim(), g };
}

const plan = (root, record) => mod.computePlan({ root, bundleRoot: join(root, 'openwiki'), record, policy: null, now: () => NOW });
const planned = (p) => p.slices.flatMap((s) => s.pages.map((x) => `${s.area}/${x}`));
const cd = (days = 7, item = 977) => ({ days, item, since: '2026-11-09', reason: 'high churn (R21)' });
const changeAfterMarker = (root, g, names) => {
  for (const n of names) writeFileSync(join(root, 'docs', 'runbooks', n), `# ${n} changed\n`);
  g(['commit', '-qam', 'change after the marker'], '2026-11-08T12:00:00Z');
};

test('US7 FR-025/026: a cooled page with a changed source is not planned, and the plan says until when', () => {
  const { root, head, g } = repo([{ name: 'a.md', stamp: RECENT }, { name: 'b.md', stamp: RECENT }]);
  try {
    changeAfterMarker(root, g, ['a.md', 'b.md']);
    const p = plan(root, { coveredCommit: head, cooldowns: { 'runbooks/a.md': cd() } });
    assert.deepEqual(planned(p), ['runbooks/b.md'], 'b (no cooldown) is planned; cooled a is not');
    assert.deepEqual(p.cooldowns.held, [{ page: 'runbooks/a.md', days: 7, item: 977, plannableFrom: '2026-11-14T00:00:00.000Z' }]);
    assert.deepEqual(p.cooldowns.orphans, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('US7 FR-025: backlog work for a cooled page is still planned — a cooldown never holds a retry', () => {
  const { root, head } = repo([{ name: 'a.md', stamp: RECENT }]);
  try {
    const p = plan(root, {
      coveredCommit: head,
      backlog: [{ area: 'runbooks', pages: ['a.md'], reason: 'carried forward' }],
      cooldowns: { 'runbooks/a.md': cd() },
    });
    assert.deepEqual(planned(p), ['runbooks/a.md']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('US7 FR-025: drift does not plan a cooled page inside its window, and does once it expires — the skipped change is caught up', () => {
  // Both pages are stale: the source was committed after the stamp, behind the marker.
  const { root, head } = repo([
    { name: 'held.md', stamp: RECENT, sourceAt: '2026-11-08T00:00:00Z' },
    { name: 'free.md', stamp: EXPIRED, sourceAt: '2026-10-31T00:00:00Z' },
  ]);
  try {
    const p = plan(root, { coveredCommit: head, cooldowns: { 'runbooks/held.md': cd(), 'runbooks/free.md': cd() } });
    assert.deepEqual(p.drift.planned, ['runbooks/free.md'], 'expired: drift catches it up; inside the window: held');
    assert.deepEqual(p.cooldowns.held.map((h) => h.page), ['runbooks/held.md']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('US7 FR-025: an expired cooldown does not block a change-driven refresh either', () => {
  const { root, head, g } = repo([{ name: 'a.md', stamp: EXPIRED }]);
  try {
    changeAfterMarker(root, g, ['a.md']);
    assert.deepEqual(planned(plan(root, { coveredCommit: head, cooldowns: { 'runbooks/a.md': cd() } })), ['runbooks/a.md']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('US7 FR-026: a cooldown on a page that does not exist is reported as an orphan, not fatal', () => {
  const { root, head } = repo([]);
  try {
    const p = plan(root, { coveredCommit: head, cooldowns: { 'runbooks/gone.md': cd() } });
    assert.deepEqual(p.cooldowns.orphans, ['runbooks/gone.md']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('US7 FR-026: --plan prints held pages and orphans, even when nothing is planned', () => {
  const lines = [];
  const orig = console.log;
  console.log = (l) => lines.push(l);
  try {
    mod.reportPlan({
      sinceCommit: 'a'.repeat(40), baseCommit: 'b'.repeat(40), changedPaths: [], slices: [], onProposal: [],
      cooldowns: { held: [{ page: 'runbooks/a.md', days: 7, item: 977, plannableFrom: '2026-11-14T00:00:00.000Z' }], orphans: ['runbooks/gone.md'] },
    }, { json: false });
  } finally { console.log = orig; }
  const out = lines.join('\n');
  assert.match(out, /cooldown: 1 held/);
  assert.match(out, /held\s+runbooks\/a\.md \(7-day cooldown, item #977\) plannable from 2026-11-14/);
  assert.match(out, /cooldown, page gone\s+runbooks\/gone\.md/);
});

test('US7 FR-027: a malformed cooldowns entry is refused when the record is written; a valid one round-trips', () => {
  const root = mkdtempSync(join(tmpdir(), 'wiki-cooldown-rec-'));
  try {
    for (const bad of [
      [],
      { 'runbooks/a': cd() },
      { 'runbooks/a.md': { ...cd(), days: 0 } },
      { 'runbooks/a.md': { ...cd(), days: 31 } },
      { 'runbooks/a.md': { ...cd(), days: 1.5 } },
      { 'runbooks/a.md': { ...cd(), item: '977' } },
      { 'runbooks/a.md': { days: 7, item: 977 } },
    ]) assert.throws(() => mod.writeRunRecord(root, { cooldowns: bad }), /cooldowns/, JSON.stringify(bad));
    mod.writeRunRecord(root, { cooldowns: { 'runbooks/a.md': cd() } });
    assert.deepEqual(mod.readRunRecord(root).cooldowns, { 'runbooks/a.md': cd() });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('US7: the record merge keeps a cooldown either side added (#748: overlapping runs never erase a reviewed entry)', () => {
  const base = { coveredCommit: 'a', cooldowns: {} };
  const ours = { coveredCommit: 'b', cooldowns: { 'runbooks/a.md': cd() } };
  const theirs = { coveredCommit: 'a', cooldowns: { 'runbooks/b.md': cd(14) } };
  const { record, conflicts } = mod.mergeRunRecords({ base, ours, theirs });
  assert.deepEqual(conflicts, []);
  assert.deepEqual(record.cooldowns, { 'runbooks/a.md': cd(), 'runbooks/b.md': cd(14) });
});
