// Feature 082 (item #526): concepts that fell behind the run-record marker are re-planned, a bounded
// number per run, and parking is a recorded state that planning respects.
//
// Every fixture is a real git repository whose source commits carry chosen dates, so the drift
// comparison (scripts/openwiki-drift.mjs, shared with V12) runs exactly as in production. Offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as mod from '../wiki-maintain.mjs';

const OLD_STAMP = '2026-01-01T00:00:00Z';
const page = (name, stamp, resource = `docs/runbooks/${name}`) =>
  `---\ntype: Runbook\ntitle: ${name}\ndescription: Fixture.\nresource: ${resource}\ntimestamp: ${stamp}\n---\nBody.\n`;

/**
 * A repo with one concept per entry of `pages`, each citing `docs/runbooks/<name>`. A source is
 * committed at `sourceAt` (default after the stamp, so the page is drifted); the marker is HEAD, so
 * every source change is BEHIND it — the ratchet case. `extra` pages are written as given.
 */
function driftRepo(pages, { extra = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wiki-drift-'));
  const g = (args, date = '2026-09-01T00:00:00Z') => spawnSync('git', args, {
    cwd: root, encoding: 'utf8', env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date },
  });
  g(['init', '-q']);
  g(['config', 'user.email', 't@example.invalid']);
  g(['config', 'user.name', 't']);
  mkdirSync(join(root, 'docs', 'runbooks'), { recursive: true });
  mkdirSync(join(root, 'openwiki', 'runbooks'), { recursive: true });
  const names = [...pages.map((p) => p.name), ...Object.keys(extra)];
  writeFileSync(join(root, 'openwiki', 'index.md'), '---\nokf_version: "0.1"\n---\n# Bundle\n- [runbooks](runbooks/index.md)\n');
  writeFileSync(join(root, 'openwiki', 'runbooks', 'index.md'), `# Runbooks\n${names.map((n) => `- [${n}](${n})`).join('\n')}\n`);
  for (const { name, stamp = OLD_STAMP } of pages) writeFileSync(join(root, 'openwiki', 'runbooks', name), page(name, stamp));
  for (const [name, text] of Object.entries(extra)) writeFileSync(join(root, 'openwiki', 'runbooks', name), text);
  g(['add', '-A']);
  g(['commit', '-qm', 'bundle']);
  for (const { name, sourceAt = '2026-06-01T00:00:00Z' } of pages) {
    writeFileSync(join(root, 'docs', 'runbooks', name), `# ${name}\n`);
    g(['add', '-A']);
    g(['commit', '-qm', `source ${name}`], sourceAt);
  }
  const head = g(['rev-parse', 'HEAD']).stdout.trim();
  return { root, head, g };
}

const plan = (root, record) => mod.computePlan({ root, bundleRoot: join(root, 'openwiki'), record, policy: null });
const plannedPages = (p) => p.slices.flatMap((s) => s.pages.map((x) => `${s.area}/${x}`));
const parkedEntry = (item = 719) => ({ item, since: '2026-10-10', reason: 'worker exits without submitting' });

// ── US2: parking is a recorded state ───────────────────────────────────────────────────────────

