// Unit tests for the wiki maintenance orchestrator (scripts/wiki-maintain.mjs) — feature 044.
//
// Deterministic, offline, token-free, `node:` built-ins + `yaml` only. CI-enforced on every push by
// the `guardrails / naming` job's shell-expanded `node --test scripts/__tests__/*.test.mjs` glob,
// which runs in a container with no forge access, no network, and no ANTHROPIC_API_KEY.
//
// Two facts from the feature's Phase 0 research shape almost every assertion here:
//   R1 — the generator reports NO token or cost data, so budgets are pages + wall-clock, observed.
//   R2 — the generator has NO programmatic scoping surface. A slice is free text in a run message,
//        so the page cap is advisory and VERIFICATION IS THE ONLY ENFORCEMENT THAT EXISTS. Anything
//        below that trusts the generator's own account of what it did is a bug, not a shortcut.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync, statSync, existsSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'wiki-maintain.mjs');

const mod = await import(SCRIPT);

const FIXTURES = join(REPO_ROOT, 'scripts', '__tests__', 'fixtures', 'wiki-maintain');

function tmpBundle() {
  const dir = mkdtempSync(join(tmpdir(), 'wiki-maintain-'));
  mkdirSync(join(dir, 'openwiki'), { recursive: true });
  return dir;
}

/**
 * Materialize a bundle from `{ 'area/page.md': '<resource or null>' }`. Used where the assertion is
 * about SCALE (chunking a dozen pages) rather than about a shape one of T001's fixtures already holds.
 */
function bundleWith(pages) {
  const root = mkdtempSync(join(tmpdir(), 'wiki-bundle-'));
  const areas = new Set();
  for (const [rel, resource] of Object.entries(pages)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    const fm = ['---', 'type: Gotcha', `title: ${rel}`, resource ? `resource: ${resource}` : null, '---', 'Body.', '']
      .filter((l) => l !== null).join('\n');
    writeFileSync(p, fm);
    areas.add(dirname(rel));
  }
  for (const area of areas) {
    if (area === '.') continue;
    const listed = Object.keys(pages).filter((p) => dirname(p) === area).map((p) => `- [x](${p.split('/').pop()})`);
    writeFileSync(join(root, area, 'index.md'), `# ${area}\n${listed.join('\n')}\n`);
  }
  writeFileSync(join(root, 'index.md'), '---\nokf_version: "0.1"\n---\n# Bundle\n');
  return root;
}

// ── E3: the run record ──────────────────────────────────────────────────────────

test('run record round-trips through openwiki/.maintenance-state.json', () => {
  const root = tmpBundle();
  try {
    const record = {
      coveredCommit: 'a'.repeat(40),
      coveredAt: '2026-07-30T12:00:00.000Z',
      lastOutcome: 'completed',
      backlog: [{ area: 'gotchas', pages: ['x.md'], areaExists: true, reason: 'source changed' }],
      proposal: { branch: 'wiki-maintenance', number: 42, headCommit: 'b'.repeat(40) },
      lastRunBudget: { pagesWritten: 8, elapsedSeconds: 610, stoppedAtBudget: false },
    };
    mod.writeRunRecord(root, record);

    const onDisk = join(root, 'openwiki', '.maintenance-state.json');
    assert.ok(statSync(onDisk).isFile(), 'the record must live at openwiki/.maintenance-state.json');

    const read = mod.readRunRecord(root);
    assert.deepEqual(read, record);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an absent run record reads as never-covered rather than as an error', () => {
  const root = tmpBundle();
  try {
    const record = mod.readRunRecord(root);
    assert.equal(record.coveredCommit, null, 'never covered must be distinguishable from covered');
    assert.equal(record.lastOutcome, null);
    assert.deepEqual(record.backlog, []);
    assert.equal(record.proposal, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('lastOutcome accepts exactly the three outcomes FR-017 requires distinguishing', () => {
  const root = tmpBundle();
  try {
    assert.deepEqual([...mod.RUN_OUTCOMES].sort(), ['completed', 'failed', 'nothing-to-do']);
    for (const outcome of mod.RUN_OUTCOMES) {
      mod.writeRunRecord(root, { coveredCommit: 'c'.repeat(40), lastOutcome: outcome });
      assert.equal(mod.readRunRecord(root).lastOutcome, outcome);
    }
    assert.throws(
      () => mod.writeRunRecord(root, { coveredCommit: 'c'.repeat(40), lastOutcome: 'probably-fine' }),
      /lastOutcome/,
      'an outcome outside the enum must be rejected at write time',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a malformed run record is a hard error, never a silent default', () => {
  const root = tmpBundle();
  try {
    writeFileSync(join(root, 'openwiki', '.maintenance-state.json'), '{ "coveredCommit": "abc",,, }');
    assert.throws(() => mod.readRunRecord(root), /\.maintenance-state\.json/);

    // Parseable JSON of the wrong shape is equally unsafe: silently defaulting would re-cover
    // history that was already covered, or skip history that never was.
    writeFileSync(join(root, 'openwiki', '.maintenance-state.json'), '["not", "an", "object"]');
    assert.throws(() => mod.readRunRecord(root), /\.maintenance-state\.json/);

    writeFileSync(join(root, 'openwiki', '.maintenance-state.json'), '{"lastOutcome":"fine"}');
    assert.throws(() => mod.readRunRecord(root), /lastOutcome/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The tool owns openwiki/.last-update.json. Feature 043 measured it advancing ONLY when wiki content
// changed — precisely the behaviour that made the free "nothing to document" path unreachable — so
// repurposing it would reintroduce the defect this feature exists to fix (data-model E3).
test('the module never reads or writes the tool-owned .last-update.json', () => {
  const root = tmpBundle();
  try {
    const toolFile = join(root, 'openwiki', '.last-update.json');
    const toolContent = JSON.stringify({ updatedAt: '2026-07-27T20:42:02.048Z', command: 'update' });
    writeFileSync(toolFile, toolContent);

    mod.writeRunRecord(root, { coveredCommit: 'd'.repeat(40), lastOutcome: 'nothing-to-do' });
    mod.readRunRecord(root);

    assert.equal(readFileSync(toolFile, 'utf8'), toolContent, '.last-update.json must be untouched');

    const source = readFileSync(SCRIPT, 'utf8');
    const mentions = source.split('\n').filter((l) => l.includes('.last-update.json') && !l.trimStart().startsWith('//'));
    assert.deepEqual(mentions, [], 'the tool-owned file must not appear in executable code, only in comments');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── E1/E2: the planner ──────────────────────────────────────────────────────────

test('slice bounding: no slice exceeds the 8-page cap', () => {
  // 8 is the largest size feature 043 delivered reliably, and it delivered it twice (FR-002).
  const pages = {};
  for (let i = 1; i <= 19; i++) pages[`runbooks/page-${String(i).padStart(2, '0')}.md`] = `docs/runbooks/src-${i}.md`;
  const bundleRoot = bundleWith(pages);
  try {
    const slices = mod.planSlices({
      bundleRoot,
      changedPaths: Array.from({ length: 19 }, (_, i) => `docs/runbooks/src-${i + 1}.md`),
    });
    assert.ok(slices.length >= 3, `19 pages cannot fit in fewer than 3 slices, got ${slices.length}`);
    for (const s of slices) {
      assert.ok(s.pages.length >= 1, 'an empty slice is not a slice');
      assert.ok(s.pages.length <= mod.MAX_PAGES_PER_SLICE, `slice of ${s.pages.length} pages exceeds the cap`);
    }
    assert.equal(mod.MAX_PAGES_PER_SLICE, 8);
    const all = slices.flatMap((s) => s.pages);
    assert.equal(new Set(all).size, all.length, 'a page must not appear in two slices');
    assert.equal(all.length, 19, 'every page must land in some slice — chunking may not drop work');
  } finally {
    rmSync(bundleRoot, { recursive: true, force: true });
  }
});

test('slice bounding: a slice names exactly one area and never mixes a new area with an existing one', () => {
  // Of feature 043's eight measured runs, the ONLY one that produced zero pages was the only one
  // shaped this way. Splitting along that seam fixed it immediately, so the planner must be unable
  // to emit it.
  const bundleRoot = join(FIXTURES, 'new-and-existing-areas'); // gotchas/ exists, runbooks/ does not
  const slices = mod.planSlices({
    bundleRoot,
    changedPaths: ['CLAUDE.md'],
    backlog: [
      { area: 'gotchas', pages: ['musl-vendored-openssl.md'], reason: 'carried forward' },
      { area: 'runbooks', pages: ['brand-new.md'], reason: 'carried forward' },
    ],
  });

  assert.ok(slices.length >= 2, 'two areas cannot share one slice');
  for (const s of slices) {
    assert.equal(typeof s.area, 'string');
    assert.ok(!s.area.includes('/'), `area must be a single path segment, got ${s.area}`);
    const areas = new Set(s.pages.map((p) => (p.includes('/') ? p.split('/')[0] : s.area)));
    assert.deepEqual([...areas], [s.area], 'every page in a slice belongs to that slice\'s area');
  }

  const gotchas = slices.find((s) => s.area === 'gotchas');
  const runbooks = slices.find((s) => s.area === 'runbooks');
  assert.equal(gotchas.areaExists, true, 'gotchas/ exists in the fixture tree');
  assert.equal(runbooks.areaExists, false, 'runbooks/ does not');
});

test('slice bounding: areaExists is derived from the tree, never taken from the caller', () => {
  const bundleRoot = join(FIXTURES, 'new-and-existing-areas');
  const slices = mod.planSlices({
    bundleRoot,
    changedPaths: [],
    // Both claims are lies. A caller-supplied flag would let a stale backlog entry tell the planner
    // an area exists, and the run would then extend a directory that is not there.
    backlog: [
      { area: 'runbooks', pages: ['a.md'], areaExists: true, reason: 'carried forward' },
      { area: 'gotchas', pages: ['b.md'], areaExists: false, reason: 'carried forward' },
    ],
  });
  assert.equal(slices.find((s) => s.area === 'runbooks').areaExists, false);
  assert.equal(slices.find((s) => s.area === 'gotchas').areaExists, true);
});

// ── FR-003/FR-004: planning is free and offline ──────────────────────────────────

/**
 * Run the CLI with NO model credential and with a PATH whose only `pnpm`/`openwiki` are stubs that
 * record being called and fail. Any accidental generator invocation on the planning path therefore
 * shows up as a sentinel file, not as a silent paid call.
 */
function runCli(args, { env = {}, cwd = REPO_ROOT } = {}) {
  const binDir = mkdtempSync(join(tmpdir(), 'wiki-bin-'));
  const sentinel = join(binDir, 'invoked.log');
  for (const name of ['pnpm', 'openwiki', 'nx']) {
    const p = join(binDir, name);
    writeFileSync(p, `#!/bin/sh\necho "${name} $*" >> "${sentinel}"\nexit 1\n`, { mode: 0o755 });
  }
  const clean = { ...process.env, ...env };
  delete clean.ANTHROPIC_API_KEY;
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...clean, PATH: `${binDir}:${process.env.PATH}`, NO_COLOR: '1' },
  });
  const invoked = existsSync(sentinel) ? readFileSync(sentinel, 'utf8') : '';
  rmSync(binDir, { recursive: true, force: true });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: r.stdout ?? '', invoked };
}

test('offline: --plan completes with no credential and invokes nothing', () => {
  const { code, invoked, out } = runCli(['--plan']);
  assert.equal(code, 0, `--plan must succeed without a credential\n${out}`);
  assert.equal(invoked, '', `the planning path must invoke no generator, got: ${invoked}`);
  // Exit 0 alone proves nothing — a script that does nothing also exits 0.
  assert.match(out, /slice/i, 'the plan must actually report what it planned');
  assert.match(out, /since|covered/i, 'the plan must state the range it was computed over');
});

test('offline: --plan --json emits inspectable JSON matching the plan contract', () => {
  const { code, stdout, invoked } = runCli(['--plan', '--json']);
  assert.equal(code, 0);
  assert.equal(invoked, '');
  const plan = JSON.parse(stdout);
  for (const field of ['generatedAt', 'baseCommit', 'sinceCommit', 'changedPaths', 'slices', 'deferred', 'plannedPages']) {
    assert.ok(field in plan, `plan output must carry \`${field}\``);
  }
  assert.ok(Array.isArray(plan.slices));
  assert.equal(typeof plan.plannedPages, 'number');
  for (const s of plan.slices) {
    assert.ok(s.pages.length <= mod.MAX_PAGES_PER_SLICE);
    assert.equal(typeof s.runMessage, 'string');
    assert.ok(s.runMessage.length > 0, 'every slice carries its rendered run message');
  }
});

// ── FR-001/R2: the run message IS the scope boundary ────────────────────────────

test('run-message rendering names every page in the slice and no others', () => {
  // Per research R2 this string is the ONLY scoping surface the generator exposes. An untested
  // renderer is an untested scope boundary.
  const slice = { area: 'gotchas', pages: ['a-one.md', 'b-two.md', 'c-three.md'], areaExists: true, reason: 'source changed: CLAUDE.md' };
  const message = mod.renderRunMessage(slice);

  for (const p of slice.pages) assert.ok(message.includes(p), `run message must name ${p}`);
  for (const other of ['d-four.md', 'keyset-pagination.md', 'local-dev.md']) {
    assert.ok(!message.includes(other), `run message must not name ${other}`);
  }
});

test('run-message rendering names exactly one bundle area', () => {
  const message = mod.renderRunMessage({ area: 'gotchas', pages: ['a.md'], areaExists: true, reason: 'r' });
  const areas = ['gotchas', 'invariants', 'runbooks', 'projects', 'process', 'architecture', 'decisions'];
  const named = areas.filter((a) => new RegExp(`\\b${a}\\b`).test(message));
  assert.deepEqual(named, ['gotchas'], `exactly one area may be named, got ${named.join(',')}`);
});

test('run-message rendering carries all 8 pages of a full slice', () => {
  const pages = Array.from({ length: 8 }, (_, i) => `page-${i + 1}.md`);
  const message = mod.renderRunMessage({ area: 'invariants', pages, areaExists: false, reason: 'r' });
  for (const p of pages) assert.ok(message.includes(p), `run message must name ${p}`);
  assert.equal((message.match(/page-\d\.md/g) ?? []).length >= 8, true);
});

test('run-message rendering is deterministic for a given slice', () => {
  // A re-plan that silently changed scope would make the plan a reviewer approved meaningless.
  const slice = { area: 'runbooks', pages: ['x.md', 'y.md'], areaExists: true, reason: 'source changed: docs/runbooks/x.md' };
  assert.equal(mod.renderRunMessage(slice), mod.renderRunMessage({ ...slice }));
  assert.notEqual(mod.renderRunMessage(slice), mod.renderRunMessage({ ...slice, areaExists: false }));

  // MEASURED: nx appends `--args` to a shell command line unquoted, so a message carrying a newline
  // or a backtick would either be split into a dozen arguments or command-substituted. What the
  // reviewer reads has to be exactly what the generator is asked — no re-quoting in between.
  const message = mod.renderRunMessage(slice);
  assert.doesNotMatch(message, /[\n\r"`$\\]/, 'the run message must survive one round of shell parsing');
  assert.deepEqual(mod.generatorCommand().slice(0, 4), ['pnpm', 'nx', 'wiki-update', 'infrastructure-as-code']);
  // Nx buffers a successful task's output and prints nothing, which made a 7-minute paid run that
  // wrote no pages completely undiagnosable. The generator's own account must reach the log.
  assert.ok(mod.generatorCommand().includes('--output-style=stream'), 'the generator output must not be swallowed');
  assert.equal(mod.generatorEnv(message, {})[mod.RUN_MESSAGE_ENV], message, 'the message travels in the environment');
  assert.throws(() => mod.generatorEnv('bad `whoami` message', {}), /shell metacharacter/);
});

// ── FR-005/FR-006: the verifier, the load-bearing part ──────────────────────────

/**
 * A throwaway git repository holding a copy of a fixture bundle. Written paths are a WORKING-TREE
 * question, so the harness has to be a real working tree — `git status` is how you actually know what
 * a run wrote, and it is the only detector that also sees writes OUTSIDE the bundle.
 */
function tmpGitRepo(fixtureName) {
  const root = mkdtempSync(join(tmpdir(), 'wiki-repo-'));
  cpSync(join(FIXTURES, fixtureName), join(root, 'openwiki'), { recursive: true });
  mkdirSync(join(root, 'docs', 'runbooks'), { recursive: true });
  writeFileSync(join(root, 'docs', 'runbooks', 'local-dev.md'), '# Local dev\n');
  const g = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 'test@example.invalid');
  g('config', 'user.name', 'Test');
  g('add', '-A');
  g('commit', '-qm', 'baseline');
  return root;
}

test('zero-page detection: a stub generator that exits 0 having written nothing is a FAILURE', () => {
  // This is the exact false green feature 043 measured: 12 minutes of paid work, one index.md
  // written, exit 0, reported as success. A GREEN result on this test means the detector is broken.
  const root = tmpGitRepo('conformant-bundle');
  try {
    const record = mod.writeRunRecord(root, { coveredCommit: 'old-marker', lastOutcome: 'completed' });
    const slices = [{ area: 'invariants', pages: ['brand-new.md'], areaExists: true, reason: 'source changed' }];

    const result = mod.executeSlices({
      root,
      bundleRoot: join(root, 'openwiki'),
      slices,
      record,
      invoke: () => ({ status: 0 }), // exits 0, writes nothing at all
    });

    assert.equal(result.outcome, 'failed', 'zero pages written must be a failure whatever the generator says');
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.backlog.map((s) => s.area), ['invariants'], 'the slice must return to the backlog');
    assert.equal(mod.readRunRecord(root).coveredCommit, 'old-marker', 'the marker must NOT advance on failure');
    // The contract is the REQUESTED page, named: "some page appeared" would have let a run that wrote
    // three unrelated pages while ignoring the request pass.
    const violation = result.results[0].violations.join(' ');
    assert.match(violation, /do not exist after the run/);
    assert.match(violation, /invariants\/brand-new\.md/, 'the failure must name the page that is missing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('zero-page detection: writing only an index.md counts as zero pages', () => {
  // 043's failing run wrote exactly one index.md. Counting that as work would reproduce the defect.
  const root = tmpGitRepo('conformant-bundle');
  try {
    const result = mod.executeSlices({
      root,
      bundleRoot: join(root, 'openwiki'),
      slices: [{ area: 'invariants', pages: ['a.md'], areaExists: true, reason: 'r' }],
      record: mod.readRunRecord(root),
      invoke: () => {
        writeFileSync(join(root, 'openwiki', 'invariants', 'index.md'), '# Invariants\n- [Auth Chain](auth-chain.md)\n- touched\n');
        return { status: 0 };
      },
    });
    assert.equal(result.outcome, 'failed');
    assert.equal(result.pagesWritten, 0, 'an index.md refresh is not a page of work');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('zero-page detection: a refresh where nothing needed changing is honest, not a failure', () => {
  // The mirror image of the false green, and it cost a paid run to find: a refresh slice for a page
  // that is already accurate legitimately writes nothing. Counting writes alone reported that as
  // broken and stopped the whole run.
  const root = tmpGitRepo('conformant-bundle');
  try {
    const result = mod.executeSlices({
      root,
      bundleRoot: join(root, 'openwiki'),
      // auth-chain.md already exists in the fixture and needs no change.
      slices: [{ area: 'invariants', pages: ['auth-chain.md'], areaExists: true, kind: 'refresh', reason: 'r' }],
      record: mod.readRunRecord(root),
      baseCommit: 'advanced',
      invoke: () => ({ status: 0 }),
    });
    assert.equal(result.outcome, 'completed', 'a page that is already current is not a failure');
    assert.equal(result.exitCode, 0);
    assert.equal(result.results[0].noChange, true, 'and it is reported distinguishably from work done');
    assert.equal(result.pagesWritten, 0, 'while still counting as zero pages against the budget');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('zero-page detection: a slice that DOES write its pages verifies clean', () => {
  const root = tmpGitRepo('conformant-bundle');
  try {
    const result = mod.executeSlices({
      root,
      bundleRoot: join(root, 'openwiki'),
      slices: [{ area: 'invariants', pages: ['session-timeout.md'], areaExists: true, reason: 'r' }],
      record: mod.readRunRecord(root),
      invoke: () => {
        writeFileSync(join(root, 'openwiki', 'invariants', 'session-timeout.md'),
          '---\ntype: Convention\ntitle: Session Timeout\ndescription: Idle and absolute limits.\n---\nBody.\n');
        writeFileSync(join(root, 'openwiki', 'invariants', 'index.md'),
          '# Invariants\n- [Auth Chain](auth-chain.md)\n- [Session Timeout](session-timeout.md)\n');
        return { status: 0 };
      },
    });
    assert.equal(result.outcome, 'completed', `expected completed, got ${result.outcome}: ${JSON.stringify(result.results)}`);
    assert.equal(result.exitCode, 0);
    assert.equal(result.pagesWritten, 1);
    assert.deepEqual(result.backlog, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('conformance regression: pages that break the bundle are a failure, and the violation is surfaced', () => {
  const root = tmpGitRepo('conformant-bundle');
  try {
    const result = mod.executeSlices({
      root,
      bundleRoot: join(root, 'openwiki'),
      slices: [{ area: 'invariants', pages: ['broken.md'], areaExists: true, reason: 'r' }],
      record: mod.readRunRecord(root),
      invoke: () => {
        // A real page, written — but with no `type`, so the bundle is no longer conformant (V2), and
        // unlisted in its index (V9).
        writeFileSync(join(root, 'openwiki', 'invariants', 'broken.md'), '---\ntitle: No type\n---\nBody.\n');
        return { status: 0 };
      },
    });
    assert.equal(result.outcome, 'failed');
    assert.equal(result.exitCode, 1);
    const surfaced = result.results[0].violations.join('\n');
    assert.match(surfaced, /broken\.md/, 'the failure must name the offending page');
    assert.match(surfaced, /conforman|V2|V9|type/i, 'and say what is wrong with it');
    assert.deepEqual(result.backlog.map((s) => s.area), ['invariants']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── FR-026e: the runtime half of the policy ─────────────────────────────────────
// The gate checks that policy.yaml DECLARES `actor: generator` only inside openwiki/. Nothing until
// now checked that a run OBEYED it.

const realPolicy = () => mod.loadPolicy(REPO_ROOT);

function repoWithPolicy(fixtureName) {
  const root = tmpGitRepo(fixtureName);
  cpSync(join(REPO_ROOT, 'openwiki', 'policy.yaml'), join(root, 'openwiki', 'policy.yaml'));
  spawnSync('git', ['add', '-A'], { cwd: root });
  spawnSync('git', ['commit', '-qm', 'policy'], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.invalid' } });
  return root;
}

/** Write the slice's page (so zero-page never masks the policy verdict) plus one forbidden path. */
const stubWriting = (root, forbidden, content = '# written by the run\n') => () => {
  writeFileSync(join(root, 'openwiki', 'invariants', 'ok-page.md'),
    '---\ntype: Convention\ntitle: Ok\ndescription: A legitimately written page.\n---\nBody.\n');
  writeFileSync(join(root, 'openwiki', 'invariants', 'index.md'),
    '# Invariants\n- [Auth Chain](auth-chain.md)\n- [Ok](ok-page.md)\n');
  const target = join(root, forbidden);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  return { status: 0 };
};

for (const [label, forbidden, expected] of [
  ['a regenerate path governed by a different actor', 'docs/runbooks/local-dev.md', /actor/i],
  ['a never-written path (the generation brief)', 'openwiki/INSTRUCTIONS.md', /never-written/],
  ['a never-written path (the policy itself)', 'openwiki/policy.yaml', /never-written/],
  ['a never-written path (the protection manifest)', 'openwiki/protected.yaml', /never-written/],
  ['an excluded path', 'docs/proposals/PRD-Whatever.md', /excluded/],
]) {
  test(`policy-write enforcement: writing ${label} fails the run and names the path`, () => {
    const root = repoWithPolicy('conformant-bundle');
    try {
      const result = mod.executeSlices({
        root,
        bundleRoot: join(root, 'openwiki'),
        slices: [{ area: 'invariants', pages: ['ok-page.md'], areaExists: true, reason: 'r' }],
        record: mod.readRunRecord(root),
        policy: realPolicy(),
        invoke: stubWriting(root, forbidden),
      });

      assert.equal(result.outcome, 'failed', `writing ${forbidden} must fail the run`);
      assert.equal(result.exitCode, 1);
      const surfaced = result.results[0].violations.join('\n');
      assert.match(surfaced, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the failure must name the offending path');
      assert.match(surfaced, expected, 'and say which policy state forbade it');
      assert.deepEqual(result.backlog.map((s) => s.area), ['invariants'], 'the slice returns to the backlog');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('policy-write enforcement: a write inside the generator\'s own scope is permitted', () => {
  const root = repoWithPolicy('conformant-bundle');
  try {
    const result = mod.executeSlices({
      root,
      bundleRoot: join(root, 'openwiki'),
      slices: [{ area: 'invariants', pages: ['ok-page.md'], areaExists: true, reason: 'r' }],
      record: mod.readRunRecord(root),
      policy: realPolicy(),
      invoke: () => {
        writeFileSync(join(root, 'openwiki', 'invariants', 'ok-page.md'),
          '---\ntype: Convention\ntitle: Ok\ndescription: A legitimately written page.\n---\nBody.\n');
        writeFileSync(join(root, 'openwiki', 'invariants', 'index.md'),
          '# Invariants\n- [Auth Chain](auth-chain.md)\n- [Ok](ok-page.md)\n');
        return { status: 0 };
      },
    });
    assert.equal(result.outcome, 'completed', `expected completed, got: ${JSON.stringify(result.results?.[0]?.violations)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── C6: the budget guard ────────────────────────────────────────────────────────

/** A stub that writes `n` real, conformant pages into `area` and lies about how many it wrote. */
function writingStub(root, area, names, { claim = null } = {}) {
  return () => {
    for (const n of names) {
      writeFileSync(join(root, 'openwiki', area, n),
        `---\ntype: Convention\ntitle: ${n}\ndescription: Written by the stub.\n---\nBody.\n`);
    }
    // List EVERY page in the area, not just this slice's: a partial index orphans the previous
    // slice's page (V9) and the resulting conformance failure would mask what the test is measuring.
    const all = readdirSync(join(root, 'openwiki', area)).filter((f) => f.endsWith('.md') && f !== 'index.md');
    writeFileSync(join(root, 'openwiki', area, 'index.md'), `# ${area}\n${all.map((n) => `- [${n}](${n})`).join('\n')}\n`);
    // R2: nothing constrains the generator to its page list, so nothing stops it MISREPORTING what it
    // produced either. Anything downstream that believed this field would inherit the false green.
    return claim === null ? { status: 0 } : { status: 0, pagesWritten: claim, pages: Array.from({ length: claim }, (_, i) => `phantom-${i}.md`) };
  };
}

const slicesOf = (area, groups) => groups.map((pages, i) => ({ area, pages, areaExists: true, reason: `group ${i}` }));

test('budget: a slice is not started once the page budget is reached, and the remainder is deferred', () => {
  const root = tmpGitRepo('conformant-bundle');
  try {
    let call = 0;
    const result = mod.executeSlices({
      root,
      bundleRoot: join(root, 'openwiki'),
      slices: slicesOf('invariants', [['a1.md', 'a2.md'], ['b1.md', 'b2.md'], ['c1.md', 'c2.md']]),
      record: mod.readRunRecord(root),
      pageBudget: 2,
      invoke: (slice) => {
        call++;
        return writingStub(root, 'invariants', slice.pages)();
      },
    });

    assert.equal(call, 1, 'the second slice must not be STARTED — stopping mid-slice would leave a half-written area');
    assert.equal(result.stoppedAtBudget, true);
    assert.equal(result.pagesWritten, 2);
    assert.equal(result.deferred.length, 2, 'the remainder is deferred');
    assert.deepEqual(result.backlog.map((s) => s.pages), [['b1.md', 'b2.md'], ['c1.md', 'c2.md']], 'and carried forward');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('budget: a run stopped at a budget exits 3 — distinct from a failure', () => {
  const root = tmpGitRepo('conformant-bundle');
  try {
    const result = mod.executeSlices({
      root,
      bundleRoot: join(root, 'openwiki'),
      slices: slicesOf('invariants', [['a1.md'], ['b1.md']]),
      record: mod.readRunRecord(root),
      pageBudget: 1,
      invoke: (slice) => writingStub(root, 'invariants', slice.pages)(),
    });
    // Exit 3 exists for the same reason ci-status.mjs distinguishes starvation from failure: a run
    // that correctly stopped at its budget must not be reported as broken.
    assert.equal(result.exitCode, 3);
    assert.notEqual(result.exitCode, 1);
    assert.equal(result.outcome, 'completed', 'a budget stop is not the `failed` outcome');
    assert.notEqual(result.outcome, 'nothing-to-do', 'nor is it nothing-to-do — there IS outstanding work');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('budget: the wall-clock budget stops the run between slices', () => {
  const root = tmpGitRepo('conformant-bundle');
  try {
    // A clock that jumps 15 minutes per read, against a 20-minute budget.
    let t = 0;
    const result = mod.executeSlices({
      root,
      bundleRoot: join(root, 'openwiki'),
      slices: slicesOf('invariants', [['a1.md'], ['b1.md'], ['c1.md']]),
      record: mod.readRunRecord(root),
      pageBudget: 999,
      timeBudgetSeconds: 20 * 60,
      clock: () => (t += 15 * 60 * 1000),
      invoke: (slice) => writingStub(root, 'invariants', slice.pages)(),
    });
    assert.equal(result.stoppedAtBudget, true);
    assert.equal(result.exitCode, 3);
    assert.ok(result.deferred.length >= 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('budget: page counts come from the working tree — an over-reporting generator does not move the counter', () => {
  const root = tmpGitRepo('conformant-bundle');
  try {
    const result = mod.executeSlices({
      root,
      bundleRoot: join(root, 'openwiki'),
      slices: slicesOf('invariants', [['only-one.md']]),
      record: mod.readRunRecord(root),
      pageBudget: 16,
      invoke: writingStub(root, 'invariants', ['only-one.md'], { claim: 99 }),
    });
    assert.equal(result.pagesWritten, 1, 'one page exists on disk, so one page was written');
    assert.equal(result.record.lastRunBudget.pagesWritten, 1, 'and the persisted record agrees');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('budget: the declared defaults are 16 pages and 20 minutes', () => {
  assert.equal(mod.PAGE_BUDGET, 16);
  assert.equal(mod.TIME_BUDGET_SECONDS, 20 * 60);
  const header = readFileSync(SCRIPT, 'utf8').slice(0, 8000);
  // FR-011a/FR-011c/FR-011d must be stated where someone changing the numbers will read them.
  assert.match(header, /24 pages/, 'the effective ceiling must be declared');
  assert.match(header, /runner occupancy/i, 'and what the wall-clock budget actually bounds');
  assert.match(header, /NEITHER BUDGET IS A MONETARY BOUND/, 'and that neither is a cost control');
});

// ── FR-007: resume ──────────────────────────────────────────────────────────────

test('resume: re-invocation attempts only the outstanding slices', () => {
  const root = tmpGitRepo('conformant-bundle');
  try {
    const slices = slicesOf('invariants', [['a1.md'], ['b1.md'], ['c1.md']]);

    // Run 1 stops at a one-page budget, having done only the first slice.
    const first = mod.executeSlices({
      root,
      bundleRoot: join(root, 'openwiki'),
      slices,
      record: mod.readRunRecord(root),
      pageBudget: 1,
      baseCommit: 'commit-one',
      invoke: (slice) => writingStub(root, 'invariants', slice.pages)(),
    });
    assert.equal(first.exitCode, 3);
    assert.deepEqual(first.backlog.map((s) => s.pages.join()), ['b1.md', 'c1.md']);

    // The backlog survived in the run record — runners are ephemeral, so the state has to be on disk.
    const persisted = mod.readRunRecord(root);
    assert.deepEqual(persisted.backlog.map((s) => s.pages.join()), ['b1.md', 'c1.md']);

    // Run 2 plans from that record and must NOT redo the completed slice.
    const replanned = mod.planSlices({
      bundleRoot: join(root, 'openwiki'),
      changedPaths: [],
      backlog: persisted.backlog,
    });
    const requested = replanned.flatMap((s) => s.pages);
    assert.deepEqual(requested.sort(), ['b1.md', 'c1.md'], 'completed work must not be attempted again');
    assert.ok(!requested.includes('a1.md'));

    const second = mod.executeSlices({
      root,
      bundleRoot: join(root, 'openwiki'),
      slices: replanned,
      record: persisted,
      baseCommit: 'commit-two',
      invoke: (slice) => writingStub(root, 'invariants', slice.pages)(),
    });
    assert.equal(second.exitCode, 0);
    assert.equal(second.outcome, 'completed');
    assert.deepEqual(second.backlog, [], 'the backlog drains');
    assert.equal(mod.readRunRecord(root).coveredCommit, 'commit-two');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resume: --max-slices bounds one invocation and carries the rest forward', () => {
  const root = tmpGitRepo('conformant-bundle');
  try {
    const result = mod.executeSlices({
      root,
      bundleRoot: join(root, 'openwiki'),
      slices: slicesOf('invariants', [['a1.md'], ['b1.md'], ['c1.md']]),
      record: mod.readRunRecord(root),
      maxSlices: 1,
      invoke: (slice) => writingStub(root, 'invariants', slice.pages)(),
    });
    assert.equal(result.results.length, 1);
    assert.equal(result.backlog.length, 2);
    assert.equal(result.exitCode, 3, 'outstanding work after a bounded run is exit 3, not success');
    assert.equal(result.stoppedAtBudget, false, 'a --max-slices stop is not a budget stop');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── C1: the CLI surface ─────────────────────────────────────────────────────────

test('CLI: --execute without a credential exits 2 rather than pretending there was nothing to do', () => {
  // FR-017: a credential failure must NEVER be reported as `nothing-to-do`. That is the one
  // misclassification that makes the cheap path look reachable while the work silently never happens.
  const { code, out } = runCli(['--execute']);
  assert.equal(code, 2, `expected exit 2, got ${code}\n${out}`);
  assert.match(out, /ANTHROPIC_API_KEY/);
  assert.doesNotMatch(out, /nothing-to-do/);
});

test('CLI: --dry-run prints the exact command per slice and invokes nothing', () => {
  const stateFile = join(REPO_ROOT, mod.STATE_FILE);
  const before = existsSync(stateFile) ? readFileSync(stateFile, 'utf8') : null;

  const { code, out, invoked } = runCli(['--execute', '--dry-run', '--since', 'HEAD~1'], { ANTHROPIC_API_KEY: 'not-a-real-key' });
  assert.equal(invoked, '', 'a dry run must invoke nothing');
  assert.equal(code, 0, out);
  if (/slice/i.test(out)) assert.match(out, /pnpm nx wiki-update infrastructure-as-code/);

  // A dry run must persist NOTHING. This test caught the real thing: the nothing-to-do branch
  // advanced the marker even under --dry-run, so asking "what would this do?" certified the range as
  // covered and the next real run skipped work nobody had done.
  const after = existsSync(stateFile) ? readFileSync(stateFile, 'utf8') : null;
  assert.equal(after, before, 'a dry run must not touch the run record');
});

test('CLI: mutually exclusive modes and bad values exit 2', () => {
  assert.equal(runCli(['--plan', '--execute']).code, 2);
  assert.equal(runCli([]).code, 2);
  assert.equal(runCli(['--plan', '--max-slices', 'zero']).code, 2);
  assert.equal(runCli(['--plan', '--since']).code, 2);
});

// ── FR-012: the marker advances on a nothing-to-do run ──────────────────────────

/** A temp repo with the real policy, a conformant bundle, and its marker already at HEAD. */
function repoAtHead(fixtureName = 'conformant-bundle') {
  const root = repoWithPolicy(fixtureName);
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  mod.writeRunRecord(root, { coveredCommit: head, coveredAt: '2026-07-30T00:00:00.000Z', lastOutcome: 'completed' });
  return { root, head };
}

test('marker: a run that finds nothing to document advances the marker and costs nothing', () => {
  // This is the specific defect feature 043 measured: the TOOL's own marker
  // (openwiki/.last-update.json) advances only when wiki content changed, so a correct "nothing to
  // document" run paid full price again next time. The free path was unreachable by construction.
  const { root, head } = repoAtHead();
  try {
    let invocations = 0;
    const first = mod.runMaintenance({
      root,
      bundleRoot: join(root, 'openwiki'),
      policy: realPolicy(),
      invoke: () => { invocations++; return { status: 0 }; },
    });

    assert.equal(first.outcome, 'nothing-to-do');
    assert.equal(first.exitCode, 0);
    assert.equal(invocations, 0, 'no model may be invoked when there is nothing to document');
    assert.equal(mod.readRunRecord(root).coveredCommit, head, 'the marker must advance');
    assert.equal(mod.readRunRecord(root).lastOutcome, 'nothing-to-do');

    // SC-004: TWO consecutive such runs must both take the cheap path.
    const second = mod.runMaintenance({
      root,
      bundleRoot: join(root, 'openwiki'),
      policy: realPolicy(),
      invoke: () => { invocations++; return { status: 0 }; },
    });
    assert.equal(second.outcome, 'nothing-to-do');
    assert.equal(invocations, 0, 'the second run must also be free');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Land a change to a covered source, so the run has real work to do. */
function commitCoveredChange(root, body = 'Changed.') {
  writeFileSync(join(root, 'docs', 'runbooks', 'local-dev.md'), `# Local dev\n\n${body}\n`);
  spawnSync('git', ['add', '-A'], { cwd: root });
  spawnSync('git', ['commit', '-qm', 'runbook change'], {
    cwd: root,
    env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.invalid' },
  });
  return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
}

test('marker: the free path does not require a credential', () => {
  // Finding nothing to document genuinely needs no model, so demanding the secret first would make
  // the cheap path depend on something it never uses.
  const { root, head } = repoAtHead();
  try {
    const result = mod.runMaintenance({
      root, bundleRoot: join(root, 'openwiki'), policy: realPolicy(),
      credential: null, requireCredential: true, invoke: () => ({ status: 0 }),
    });
    assert.equal(result.outcome, 'nothing-to-do');
    assert.equal(result.exitCode, 0);
    assert.equal(mod.readRunRecord(root).coveredCommit, head);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('marker: a missing credential is reported as a failure, never as nothing-to-do', () => {
  const { root, head } = repoAtHead();
  try {
    // There IS work outstanding — otherwise the run would legitimately take the free path and the
    // credential would never be needed.
    commitCoveredChange(root);
    const result = mod.runMaintenance({
      root,
      bundleRoot: join(root, 'openwiki'),
      policy: realPolicy(),
      credential: null, // as the CI job would see it if the secret were unset
      requireCredential: true,
      invoke: () => ({ status: 0 }),
    });
    assert.notEqual(result.outcome, 'nothing-to-do', 'the one misclassification that must never happen');
    assert.equal(result.exitCode, 2);
    assert.equal(result.reason, 'missing-credential');
    assert.equal(result.persisted, false, 'a credential failure must not rewrite the run record');
    assert.equal(mod.readRunRecord(root).lastOutcome, 'completed', 'the previous outcome stands');
    assert.equal(mod.readRunRecord(root).coveredCommit, head);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('marker: a generator failure holds the marker and records `failed`', () => {
  const { root, head } = repoAtHead();
  try {
    commitCoveredChange(root); // make there be something to document

    const result = mod.runMaintenance({
      root,
      bundleRoot: join(root, 'openwiki'),
      policy: realPolicy(),
      credential: 'present',
      invoke: () => ({ status: 0 }), // writes nothing — the 043 shape
    });

    assert.equal(result.outcome, 'failed');
    assert.equal(result.exitCode, 1);
    assert.equal(mod.readRunRecord(root).coveredCommit, head, 'the marker must NOT advance past unexamined work');
    assert.equal(mod.readRunRecord(root).lastOutcome, 'failed');
    assert.ok(mod.readRunRecord(root).backlog.length > 0, 'and the work stays outstanding');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── FR-013/FR-016: the proposal lifecycle ───────────────────────────────────────

/** An in-memory forge. Records every call, so "was a second PR opened?" is directly observable. */
function stubForge({ existing = null } = {}) {
  const calls = [];
  const state = { pulls: existing ? [{ ...existing }] : [] };
  return {
    calls,
    state,
    createPull({ head, base, title, body }) {
      calls.push({ op: 'createPull', head, base, title });
      const number = state.pulls.length + 1;
      const pull = { number, head, base, title, body, state: 'open', merged: false };
      state.pulls.push(pull);
      return pull;
    },
    getPull(number) {
      calls.push({ op: 'getPull', number });
      return state.pulls.find((p) => p.number === number) ?? null;
    },
    updatePull(number, { body, title }) {
      calls.push({ op: 'updatePull', number });
      const pull = state.pulls.find((p) => p.number === number);
      if (pull) Object.assign(pull, { body: body ?? pull.body, title: title ?? pull.title });
      return pull;
    },
  };
}

const gitIn = (root) => (...args) => spawnSync('git', args, {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.invalid' },
});

/** Write a page so the proposal has something to carry. */
function dirtyBundle(root, name) {
  writeFileSync(join(root, 'openwiki', 'invariants', name),
    `---\ntype: Convention\ntitle: ${name}\ndescription: Written by a maintenance run.\n---\nBody.\n`);
  const all = readdirSync(join(root, 'openwiki', 'invariants')).filter((f) => f.endsWith('.md') && f !== 'index.md');
  writeFileSync(join(root, 'openwiki', 'invariants', 'index.md'), `# Invariants\n${all.map((n) => `- [${n}](${n})`).join('\n')}\n`);
}

/**
 * One maintenance run, in the order CI performs it: prepare the branch, generate onto it, publish.
 * Generating on the BASE and moving the result across cannot work once a proposal is open — the run's
 * index.md is built against the base while the branch already holds earlier unmerged pages.
 */
function runOnce(root, g, forge, page, body) {
  mod.prepareProposalBranch({ root, baseBranch: 'main', git: g });
  dirtyBundle(root, page);
  const proposal = mod.publishProposal({
    root, record: mod.readRunRecord(root), forge, baseBranch: 'main', body, git: g, returnTo: 'main',
    slices: [{ area: 'invariants', pages: [page], areaExists: true, reason: 'source changed' }],
  });
  mod.writeRunRecord(root, { ...mod.readRunRecord(root), proposal });
  return proposal;
}

test('proposal: the first run opens exactly one proposal and never merges it', () => {
  const { root } = repoAtHead();
  try {
    const g = gitIn(root);
    g('branch', '-M', 'main');
    const forge = stubForge();

    const proposal = runOnce(root, g, forge, 'first.md', 'run one');

    assert.equal(forge.state.pulls.length, 1);
    assert.equal(forge.state.pulls[0].state, 'open');
    assert.equal(forge.state.pulls[0].merged, false, 'a maintenance proposal is NEVER auto-merged — a human reviews every wiki diff');
    assert.equal(proposal.number, 1);
    assert.equal(proposal.branch, mod.PROPOSAL_BRANCH);
    assert.ok(!forge.calls.some((c) => /merge/i.test(c.op)), 'nothing in the client may merge');
    assert.equal(g('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim(), 'main', 'the run leaves the workspace on the base branch');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('proposal: the run record never travels on the proposal branch', () => {
  // It advances on the base branch through its own `[skip ci]` commit. Committing it here too
  // guarantees a conflict on the next rebase — measured as "does not rebase cleanly onto main".
  const { root } = repoAtHead();
  try {
    const g = gitIn(root);
    g('branch', '-M', 'main');
    runOnce(root, g, stubForge(), 'first.md', 'run one');
    const files = g('show', '--name-only', '--format=', mod.PROPOSAL_BRANCH).stdout.trim().split('\n');
    assert.ok(!files.includes(mod.STATE_FILE), `the proposal commit must not carry ${mod.STATE_FILE}, got ${files.join(',')}`);
    assert.ok(files.some((f) => f.startsWith('openwiki/invariants/')), 'it must carry the bundle content');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('proposal: a second run appends to the open proposal rather than opening another', () => {
  const { root } = repoAtHead();
  try {
    const g = gitIn(root);
    g('branch', '-M', 'main');
    const forge = stubForge();

    const first = runOnce(root, g, forge, 'first.md', 'run one');

    // A later merge lands on main while the proposal is open.
    writeFileSync(join(root, 'docs', 'runbooks', 'later.md'), '# Later\n');
    g('add', '-A');
    g('commit', '-qm', 'later work on main');

    const second = runOnce(root, g, forge, 'second.md', 'run two');

    assert.equal(forge.state.pulls.length, 1, 'exactly one proposal must exist throughout (SC-005b)');
    assert.equal(second.number, first.number);
    assert.ok(forge.calls.some((c) => c.op === 'updatePull'), 'the open proposal is updated, not replaced');

    // It must remain mergeable against main: rebased, so main's later commit is an ancestor.
    assert.equal(g('merge-base', '--is-ancestor', 'main', mod.PROPOSAL_BRANCH).status, 0,
      'the proposal branch must be rebased onto main and stay mergeable');
    // And both runs' pages must be present — appending, not replacing.
    const files = g('ls-tree', '-r', '--name-only', mod.PROPOSAL_BRANCH).stdout;
    assert.match(files, /invariants\/first\.md/);
    assert.match(files, /invariants\/second\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('proposal: a human commit placed on the branch survives the next update', () => {
  const { root } = repoAtHead();
  try {
    const g = gitIn(root);
    g('branch', '-M', 'main');
    const forge = stubForge();

    runOnce(root, g, forge, 'first.md', 'run one');

    // A reviewer pushes a remediation commit onto the proposal branch.
    g('checkout', '-q', mod.PROPOSAL_BRANCH);
    writeFileSync(join(root, 'openwiki', 'invariants', 'first.md'),
      '---\ntype: Convention\ntitle: first.md\ndescription: Corrected by a human reviewer.\n---\nHuman correction.\n');
    g('add', '-A');
    g('commit', '-qm', 'HUMAN: fix the wording in first.md');
    g('checkout', '-q', 'main');

    // Main moves on, so the next run genuinely has to rebase.
    writeFileSync(join(root, 'docs', 'runbooks', 'later.md'), '# Later\n');
    g('add', '-A');
    g('commit', '-qm', 'later work on main');

    runOnce(root, g, forge, 'second.md', 'run two');

    const log = g('log', mod.PROPOSAL_BRANCH, '--format=%s').stdout;
    assert.match(log, /HUMAN: fix the wording/, 'rebase-and-append: a human commit must never be force-replaced away');
    const content = g('show', `${mod.PROPOSAL_BRANCH}:openwiki/invariants/first.md`).stdout;
    assert.match(content, /Human correction/, 'and their content must survive');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('proposal: closing one unmerged returns its work to the backlog and rolls the marker back', () => {
  const { root, head } = repoAtHead();
  try {
    const g = gitIn(root);
    g('branch', '-M', 'main');

    const forge = stubForge();
    const proposal = runOnce(root, g, forge, 'first.md', 'run one');
    // The run advanced its marker when it proposed the work.
    mod.writeRunRecord(root, { ...mod.readRunRecord(root), coveredCommit: 'advanced-past-the-proposal', proposal });

    forge.state.pulls[0].state = 'closed';
    forge.state.pulls[0].merged = false;

    const reconciled = mod.reconcileProposal({ root, record: mod.readRunRecord(root), forge });

    assert.equal(reconciled.record.proposal, null, 'the closed proposal is cleared');
    assert.deepEqual(reconciled.record.backlog.map((s) => s.pages), [['first.md']], 'its work returns to outstanding (SC-005c)');
    assert.equal(reconciled.record.coveredCommit, head, 'and the marker rolls back — otherwise it certifies work that never landed');
    assert.equal(mod.readRunRecord(root).coveredCommit, head, 'persisted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('proposal: a MERGED proposal is cleared without rolling anything back', () => {
  const { root } = repoAtHead();
  try {
    const g = gitIn(root);
    g('branch', '-M', 'main');
    const forge = stubForge();
    const proposal = runOnce(root, g, forge, 'first.md', 'run one');
    mod.writeRunRecord(root, { ...mod.readRunRecord(root), coveredCommit: 'advanced', proposal });

    forge.state.pulls[0].state = 'closed';
    forge.state.pulls[0].merged = true;

    const reconciled = mod.reconcileProposal({ root, record: mod.readRunRecord(root), forge });
    assert.equal(reconciled.record.proposal, null);
    assert.equal(reconciled.record.coveredCommit, 'advanced', 'the work landed, so the marker holds');
    assert.deepEqual(reconciled.record.backlog, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── FR-026f: an event-driven path whose event happened but whose document does not exist ─────────

/** A repo with a spec and a plan, so a decision can be "reached" in the range under test. */
function repoWithSpecs() {
  const root = repoWithPolicy('conformant-bundle');
  const g = gitIn(root);
  mkdirSync(join(root, 'specs', '099-example'), { recursive: true });
  writeFileSync(join(root, 'specs', '099-example', 'spec.md'),
    '# Spec\n\n## Clarifications\n\n### Session 2026-07-01\n\n- Q: One thing? → A: Yes.\n');
  writeFileSync(join(root, 'specs', '099-example', 'plan.md'),
    '# Plan\n\n## Complexity Tracking\n\n| Violation | Why needed | Simpler alternative rejected because |\n|---|---|---|\n| None | — | — |\n');
  mkdirSync(join(root, 'docs', 'decisions'), { recursive: true });
  writeFileSync(join(root, 'docs', 'decisions', 'ADR-0001-example.md'), '# ADR-0001\n');
  g('add', '-A');
  g('commit', '-qm', 'specs baseline');
  return { root, g, base: g('rev-parse', 'HEAD').stdout.trim() };
}

test('missing-event: a new clarification with no decision record is REPORTED', () => {
  const { root, g, base } = repoWithSpecs();
  try {
    writeFileSync(join(root, 'specs', '099-example', 'spec.md'),
      '# Spec\n\n## Clarifications\n\n### Session 2026-07-01\n\n- Q: One thing? → A: Yes.\n\n### Session 2026-07-30\n\n- Q: Store secrets where? → A: Komodo Variables, not Vault.\n');
    g('add', '-A');
    g('commit', '-qm', 'clarification');

    const findings = mod.detectMissingEventDocuments({ root, sinceCommit: base, policy: realPolicy() });

    assert.equal(findings.length, 1, `expected one finding, got ${JSON.stringify(findings)}`);
    assert.match(findings[0].reason, /clarification/i);
    assert.match(findings[0].source, /specs\/099-example\/spec\.md/);
    assert.equal(findings[0].path, 'docs/decisions/**');
    assert.equal(findings[0].blocking, false, 'a candidate missing record must never block the run');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing-event: a new Complexity Tracking row with no decision record is REPORTED', () => {
  const { root, g, base } = repoWithSpecs();
  try {
    writeFileSync(join(root, 'specs', '099-example', 'plan.md'),
      '# Plan\n\n## Complexity Tracking\n\n| Violation | Why needed | Simpler alternative rejected because |\n|---|---|---|\n| None | — | — |\n| Reused CD_PUSH_TOKEN | avoids a new store entry | minting one adds a credential |\n');
    g('add', '-A');
    g('commit', '-qm', 'complexity row');

    const findings = mod.detectMissingEventDocuments({ root, sinceCommit: base, policy: realPolicy() });
    assert.equal(findings.length, 1);
    assert.match(findings[0].reason, /complexity/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing-event: a decision reached AND recorded reports nothing', () => {
  const { root, g, base } = repoWithSpecs();
  try {
    writeFileSync(join(root, 'specs', '099-example', 'spec.md'),
      '# Spec\n\n## Clarifications\n\n### Session 2026-07-01\n\n- Q: One thing? → A: Yes.\n\n### Session 2026-07-30\n\n- Q: Another? → A: Yes.\n');
    writeFileSync(join(root, 'docs', 'decisions', 'ADR-0002-new.md'), '# ADR-0002\n\nThe decision.\n');
    g('add', '-A');
    g('commit', '-qm', 'clarification with its record');

    assert.deepEqual(mod.detectMissingEventDocuments({ root, sinceCommit: base, policy: realPolicy() }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing-event: an unrelated change reports nothing', () => {
  const { root, g, base } = repoWithSpecs();
  try {
    writeFileSync(join(root, 'docs', 'runbooks', 'local-dev.md'), '# Local dev\n\nA change with no decision in it.\n');
    g('add', '-A');
    g('commit', '-qm', 'runbook edit');
    assert.deepEqual(mod.detectMissingEventDocuments({ root, sinceCommit: base, policy: realPolicy() }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing-event: the finding reaches the plan output', () => {
  const { root, g, base } = repoWithSpecs();
  try {
    writeFileSync(join(root, 'specs', '099-example', 'spec.md'),
      '# Spec\n\n## Clarifications\n\n### S1\n\n- Q: a? → A: b.\n\n### S2\n\n- Q: c? → A: d.\n');
    g('add', '-A');
    g('commit', '-qm', 'clarification');

    const plan = mod.computePlan({ root, bundleRoot: join(root, 'openwiki'), since: base, policy: realPolicy() });
    assert.ok(Array.isArray(plan.missingEventDocuments));
    assert.equal(plan.missingEventDocuments.length, 1, 'FR-026f: surfacing it may be a proposal, but must not be silence');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── FR-020/FR-021: the local path is the SAME path ──────────────────────────────

test('local parity: the generator is invoked through the Nx target, never as a bare CLI call', () => {
  // A bare `openwiki` call skips the telemetry opt-out and the raised Node heap, and OOMs. The target
  // is where the pinned model, the heap and OPENWIKI_TELEMETRY_DISABLED=1 live.
  assert.deepEqual(mod.generatorCommand().slice(0, 4), ['pnpm', 'nx', 'wiki-update', 'infrastructure-as-code']);

  const source = readFileSync(SCRIPT, 'utf8');
  const code = source.split('\n').filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'));
  const bare = code.filter((l) => /['"`]openwiki['"`]\s*,|spawnSync\(\s*['"]openwiki/.test(l));
  assert.deepEqual(bare, [], 'no code path may invoke the openwiki CLI directly');
});

test('local parity: --max-slices bounds the invocation and --since overrides the marker', () => {
  const bounded = mod.parseArgs(['--execute', '--max-slices', '2']);
  assert.equal(bounded.maxSlices, 2);
  assert.equal(mod.parseArgs(['--plan', '--since', 'HEAD~5']).since, 'HEAD~5');
  assert.equal(mod.parseArgs(['--plan', '--since=abc1234']).since, 'abc1234');

  // --since must actually change the range the plan is computed over, not just be accepted.
  const { root } = repoAtHead();
  try {
    const g = gitIn(root);
    commitCoveredChange(root);
    const marked = mod.computePlan({ root, bundleRoot: join(root, 'openwiki'), policy: realPolicy() });
    const overridden = mod.computePlan({ root, bundleRoot: join(root, 'openwiki'), since: g('rev-parse', 'HEAD').stdout.trim(), policy: realPolicy() });
    assert.ok(marked.slices.length > 0, 'the recorded marker leaves the runbook change outstanding');
    assert.equal(overridden.slices.length, 0, '--since HEAD leaves nothing in range');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('local parity: CI and local drive the identical entry point', () => {
  // FR-020. If the workflow had its own orchestration, the local path would stop being a rehearsal of
  // the CI one and the two would drift — which is how "works locally" starts meaning nothing.
  const workflow = readFileSync(join(REPO_ROOT, '.forgejo', 'workflows', 'wiki-maintain.yml'), 'utf8');
  assert.match(workflow, /node scripts\/wiki-maintain\.mjs --execute/);
  assert.match(workflow, /node scripts\/wiki-maintain\.mjs --plan/);
  assert.doesNotMatch(workflow, /openwiki code/, 'CI must not invoke the generator itself either');

  const project = JSON.parse(readFileSync(join(REPO_ROOT, 'infrastructure-as-code', 'project.json'), 'utf8'));
  // The other half of the scoping surface. `nx --args` STRIPS the quoting from its value, so a message
  // passed that way reaches `sh -c` as bare words and the generator runs UNSCOPED — measured, at the
  // cost of a paid run. The quoting has to live in the target's own command string, which nx leaves
  // alone, and the target must still behave exactly as before when the variable is unset.
  const updateCmd = project.targets['wiki-update'].options.command;
  assert.match(updateCmd, /"\$WIKI_RUN_MESSAGE"/, 'the target must quote the message variable itself');
  assert.match(updateCmd, /openwiki code --update --print$|openwiki code --update --print;/, 'and fall back to an unscoped refresh when it is unset');
  assert.doesNotMatch(updateCmd, /--args/, 'the message must not travel through nx --args');
  assert.equal(project.targets['wiki-plan'].options.command, 'node scripts/wiki-maintain.mjs --plan');
  assert.equal(project.targets['wiki-maintain'].options.command, 'node scripts/wiki-maintain.mjs --execute');
  for (const t of ['wiki-plan', 'wiki-maintain']) {
    assert.ok(project.targets[t].metadata?.description?.length > 80,
      `${t} needs a description saying why the target must be used rather than a bare call`);
  }
});