test('082 US2: a parked page is not planned from a NEW source change, nor from the backlog, and is listed', () => {
  const { root, head, g } = driftRepo([{ name: 'a.md', stamp: '2026-12-01T00:00:00Z' }, { name: 'b.md', stamp: '2026-12-01T00:00:00Z' }]);
  try {
    writeFileSync(join(root, 'docs', 'runbooks', 'a.md'), '# a changed\n');
    writeFileSync(join(root, 'docs', 'runbooks', 'b.md'), '# b changed\n');
    g(['commit', '-qam', 'change after the marker']);
    const p = plan(root, {
      coveredCommit: head,
      backlog: [{ area: 'runbooks', pages: ['a.md'], reason: 'carried forward' }],
      parked: { 'runbooks/a.md': parkedEntry() },
    });
    assert.deepEqual(plannedPages(p), ['runbooks/b.md'], 'b is planned; parked a is not, from either route');
    assert.deepEqual(p.drift.parked, [{ page: 'runbooks/a.md', item: 719, since: '2026-10-10', reason: 'worker exits without submitting' }]);
    assert.deepEqual(p.drift.parkedOrphans, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('082 US2: a parked entry whose page is gone is reported as orphaned, not fatal', () => {
  const { root, head } = driftRepo([]);
  try {
    const p = plan(root, { coveredCommit: head, parked: { 'runbooks/gone.md': parkedEntry() } });
    assert.deepEqual(p.drift.parkedOrphans, ['runbooks/gone.md']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('082 US2: a malformed parked entry is refused when the record is written', () => {
  const root = mkdtempSync(join(tmpdir(), 'wiki-parked-'));
  try {
    assert.throws(() => mod.writeRunRecord(root, { parked: { 'runbooks/a.md': { reason: 'no item' } } }), /parked/);
    assert.throws(() => mod.writeRunRecord(root, { parked: [] }), /parked/);
    mod.writeRunRecord(root, { parked: { 'runbooks/a.md': parkedEntry() } });
    assert.deepEqual(mod.readRunRecord(root).parked, { 'runbooks/a.md': parkedEntry() }, 'and survives a round trip');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── US1: bounded drift slices ──────────────────────────────────────────────────────────────────

test('082 US1: a page stale BEHIND the marker, not queued and not parked, is planned as drift', () => {
  const { root, head } = driftRepo([{ name: 'a.md' }, { name: 'fresh.md', stamp: '2026-12-01T00:00:00Z' }]);
  try {
    const p = plan(root, { coveredCommit: head, backlog: [] });
    assert.deepEqual(plannedPages(p), ['runbooks/a.md'], 'only the drifted page; the fresh one is not stale');
    assert.equal(p.slices[0].drift, true);
    assert.equal(p.slices[0].kind, 'refresh', 'a drift slice is a refresh, so it packs with other refreshes');
    assert.match(p.slices[0].reason, /^drift: docs\/runbooks\/a\.md changed after the page's stamp/);
    assert.deepEqual(p.drift.planned, ['runbooks/a.md']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('082 US1: at most DRIFT_PAGES_PER_RUN, oldest stamp first; the rest are reported, never deferred', () => {
  assert.equal(mod.DRIFT_PAGES_PER_RUN, 2);
  const { root, head } = driftRepo([
    { name: 'c.md', stamp: '2026-03-01T00:00:00Z' },
    { name: 'a.md', stamp: '2026-01-01T00:00:00Z' },
    { name: 'b.md', stamp: '2026-02-01T00:00:00Z' },
    { name: 'd.md', stamp: '2026-02-01T00:00:00Z' },
  ]);
  try {
    const p = plan(root, { coveredCommit: head, backlog: [] });
    assert.deepEqual(p.drift.planned, ['runbooks/a.md', 'runbooks/b.md'], 'oldest stamp, then path');
    assert.deepEqual(p.drift.deferred, ['runbooks/d.md', 'runbooks/c.md']);
    assert.deepEqual(plannedPages(p).sort(), ['runbooks/a.md', 'runbooks/b.md']);
    assert.deepEqual(p.deferred, [], 'drift beyond the bound is NOT carried into the backlog');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('082 US1 / SC-002: drift only uses budget that is left over, and never exceeds PAGE_BUDGET', () => {
  const { root, head } = driftRepo([{ name: 'a.md' }, { name: 'b.md' }]);
  try {
    const full = Array.from({ length: mod.PAGE_BUDGET }, (_, i) => `q${i}.md`);
    const p = plan(root, { coveredCommit: head, backlog: [{ area: 'runbooks', pages: full, reason: 'carried forward' }] });
    assert.deepEqual(p.drift.planned, [], 'a full budget leaves no room for drift');
    assert.deepEqual(p.drift.deferred, ['runbooks/a.md', 'runbooks/b.md']);
    assert.ok(p.plannedPages <= mod.PAGE_BUDGET);

    const partial = plan(root, { coveredCommit: head, backlog: [{ area: 'runbooks', pages: full.slice(0, mod.PAGE_BUDGET - 1), reason: 'carried forward' }] });
    assert.deepEqual(partial.drift.planned, ['runbooks/a.md'], 'one page of room, one drift page');
    assert.ok(partial.plannedPages <= mod.PAGE_BUDGET, `planned ${partial.plannedPages}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('082 US1: a drifted page already in the backlog, or parked, is not planned again as drift', () => {
  const { root, head } = driftRepo([{ name: 'a.md' }, { name: 'b.md' }]);
  try {
    const p = plan(root, {
      coveredCommit: head,
      backlog: [{ area: 'runbooks', pages: ['a.md'], reason: 'carried forward' }],
      parked: { 'runbooks/b.md': parkedEntry() },
    });
    assert.deepEqual(plannedPages(p), ['runbooks/a.md'], 'a once, from the backlog; b not at all');
    assert.deepEqual(p.drift.planned, []);
    assert.deepEqual(p.drift.parked.map((x) => x.page), ['runbooks/b.md']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── US3: the report ────────────────────────────────────────────────────────────────────────────

test('082 US3: a directory resource is unplannable; unstampable and untracked pages are not drift', () => {
  const { root, head } = driftRepo([{ name: 'a.md' }], {
    extra: {
      'dir.md': page('dir.md', OLD_STAMP, 'docs/runbooks/'),
      'nostamp.md': '---\ntype: Runbook\ntitle: n\ndescription: d.\nresource: docs/runbooks/a.md\n---\nBody.\n',
    },
  });
  try {
    const p = plan(root, { coveredCommit: head, backlog: [] });
    assert.deepEqual(p.drift.unplannable, ['runbooks/dir.md']);
    assert.deepEqual(p.drift.planned, ['runbooks/a.md']);
    assert.ok(!plannedPages(p).includes('runbooks/nostamp.md'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('082 US3: --plan text carries the four drift groups, even when nothing else is planned', () => {
  const { root, head } = driftRepo([{ name: 'a.md' }, { name: 'x.md', stamp: '2026-12-01T00:00:00Z' }], { extra: { 'dir.md': page('dir.md', OLD_STAMP, 'docs/runbooks/') } });
  try {
    const p = plan(root, { coveredCommit: head, backlog: [], parked: { 'runbooks/x.md': parkedEntry() } });
    const lines = [];
    const real = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    try { mod.reportPlan(p, { json: false }); } finally { console.log = real; }
    const out = lines.join('\n');
    assert.match(out, /drift: 1 planned, 0 deferred, 1 parked, 1 unplannable/);
    assert.match(out, /planned\s+runbooks\/a\.md/);
    assert.match(out, /parked\s+runbooks\/x\.md \(item #719, since 2026-10-10\)/);
    assert.match(out, /unplannable\s+runbooks\/dir\.md/);

    const empty = plan(root, { coveredCommit: head, backlog: [], parked: { 'runbooks/a.md': parkedEntry(), 'runbooks/x.md': parkedEntry() } });
    lines.length = 0;
    console.log = (...a) => lines.push(a.join(' '));
    try { mod.reportPlan(empty, { json: false }); } finally { console.log = real; }
    assert.match(lines.join('\n'), /0 slices/);
    assert.match(lines.join('\n'), /2 parked/, 'parked pages are listed even when there is nothing to do');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('082 US3: the proposal body names each drift slice', () => {
  const body = mod.proposalBody(
    { sinceCommit: 'a'.repeat(40), baseCommit: 'b'.repeat(40), drift: { planned: ['runbooks/a.md'], deferred: [], parked: [], unplannable: [] } },
    { outcome: 'completed', pagesWritten: 1, elapsedSeconds: 1, results: [{ ok: true, slice: { area: 'runbooks', pages: ['a.md'], drift: true }, pagesWritten: ['openwiki/runbooks/a.md'] }] },
  );
  assert.match(body, /`runbooks\/` \(drift\)/);
});

// ── SC-001: re-planned eventually, demonstrated ────────────────────────────────────────────────

test('082 SC-001: n drifted pages are all re-planned within ceil(n / DRIFT_PAGES_PER_RUN) landed runs', () => {
  // Real runbook names: the OKF gate verifySlice runs resolves `resource` against THIS repository (V6).
  const names = ['backlog.md', 'ci-diagnostics.md', 'local-dev.md', 'renovate.md', 'sast-scanning.md'];
  const { root, head } = driftRepo(names.map((name, i) => ({ name, stamp: `2026-0${i + 1}-01T00:00:00Z` })));
  try {
    mod.writeRunRecord(root, { coveredCommit: head, lastOutcome: 'completed', backlog: [] });
    // A generator that lands every requested page: new stamp, resource kept, index untouched.
    const invoke = (work) => {
      for (const part of mod.partsOf(work)) {
        for (const p of part.pages) writeFileSync(join(root, 'openwiki', part.area, p), page(p, new Date().toISOString()));
      }
      return { status: 0 };
    };
    const seen = [];
    let runs = 0;
    for (; runs < 10; runs++) {
      const p = plan(root, mod.readRunRecord(root));
      if (p.slices.length === 0) break;
      seen.push(...plannedPages(p));
      const result = mod.executeSlices({ root, bundleRoot: join(root, 'openwiki'), slices: p.slices, carryForward: p.deferred, baseCommit: head, invoke, attemptsPerSlice: 1 });
      assert.equal(result.outcome, 'completed', JSON.stringify(result.results.map((r) => r.violations)));
      const backlogPages = mod.readRunRecord(root).backlog.flatMap((s) => s.pages);
      assert.equal(new Set(backlogPages).size, backlogPages.length, 'the backlog never holds a page twice');
    }
    assert.equal(runs, Math.ceil(names.length / mod.DRIFT_PAGES_PER_RUN), `planned over ${runs} runs: ${seen.join(', ')}`);
    assert.deepEqual([...seen].sort(), names.map((n) => `runbooks/${n}`), 'every drifted page, each once');
    assert.match(readFileSync(join(root, 'openwiki', 'runbooks', 'sast-scanning.md'), 'utf8'), /timestamp: 20/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ── #748: a page already regenerated on the OPEN PROPOSAL is covered ────────────────────────────────
//
// Dispatch 5264 regenerated two runbooks pages into open proposal #751; the next run read their stamps
// on main, found them drifted, and put them back in the backlog — work paid for twice.

/** Commit `pages` (name → stamp) onto the proposal branch, then return to where the repo was. */
function regenerateOnProposal(root, g, pages) {
  const back = g(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  g(['checkout', '-qb', mod.PROPOSAL_BRANCH]);
  for (const [name, stamp] of Object.entries(pages)) writeFileSync(join(root, 'openwiki', 'runbooks', name), page(name, stamp));
  g(['commit', '-qam', 'regenerated on the proposal']);
  g(['checkout', '-q', back]);
}

test('#748: a page stale on main but FRESH on the open proposal is not planned — from drift or the backlog', () => {
  const { root, head, g } = driftRepo([{ name: 'a.md' }, { name: 'b.md' }, { name: 'c.md' }]);
  try {
    // a: fresh on the proposal. b: on the proposal, but its source still changed after that stamp.
    regenerateOnProposal(root, g, { 'a.md': '2026-12-01T00:00:00Z', 'b.md': '2026-02-01T00:00:00Z' });
    assert.deepEqual(plannedPages(plan(root, { coveredCommit: head, backlog: [] })).sort(), ['runbooks/a.md', 'runbooks/b.md'],
      'the premise: without the proposal, main\'s stamps make a and b drift (oldest first, two per run)');

    const withRef = (record) => mod.computePlan({ root, bundleRoot: join(root, 'openwiki'), record, policy: null, proposalRef: mod.PROPOSAL_BRANCH });
    const p = withRef({ coveredCommit: head, backlog: [] });
    assert.ok(!plannedPages(p).includes('runbooks/a.md'), 'a is covered by the proposal');
    assert.ok(plannedPages(p).includes('runbooks/b.md'), 'b is stale even on the proposal, so it is still planned');
    assert.deepEqual(p.onProposal, ['runbooks/a.md'], 'and what was skipped is reported, never silent');
    const printed = [];
    const real = console.log;
    console.log = (...a) => printed.push(a.join(' '));
    try { mod.reportPlan(p, { json: false }); } finally { console.log = real; }
    assert.ok(printed.some((l) => /on the open proposal +runbooks\/a\.md/.test(l)), '--plan prints it');

    const fromBacklog = withRef({ coveredCommit: head, backlog: [{ area: 'runbooks', pages: ['a.md'], reason: 'drift: carried forward' }] });
    assert.ok(!plannedPages(fromBacklog).includes('runbooks/a.md'), 'nor is it planned from the backlog');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('#748: an absent proposal ref changes nothing', () => {
  const { root, head } = driftRepo([{ name: 'a.md' }]);
  try {
    const p = mod.computePlan({ root, bundleRoot: join(root, 'openwiki'), record: { coveredCommit: head, backlog: [] }, policy: null, proposalRef: 'refs/remotes/origin/no-such-branch' });
    assert.deepEqual(plannedPages(p), ['runbooks/a.md']);
    assert.deepEqual(p.onProposal, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
