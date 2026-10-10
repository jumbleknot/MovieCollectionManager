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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'wiki-maintain.mjs');

// `import(SCRIPT)` with a bare absolute path is a valid specifier on POSIX and INVALID on Windows,
// where the leading drive letter is read as a URL protocol: ERR_UNSUPPORTED_ESM_URL_SCHEME, "Received
// protocol 'e:'". Because this is at module scope it aborts the WHOLE FILE before a single case runs
// — which is why the Windows baseline collected 408 tests against Linux's 471. Those 63 cases were
// not failing; they were never collected, and a suite that silently shrinks looks greener than one
// that goes red.
const mod = await import(pathToFileURL(SCRIPT).href);
const claimsMod = await import(pathToFileURL(join(REPO_ROOT, 'scripts', 'openwiki-claims.mjs')).href);

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
    // Every field written comes back unchanged. The one addition is a documented default: 078 US6's
    // `escalations` reads as `{}` when a record has none (FR-018), so the expectation names it rather
    // than loosening the comparison.
    assert.deepEqual(read, { ...record, escalations: {} });
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
  // Scrub EVERY name the script accepts a credential from, read from the script itself. Item #209:
  // this deleted `ANTHROPIC_API_KEY` alone while wiki-maintain.mjs had long since also accepted
  // `MCM_ANTHROPIC_API_KEY` — the name CLAUDE.md says the key is actually carried under in all three
  // sanctioned environments. So "with NO model credential" was false wherever anyone really works,
  // and `--execute` sailed past its own guard into the real path.
  for (const name of mod.CREDENTIAL_ENV_NAMES) delete clean[name];
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

test('budget: the defaults are the 078 R9 decision — one 8-page invocation per run', () => {
  // Updated 2026-09-28 (feature 078, research R9, operator sign-off): the generator moved to a slower,
  // far cheaper model at concurrency 4, and one 8-page invocation measures at 15–23 min (two waves of
  // page workers). The time budget is a START deadline, so it is sized to leave room for one worst-case
  // invocation inside the job timeout — which makes the run ~one invocation, i.e. ~8 pages.
  assert.equal(mod.PAGE_BUDGET, mod.MAX_PAGES_PER_INVOCATION, 'one invocation\'s worth of pages per run');
  assert.equal(mod.MAX_PAGES_PER_INVOCATION, 8);
  assert.equal(mod.TIME_BUDGET_SECONDS, 4 * 60, 'a start deadline, not a run length');
  assert.equal(mod.WORST_INVOCATION_SECONDS, 30 * 60, 'measured 23 min worst for two waves, +30%');
  const header = readFileSync(SCRIPT, 'utf8');
  const c6 = header.slice(header.indexOf('C6 — the run budget'));
  // FR-011a/FR-011c/FR-011d must be stated where someone changing the numbers will read them.
  const ceilingMin = (mod.TIME_BUDGET_SECONDS + mod.WORST_INVOCATION_SECONDS) / 60;
  assert.match(c6, new RegExp(`≤${mod.PAGE_BUDGET + mod.MAX_PAGES_PER_INVOCATION} pages / ~${ceilingMin} minutes`),
    'the effective ceiling must be declared, and must be the one these constants produce');
  assert.match(c6, /runner occupancy/i, 'and what the wall-clock budget actually bounds');
  assert.match(c6, /NEITHER BUDGET IS A MONETARY BOUND/, 'and that neither is a cost control');
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

// ── C0: the harness itself — item #209 ──────────────────────────────────────
//
// The credential-absence tests below are only meaningful if the absence is CONSTRUCTED. For months
// it was merely INHERITED from whatever the ambient environment happened to lack, so every one of
// them passed on CI (which sets neither name for this job) and failed on every developer machine
// (which sets `MCM_ANTHROPIC_API_KEY`). A guard on the harness is the only thing that catches that,
// because each individual test still looks correct.

test('harness: runCli scrubs EVERY credential name the script accepts, not a stale subset', () => {
  // Derived from the script, never re-listed here — re-listing is the defect (#209).
  assert.ok(mod.CREDENTIAL_ENV_NAMES.length > 0, 'the script exposes no credential names to scrub');

  for (const name of mod.CREDENTIAL_ENV_NAMES) {
    // Inject the name explicitly so the assertion does NOT depend on the ambient environment: this
    // must fail on CI (where nothing is set) just as loudly as on a developer machine.
    const { code, out } = runCli(['--execute'], { env: { [name]: 'sk-ant-planted-by-the-test' } });
    assert.equal(
      code, 2,
      `with ${name} planted, the child still reached the real path instead of the exit-2 credential ` +
        `guard — so a credential survived runCli's scrub.\n` +
        `  It is NOT necessarily ${name} that leaked: any name in CREDENTIAL_ENV_NAMES ` +
        `(${mod.CREDENTIAL_ENV_NAMES.join(', ')}) left in the ambient environment does this, which is ` +
        'exactly how #209 hid — the scrub listed one name and the script accepted two.\n' +
        `  Scrub the list from the script, never a copy of it.\n${out}`,
    );
  }
});

test('harness: running the suite leaves the TRACKED maintenance state untouched', () => {
  // The second half of #209, and the same root cause: a leaked credential let --execute run the real
  // path, which persisted `nothing-to-do` over a marker no maintenance run produced. A `git add -A`
  // before committing would then falsify the record that decides when the wiki is next refreshed.
  const r = spawnSync('git', ['status', '--porcelain', '--', mod.STATE_FILE], {
    cwd: REPO_ROOT, encoding: 'utf8',
  });
  assert.equal(
    (r.stdout ?? '').trim(), '',
    `running this suite modified ${mod.STATE_FILE}:\n${r.stdout}\n` +
      '  No test may write tracked state. Restore it and fix the write at its cause.',
  );
});

test('CLI: --execute without a credential exits 2 rather than pretending there was nothing to do', () => {
  // FR-017: a credential failure must NEVER be reported as `nothing-to-do`. That is the one
  // misclassification that makes the cheap path look reachable while the work silently never happens.
  const { code, out } = runCli(['--execute']);
  assert.equal(code, 2, `expected exit 2, got ${code}\n${out}`);
  assert.match(out, /ANTHROPIC_API_KEY/);
  assert.doesNotMatch(out, /nothing-to-do/);
});

// `--since HEAD` rather than `HEAD~1`: CI checks this repository out SHALLOW (`fetch-depth: 1`), so
// `HEAD~1` is not in the clone and the test died on a git error having nothing to do with what it was
// testing. `HEAD` resolves everywhere. The shallow-marker path itself is covered separately below.
test('CLI: --dry-run persists nothing and invokes nothing', () => {
  const stateFile = join(REPO_ROOT, mod.STATE_FILE);
  const before = existsSync(stateFile) ? readFileSync(stateFile, 'utf8') : null;

  const { code, out, invoked } = runCli(['--execute', '--dry-run', '--since', 'HEAD'], { ANTHROPIC_API_KEY: 'not-a-real-key' });
  assert.equal(invoked, '', 'a dry run must invoke nothing');
  assert.equal(code, 0, out);
  if (/slice/i.test(out)) assert.match(out, /pnpm nx wiki-update infrastructure-as-code/);

  // A dry run must persist NOTHING. This test caught the real thing: the nothing-to-do branch
  // advanced the marker even under --dry-run, so asking "what would this do?" certified the range as
  // covered and the next real run skipped work nobody had done.
  const after = existsSync(stateFile) ? readFileSync(stateFile, 'utf8') : null;
  assert.equal(after, before, 'a dry run must not touch the run record');
});

test('dry run renders the exact command and message per slice, and invokes nothing', () => {
  const root = tmpGitRepo('conformant-bundle');
  try {
    let invoked = 0;
    const result = mod.executeSlices({
      root,
      bundleRoot: join(root, 'openwiki'),
      slices: [{ area: 'gotchas', pages: ['a.md', 'b.md'], areaExists: true, reason: 'r' }],
      record: mod.readRunRecord(root),
      dryRun: true,
      invoke: () => { invoked++; return { status: 0 }; },
    });
    assert.equal(invoked, 0, 'a dry run must invoke nothing');
    assert.equal(result.persisted, false, 'and persist nothing');
    assert.deepEqual(result.results[0].command.slice(0, 4), ['pnpm', 'nx', 'wiki-update', 'infrastructure-as-code']);
    assert.match(result.results[0].runMessage, /openwiki\/gotchas\/a\.md/);
    assert.match(result.results[0].runMessage, /openwiki\/gotchas\/b\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a marker that is not in this checkout falls back to a full sweep rather than dying', () => {
  // CI checks out shallow, so the committed marker may simply not be in the clone — and `git diff
  // <marker>..HEAD` then fails with "unknown revision". Falling back to the full tree is safe (the
  // budget bounds the run) and correct; failing there would be a run broken for a reason having
  // nothing to do with the documentation.
  const root = tmpGitRepo('conformant-bundle');
  try {
    const unreachable = 'f'.repeat(40);
    const paths = mod.changedSince(root, unreachable);
    assert.ok(paths.length > 0, 'an unreachable marker sweeps the tree instead of throwing');
    assert.equal(paths.sinceResolved, false, 'and says so, rather than pretending the range was honoured');

    const plan = mod.computePlan({ root, bundleRoot: join(root, 'openwiki'), since: unreachable });
    assert.equal(plan.sinceResolved, false, 'the plan reports it, so a reviewer knows why the sweep is large');

    // A marker that IS reachable behaves normally.
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    assert.notEqual(mod.changedSince(root, head).sinceResolved, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

// ── 078 US2 / FR-007: one generator run per group of areas, not one per area ─────────
//
// Every generator invocation pays a fixed planning pass (~$0.33 on Sonnet, research R5) whatever its
// scope, and slices are per area. Packing same-kind slices into one invocation pays it once. The
// per-area SLICE stays the unit of planning, backlog and carry-forward, so the committed backlog's
// shape does not change and a failure still narrows to the areas that actually failed.

const ONE_AREA_MESSAGE = 'Work on exactly one area of the knowledge bundle this run: openwiki/runbooks/. Write or refresh these pages, each followed by its subject in brackets where given: openwiki/runbooks/ci-diagnostics.md; openwiki/runbooks/backups.md (scheduled backups). The openwiki/runbooks/ directory already exists; leave the pages in it that are not listed above exactly as they are. Also update openwiki/runbooks/index.md so that every page in that directory is listed there, including the ones above — the conformance gate rejects an unlisted page. Do not write anywhere else: no other directory of openwiki/, and nothing outside openwiki/. Follow openwiki/INSTRUCTIONS.md: a distilled summary plus the load-bearing gotchas, citing the authoritative source in a resource field where one exists, and no resource field on a page that is authoritative in its own right. Where this run relocates existing prose, move it VERBATIM: no abridgement, no rewording, no reordering.';

const sl = (area, pages, kind = 'refresh', extra = {}) => ({ area, pages, kind, areaExists: true, reason: `r:${area}`, subjects: {}, ...extra });

test('packing: same-kind slices across areas share one invocation, up to the page cap', () => {
  const a = sl('runbooks', ['x.md', 'y.md']);
  const b = sl('gotchas', ['z.md', 'w.md']);
  const c = sl('projects', ['v.md']);
  const groups = mod.packSlices([a, b, c], { maxPagesPerInvocation: 8 });
  assert.equal(groups.length, 1, '3 areas, 5 pages → ONE invocation');
  assert.deepEqual(groups[0].parts, [a, b, c], 'the original slices, in plan order');

  const many = [sl('runbooks', ['1', '2', '3', '4', '5']), sl('gotchas', ['6', '7', '8', '9']), sl('projects', ['10', '11', '12'])];
  const packed = mod.packSlices(many, { maxPagesPerInvocation: 8 });
  for (const g of packed) {
    const n = mod.partsOf(g).reduce((k, p) => k + p.pages.length, 0);
    assert.ok(n <= 8 || mod.partsOf(g).length === 1, `an invocation holds at most 8 pages unless one slice alone is larger (got ${n})`);
  }
  assert.deepEqual(packed.flatMap(mod.partsOf), many, 'nothing lost, nothing reordered');
});

test('packing: refreshes and creations are never mixed in one invocation', () => {
  const groups = mod.packSlices([sl('runbooks', ['a.md']), sl('gotchas', ['new.md'], 'create'), sl('projects', ['b.md'])], { maxPagesPerInvocation: 8 });
  for (const g of groups) assert.equal(new Set(mod.partsOf(g).map((p) => p.kind)).size, 1, 'one kind per invocation');
});

test('packing: two slices of the SAME area are never re-merged — the planner split them on purpose', () => {
  // planSlices only produces two same-kind slices for one area when that area exceeds the slice cap;
  // packing them back together would undo that decision.
  const a1 = sl('runbooks', ['1.md', '2.md']);
  const a2 = sl('runbooks', ['3.md']);
  const groups = mod.packSlices([a1, a2], { maxPagesPerInvocation: 8 });
  assert.deepEqual(groups, [a1, a2]);
});

test('packing: a group of one is the slice itself, so a one-area run is unchanged', () => {
  const only = sl('runbooks', ['a.md']);
  const [g] = mod.packSlices([only], { maxPagesPerInvocation: 8 });
  assert.equal(g, only, 'identity: invoke, verify and report see exactly what they always did');
});

test('message: a one-area slice renders byte-for-byte as before', () => {
  assert.equal(
    mod.renderRunMessage({ area: 'runbooks', pages: ['ci-diagnostics.md', 'backups.md'], areaExists: true, subjects: { 'backups.md': 'scheduled backups' } }),
    ONE_AREA_MESSAGE,
  );
});

test('message: a multi-area invocation names every page, every index, and bounds writes to those areas', () => {
  const [g] = mod.packSlices([
    sl('runbooks', ['ci-diagnostics.md'], 'refresh', { subjects: { 'ci-diagnostics.md': 'CI triage' } }),
    sl('gotchas', ['env-files.md']),
  ], { maxPagesPerInvocation: 8 });
  const m = mod.renderRunMessage(g);
  assert.match(m, /openwiki\/runbooks\/ci-diagnostics\.md \(CI triage\)/);
  assert.match(m, /openwiki\/gotchas\/env-files\.md/);
  assert.match(m, /openwiki\/runbooks\/index\.md/);
  assert.match(m, /openwiki\/gotchas\/index\.md/);
  assert.match(m, /no directory of openwiki\/ other than openwiki\/runbooks\/ and openwiki\/gotchas\//);
  assert.doesNotMatch(m, /exactly one area/, 'the one-area wording would contradict the page list');
  assert.doesNotMatch(m, /["`$\\\n\r]/, 'one safe line');
});

/** conformant-bundle plus a second existing area, committed. */
function twoAreaRepo() {
  const root = tmpGitRepo('conformant-bundle');
  mkdirSync(join(root, 'openwiki', 'gotchas'), { recursive: true });
  writeFileSync(join(root, 'openwiki', 'gotchas', 'index.md'), '# Gotchas\n');
  writeFileSync(join(root, 'openwiki', 'index.md'),
    '---\nokf_version: "0.1"\n---\n# Knowledge Bundle (fixture)\n- [invariants](invariants/index.md)\n- [gotchas](gotchas/index.md)\n');
  spawnSync('git', ['add', '-A'], { cwd: root });
  spawnSync('git', ['commit', '-qm', 'second area'], { cwd: root });
  return root;
}

test('verify: a page missing from the SECOND area is reported by area/page', () => {
  const root = twoAreaRepo();
  try {
    const [g] = mod.packSlices([sl('invariants', ['one.md']), sl('gotchas', ['two.md'])], { maxPagesPerInvocation: 8 });
    const before = mod.snapshotTree(root);
    writingStub(root, 'invariants', ['one.md'])();
    const v = mod.verifySlice({ root, bundleRoot: join(root, 'openwiki'), slice: g, before });
    assert.equal(v.ok, false);
    assert.ok(v.violations.some((x) => /gotchas\/two\.md/.test(x)), v.violations.join('\n'));
    assert.ok(!v.violations.some((x) => /invariants\/one\.md/.test(x)), 'the part that landed is not blamed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('execute: three areas are written by ONE invocation (SC-003), and every page is verified', () => {
  const root = twoAreaRepo();
  try {
    const calls = [];
    const result = mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'), record: mod.readRunRecord(root),
      slices: [sl('invariants', ['one.md']), sl('gotchas', ['two.md', 'three.md'])],
      invoke: (work) => {
        calls.push(work);
        writingStub(root, 'invariants', ['one.md'])();
        writingStub(root, 'gotchas', ['two.md', 'three.md'])();
        return { status: 0 };
      },
    });
    assert.equal(calls.length, 1, 'one generator run for both areas');
    assert.equal(result.outcome, 'completed', JSON.stringify(result.results.map((r) => r.violations)));
    assert.equal(result.pagesWritten, 3);
    assert.deepEqual(result.backlog, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('execute: when one area of a group fails, ONLY that area is carried forward', () => {
  const root = twoAreaRepo();
  try {
    const good = sl('invariants', ['one.md']);
    const bad = sl('gotchas', ['two.md']);
    const result = mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'), record: mod.readRunRecord(root),
      slices: [good, bad], attemptsPerSlice: 1,
      invoke: () => { writingStub(root, 'invariants', ['one.md'])(); return { status: 0 }; },
    });
    assert.equal(result.outcome, 'failed');
    assert.deepEqual(result.backlog, [bad], 'the landed area is not redone next run');
    assert.ok(existsSync(join(root, 'openwiki', 'invariants', 'one.md')), 'and its page is kept');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('execute: the LANDED part of a failed group is counted and proposable, not just left on the runner', () => {
  // Measured 2026-10-01, run 4399: runbooks/backlog.md verified, projects/sast.md was still stale when
  // the deadline stopped the generator. The group failed, so main() proposed nothing (it proposed only
  // r.ok results) — and the backlog carried only the failed part, so the landed page was LOST: not
  // proposed, not re-queued, and its source change was already behind the marker. A failure
  // attributable to a part (missing/stale; conformance and policy clean) must leave the landed parts
  // proposable.
  const root = twoAreaRepo();
  try {
    const good = sl('invariants', ['one.md']);
    const bad = sl('gotchas', ['two.md']);
    const result = mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'), record: mod.readRunRecord(root),
      slices: [good, bad], attemptsPerSlice: 1,
      invoke: () => { writingStub(root, 'invariants', ['one.md'])(); return { status: 0 }; },
    });
    assert.equal(result.outcome, 'failed', 'the run still reports the failure');
    assert.deepEqual(result.backlog, [bad], 'only the failed part is redone');
    assert.deepEqual(result.results[0].landedParts, [good]);
    assert.equal(result.pagesWritten, 1, 'the landed page counts, so a proposal is published');
    assert.deepEqual(mod.proposableSlices(result), [good], 'and it is what the proposal carries');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('execute (#685): a failed part\'s restore-only change does NOT ride along with the landed part (run 4801)', () => {
  // Run 4801: projects/sast verified; runbooks/sast-scanning's worker exited without submitting, and
  // openwiki's restore path rewrote that page WITHOUT its `verified:` block and re-hashed its sidecar
  // to match. V16 stayed sound, so no gate noticed — and the landed part's proposal carried the failed
  // page too. Merging it would have erased a verification event for a page that was never regenerated.
  const root = twoAreaRepo();
  try {
    writeFileSync(join(root, 'README.md'), 'source\n');
    const page = (verified) => `---\ntype: Convention\ntitle: two\ndescription: Stale.\nresource: README.md\ntimestamp: 2020-01-01T00:00:00Z\n${verified}---\nBody.\n`;
    const certifiedPage = page('verified:\n  - by: openwiki/0.6.0\n    at: 2020-01-02T00:00:00Z\n');
    const hash = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
    const sidecar = (text) => JSON.stringify({ pageVersion: hash(text), verification: { by: 'openwiki/0.6.0', at: '2020-01-02T00:00:00Z' }, claims: [] });
    const manifest = (text) => `${JSON.stringify({ schemaVersion: 1, pages: { '/openwiki/gotchas/two.md': { pageVersion: hash(text) } } }, null, 2)}\n`;
    writeFileSync(join(root, 'openwiki', 'gotchas', 'two.md'), certifiedPage);
    writeFileSync(join(root, 'openwiki', 'gotchas', 'index.md'), '# Gotchas\n- [two](two.md)\n');
    mkdirSync(join(root, 'openwiki', '.claims', 'gotchas'), { recursive: true });
    writeFileSync(join(root, 'openwiki', '.claims', 'gotchas', 'two.json'), sidecar(certifiedPage));
    writeFileSync(join(root, 'openwiki', '.page-manifest.json'), manifest(certifiedPage));
    spawnSync('git', ['add', '-A'], { cwd: root });
    spawnSync('git', ['commit', '-qm', 'certified, stale page'], { cwd: root });
    const committed = (rel) => spawnSync('git', ['show', `HEAD:${rel}`], { cwd: root, encoding: 'utf8' }).stdout;

    const good = sl('invariants', ['one.md']);
    const restoredOnly = sl('gotchas', ['two.md']);
    const logged = [];
    const realError = console.error;
    console.error = (...args) => { logged.push(args.join(' ')); };
    let result;
    try {
      result = mod.executeSlices({
        root, bundleRoot: join(root, 'openwiki'), record: mod.readRunRecord(root),
        slices: [good, restoredOnly], attemptsPerSlice: 1,
        invoke: () => {
          writingStub(root, 'invariants', ['one.md'])();
          // openwiki's restore path: the page loses `verified:`, sidecar and manifest re-hashed to match.
          const restored = page('');
          writeFileSync(join(root, 'openwiki', 'gotchas', 'two.md'), restored);
          writeFileSync(join(root, 'openwiki', '.claims', 'gotchas', 'two.json'), sidecar(restored));
          writeFileSync(join(root, 'openwiki', '.page-manifest.json'), manifest(restored));
          return { status: 0 };
        },
      });
    } finally {
      console.error = realError;
    }

    assert.equal(result.outcome, 'failed');
    assert.deepEqual(result.results[0].stalePages, ['gotchas/two.md'], 'premise: the restore-only page failed as stale');
    assert.deepEqual(mod.proposableSlices(result), [good], 'the landed part is still proposed');
    for (const rel of ['openwiki/gotchas/two.md', 'openwiki/.claims/gotchas/two.json']) {
      assert.equal(readFileSync(join(root, rel), 'utf8'), committed(rel), `${rel} is back at its committed bytes`);
    }
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'openwiki', '.page-manifest.json'), 'utf8')),
      JSON.parse(committed('openwiki/.page-manifest.json')), 'and its manifest entry with it');
    assert.ok(existsSync(join(root, 'openwiki', 'invariants', 'one.md')), 'the landed page is untouched');
    const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout;
    assert.doesNotMatch(dirty, /gotchas\/two|\.claims|page-manifest/, `nothing of the failed part is left to ride along:\n${dirty}`);
    assert.ok(logged.some((l) => /\[wiki-maintain\].*restored.*gotchas\/two\.md/.test(l)), `the run says what it restored:\n${logged.join('\n')}`);
    const okf = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'check-openwiki-okf.mjs'), '--bundle', join(root, 'openwiki')], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.doesNotMatch(`${okf.stdout}${okf.stderr}`, /V16/, 'and V16 stays sound');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('execute (#685): a failed part\'s path that was ALREADY dirty before the invocation is left alone', () => {
  const root = twoAreaRepo();
  try {
    writeFileSync(join(root, 'README.md'), 'source\n');
    const page = (body) => `---\ntype: Convention\ntitle: two\ndescription: Stale.\nresource: README.md\ntimestamp: 2020-01-01T00:00:00Z\n---\n${body}\n`;
    writeFileSync(join(root, 'openwiki', 'gotchas', 'two.md'), page('Committed.'));
    writeFileSync(join(root, 'openwiki', 'gotchas', 'index.md'), '# Gotchas\n- [two](two.md)\n');
    spawnSync('git', ['add', '-A'], { cwd: root });
    spawnSync('git', ['commit', '-qm', 'stale page'], { cwd: root });
    // An operator's uncommitted edit: its bytes are not in git, so restoring would destroy it.
    writeFileSync(join(root, 'openwiki', 'gotchas', 'two.md'), page('Operator edit.'));

    const result = mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'), record: mod.readRunRecord(root),
      slices: [sl('invariants', ['one.md']), sl('gotchas', ['two.md'])], attemptsPerSlice: 1,
      invoke: () => { writingStub(root, 'invariants', ['one.md'])(); return { status: 0 }; },
    });
    assert.equal(result.outcome, 'failed');
    assert.match(readFileSync(join(root, 'openwiki', 'gotchas', 'two.md'), 'utf8'), /Operator edit\./);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── #683: a rate-limited attempt is recognised from the tap, waited out, and named ────────────────

/** Capture console.error lines while `fn` runs. */
function capturingErrors(fn) {
  const lines = [];
  const real = console.error;
  console.error = (...args) => { lines.push(args.join(' ')); };
  try {
    return { value: fn(), lines };
  } finally {
    console.error = real;
  }
}

/** A generator stub that writes nothing and logs `n429` tap lines answering 429 (run 4798's shape). */
const rateLimitedStub = (n429, { ok = 0 } = {}) => (_slice, { usageLog }) => {
  const lines = [
    ...Array.from({ length: ok }, () => ({ kind: 'chat', status: 200, ms: 5 })),
    ...Array.from({ length: n429 }, () => ({ kind: 'chat', status: 429, ms: 5 })),
  ];
  writeFileSync(usageLog, lines.map((l) => `${JSON.stringify(l)}\n`).join(''), { flag: 'a' });
  return { status: 0 };
};

test('execute (#683): a rate-limited attempt WAITS before retrying, and the run says it was rate-limited', () => {
  const root = tmpGitRepo('conformant-bundle');
  try {
    let t = 0;
    const slept = [];
    let call = 0;
    const { value: result, lines } = capturingErrors(() => mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'), record: mod.readRunRecord(root),
      slices: [sl('invariants', ['one.md'])],
      clock: () => t,
      sleep: (ms) => { slept.push(ms); t += ms; },
      invoke: (slice, ctx) => {
        call++;
        t += 10_000;
        if (call === 1) return rateLimitedStub(2, { ok: 1 })(slice, ctx);
        return writingStub(root, 'invariants', ['one.md'])();
      },
    }));
    assert.equal(call, 2, 'retried once the wait was over');
    assert.deepEqual(slept, [mod.RATE_LIMIT_BACKOFF_MS[0]], 'one bounded wait, before the retry');
    assert.equal(result.outcome, 'completed');
    assert.deepEqual(result.results[0].rateLimited, { attempts: 1, calls: 2 });
    assert.ok(lines.some((l) => /\[wiki-maintain\].*RATE-LIMITED.*429.*waiting/i.test(l)), lines.join('\n'));
    assert.deepEqual(mod.readRunRecord(root).lastRunInvocations[0].rateLimited, { attempts: 1, calls: 2 }, 'the run record names it too');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('execute (#683): a rate limit whose wait would overrun the start budget is NOT retried, and is reported as a rate limit', () => {
  const root = tmpGitRepo('conformant-bundle');
  try {
    let t = 0;
    const slept = [];
    let call = 0;
    const { value: result, lines } = capturingErrors(() => mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'), record: mod.readRunRecord(root),
      slices: [sl('invariants', ['one.md'])],
      timeBudgetSeconds: 30,
      clock: () => t,
      sleep: (ms) => { slept.push(ms); t += ms; },
      invoke: (slice, ctx) => { call++; t += 10_000; return rateLimitedStub(3)(slice, ctx); },
    }));
    assert.equal(call, 1, 'retrying straight into an active rate limit cannot succeed');
    assert.deepEqual(slept, []);
    assert.equal(result.outcome, 'failed');
    assert.deepEqual(result.results[0].rateLimited, { attempts: 1, calls: 3 });
    assert.ok(lines.some((l) => /\[wiki-maintain\].*RATE-LIMITED.*not retrying/i.test(l)), lines.join('\n'));
    assert.ok(!lines.some((l) => /produced nothing — retrying/.test(l)), 'never the ordinary "produced nothing" retry');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('execute (#683): an attempt that produced nothing WITHOUT a 429 keeps today\'s immediate retry', () => {
  const root = tmpGitRepo('conformant-bundle');
  try {
    let t = 0;
    const slept = [];
    let call = 0;
    const { value: result, lines } = capturingErrors(() => mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'), record: mod.readRunRecord(root),
      slices: [sl('invariants', ['one.md'])],
      clock: () => t,
      sleep: (ms) => { slept.push(ms); t += ms; },
      invoke: (slice, ctx) => {
        call++;
        t += 10_000;
        // A 500 is a failed call, but not a rate limit.
        if (call === 1) { writeFileSync(ctx.usageLog, `${JSON.stringify({ kind: 'chat', status: 500, ms: 5 })}\n`, { flag: 'a' }); return { status: 0 }; }
        return writingStub(root, 'invariants', ['one.md'])();
      },
    }));
    assert.equal(call, 2);
    assert.deepEqual(slept, [], 'no wait');
    assert.equal(result.outcome, 'completed');
    assert.equal(result.results[0].rateLimited, null);
    assert.ok(lines.some((l) => /attempt 1 produced nothing — retrying \(2\/3\)/.test(l)), lines.join('\n'));
    assert.ok(!lines.some((l) => /RATE-LIMITED/.test(l)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('execute: a whole-invocation failure (conformance/policy) proposes nothing and re-queues every part', () => {
  const root = twoAreaRepo();
  try {
    const good = sl('invariants', ['one.md']);
    const other = sl('gotchas', ['two.md']);
    const result = mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'), record: mod.readRunRecord(root),
      slices: [good, other], attemptsPerSlice: 1,
      // Lands both pages but leaves the bundle non-conformant (an unlisted page fails V9).
      invoke: () => {
        writingStub(root, 'invariants', ['one.md'])();
        writingStub(root, 'gotchas', ['two.md'])();
        writeFileSync(join(root, 'openwiki', 'gotchas', 'orphan.md'), '---\ntype: R\n---\nb\n');
        writeFileSync(join(root, 'openwiki', 'gotchas', 'index.md'), '# Gotchas\n- [two](two.md)\n');
        return { status: 0 };
      },
    });
    assert.equal(result.outcome, 'failed');
    assert.deepEqual(result.results[0].landedParts ?? [], [], 'nothing is proposable from a non-conformant tree');
    assert.deepEqual(mod.proposableSlices(result), []);
    assert.deepEqual(result.backlog, [good, other], 'every part is redone');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('execute: a stale page left unwritten in ONE area fails only that area, by area/page (#587)', () => {
  const root = twoAreaRepo();
  try {
    // Both pages cite a source committed AFTER their stamp, so both are stale going in. `README.md`
    // because the OKF gate resolves `resource` against the real checkout.
    const stale = (title) =>
      `---\ntype: Convention\ntitle: ${title}\ndescription: Stale.\nresource: README.md\ntimestamp: 2020-01-01T00:00:00Z\n---\nBody.\n`;
    writeFileSync(join(root, 'README.md'), 'source\n');
    writeFileSync(join(root, 'openwiki', 'invariants', 'one.md'), stale('one'));
    writeFileSync(join(root, 'openwiki', 'gotchas', 'two.md'), stale('two'));
    writeFileSync(join(root, 'openwiki', 'invariants', 'index.md'), '# Invariants\n- [Auth Chain](auth-chain.md)\n- [one](one.md)\n');
    writeFileSync(join(root, 'openwiki', 'gotchas', 'index.md'), '# Gotchas\n- [two](two.md)\n');
    spawnSync('git', ['add', '-A'], { cwd: root });
    spawnSync('git', ['commit', '-qm', 'stale pages'], { cwd: root });

    const good = sl('invariants', ['one.md']);
    const skipped = sl('gotchas', ['two.md']);
    const calls = [];
    const result = mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'), record: mod.readRunRecord(root),
      slices: [good, skipped], attemptsPerSlice: 1,
      // Rewrites one area's page and silently skips the other's: the 2026-09-26 renovate.md shape.
      invoke: (work) => { calls.push(work); writingStub(root, 'invariants', ['one.md'])(); return { status: 0 }; },
    });
    assert.equal(calls.length, 1, 'one generator run for both areas');
    assert.equal(result.outcome, 'failed');
    assert.deepEqual(result.results[0].stalePages, ['gotchas/two.md']);
    const why = result.results[0].violations.join('\n');
    assert.match(why, /gotchas\/two\.md/);
    assert.doesNotMatch(why, /invariants\/one\.md/, 'the area that was rewritten is not blamed');
    assert.deepEqual(result.backlog, [skipped], 'only the stale area is carried forward');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('execute: an unwritten page whose claims were verified after its source moved is NOT stale (#587 reads the newest stamp)', () => {
  const root = twoAreaRepo();
  try {
    writeFileSync(join(root, 'README.md'), 'source\n');
    writeFileSync(join(root, 'openwiki', 'gotchas', 'two.md'),
      '---\ntype: Convention\ntitle: two\ndescription: Verified.\nresource: README.md\ntimestamp: 2020-01-01T00:00:00Z\nverified:\n  - by: openwiki/0.6.0\n    at: 2999-01-01T00:00:00Z\n---\nBody.\n');
    writeFileSync(join(root, 'openwiki', 'gotchas', 'index.md'), '# Gotchas\n- [two](two.md)\n');
    spawnSync('git', ['add', '-A'], { cwd: root });
    spawnSync('git', ['commit', '-qm', 'verified page'], { cwd: root });

    const result = mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'), record: mod.readRunRecord(root),
      slices: [sl('invariants', ['one.md']), sl('gotchas', ['two.md'])], attemptsPerSlice: 1,
      invoke: () => { writingStub(root, 'invariants', ['one.md'])(); return { status: 0 }; },
    });
    assert.deepEqual(result.results[0].stalePages ?? [], [], 'the same rule as V12 — the two readers must not disagree');
    assert.notEqual(result.outcome, 'failed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('execute: a requested page changed ONLY in front matter is still stale — not a refresh (#616)', () => {
  // Measured on #615: the run deleted a `verified:` block from runbooks/ci-diagnostics.md, left the
  // body and `generated` stamp alone, and reported the page "written" — so #587's check, which only
  // judged UNwritten pages, never looked. Judge the requested page after the run, written or not.
  const root = twoAreaRepo();
  try {
    writeFileSync(join(root, 'README.md'), 'source\n');
    const page = (extra) => `---\ntype: Convention\ntitle: two\ndescription: Stale.\nresource: README.md\ntimestamp: 2020-01-01T00:00:00Z\n${extra}---\nBody.\n`;
    writeFileSync(join(root, 'openwiki', 'gotchas', 'two.md'), page('tags: [a]\n'));
    writeFileSync(join(root, 'openwiki', 'gotchas', 'index.md'), '# Gotchas\n- [two](two.md)\n');
    spawnSync('git', ['add', '-A'], { cwd: root });
    spawnSync('git', ['commit', '-qm', 'stale page'], { cwd: root });

    const result = mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'), record: mod.readRunRecord(root),
      slices: [sl('gotchas', ['two.md'])], attemptsPerSlice: 1,
      invoke: () => { writeFileSync(join(root, 'openwiki', 'gotchas', 'two.md'), page('')); return { status: 0 }; },
    });
    assert.equal(result.outcome, 'failed', 'a front-matter-only change must not pass as a refresh');
    assert.deepEqual(result.results[0].stalePages, ['gotchas/two.md']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('execute: a slice whose output breaks the Markdown/Claims invariant fails instead of publishing (#616)', () => {
  // The run itself produced this on #615. openwiki would refuse every later run, so the slice fails
  // here and nothing is proposed.
  const root = twoAreaRepo();
  try {
    const covered = '---\ntype: Convention\ntitle: two\ndescription: Covered.\n---\nBody.\n';
    const certified = `sha256:${createHash('sha256').update(covered).digest('hex')}`;
    writeFileSync(join(root, 'openwiki', 'gotchas', 'two.md'), covered);
    writeFileSync(join(root, 'openwiki', 'gotchas', 'index.md'), '# Gotchas\n- [two](two.md)\n');
    mkdirSync(join(root, 'openwiki', '.claims', 'gotchas'), { recursive: true });
    writeFileSync(join(root, 'openwiki', '.claims', 'gotchas', 'two.json'), JSON.stringify({ pageVersion: certified, verification: { by: 'x', at: '2026-09-29T00:00:00Z' }, claims: [] }));
    writeFileSync(join(root, 'openwiki', '.page-manifest.json'), JSON.stringify({ schemaVersion: 1, pages: { '/openwiki/gotchas/two.md': { pageVersion: certified } } }));
    spawnSync('git', ['add', '-A'], { cwd: root });
    spawnSync('git', ['commit', '-qm', 'covered page'], { cwd: root });

    const result = mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'), record: mod.readRunRecord(root),
      slices: [sl('gotchas', ['two.md'])], attemptsPerSlice: 1,
      // Rewrites the covered page without re-certifying its Claims.
      invoke: () => { writeFileSync(join(root, 'openwiki', 'gotchas', 'two.md'), covered.replace('Body.', 'New body.')); return { status: 0 }; },
    });
    assert.equal(result.outcome, 'failed');
    assert.match(result.results[0].violations.join('\n'), /V16|not durable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('normalize: a link rewrite on a Claims-verified page keeps it durable', () => {
  const root = twoAreaRepo();
  try {
    const covered = '---\ntype: Convention\ntitle: two\ndescription: Covered.\n---\nSee [auth](/openwiki/invariants/auth-chain.md).\n';
    const certified = `sha256:${createHash('sha256').update(covered).digest('hex')}`;
    writeFileSync(join(root, 'openwiki', 'gotchas', 'two.md'), covered);
    mkdirSync(join(root, 'openwiki', '.claims', 'gotchas'), { recursive: true });
    writeFileSync(join(root, 'openwiki', '.claims', 'gotchas', 'two.json'), JSON.stringify({ pageVersion: certified, verification: { by: 'x', at: '2026-09-29T00:00:00Z' }, claims: [] }));
    writeFileSync(join(root, 'openwiki', '.page-manifest.json'), JSON.stringify({ schemaVersion: 1, pages: { '/openwiki/gotchas/two.md': { pageVersion: certified } } }));
    const changed = mod.normalizeBundleLinks({ root, files: ['openwiki/gotchas/two.md'] });
    assert.equal(changed.length, 1, 'the site-root link was rewritten');
    const { claimsDurabilityFindings } = claimsMod;
    assert.deepEqual(claimsDurabilityFindings(join(root, 'openwiki')), [], 'the rewrite carried the certified hash with it');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── the job deadline (item #613) ────────────────────────────────────────────────────────────────
//
// A generator that hangs (a model request accepted and never answered) used to run until the CI job
// timeout killed everything — no run record, no digest, no cost line (runs 4290, 4385, 4386). The
// generator now runs under a deadline derived from the job's own, so a hang ends as a failed slice
// and the run still records itself.

test('deadline: the generator is wrapped in `timeout`, which signals the whole process group', () => {
  assert.deepEqual(mod.deadlineCommand(null), mod.generatorCommand(), 'no deadline, no wrapper');
  assert.deepEqual(mod.deadlineCommand(90_500), ['timeout', '--kill-after=60s', '90s', ...mod.generatorCommand()]);
});

test('deadline: `timeout` really kills a grandchild, which a plain spawnSync timeout would orphan', () => {
  // nx spawns openwiki as a GRANDCHILD; killing only the direct child would leave it running and
  // writing into the tree while the slice is verified. Measured here, not assumed.
  // A unique fractional duration marks the grandchild so pgrep can find it (dash has no `exec -a`).
  const marker = `sleep 30.${process.pid}${Date.now() % 100000}`;
  const t0 = Date.now();
  const r = spawnSync('timeout', ['--kill-after=2s', '1s', 'sh', '-c', `${marker} & wait`], { encoding: 'utf8' });
  assert.ok(Date.now() - t0 < 10_000, 'returned promptly');
  assert.equal(r.status, 124, 'timeout exit status');
  const left = spawnSync('pgrep', ['-f', `^${marker}$`], { encoding: 'utf8' });
  assert.equal(left.stdout.trim(), '', 'no orphaned grandchild survives');
});

test('deadline: each invocation is given the time left minus the reserve for verify/publish/record', () => {
  const root = twoAreaRepo();
  try {
    const seen = [];
    const t = 1_000_000;
    const result = mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'), record: mod.readRunRecord(root),
      slices: [sl('invariants', ['one.md'])], attemptsPerSlice: 1,
      clock: () => t, deadlineMs: t + 40 * 60_000,
      invoke: (work, opts) => { seen.push(opts.timeoutMs); writingStub(root, 'invariants', ['one.md'])(); return { status: 0 }; },
    });
    assert.equal(result.outcome, 'completed');
    assert.equal(seen[0], 40 * 60_000 - mod.DEADLINE_RESERVE_MS);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('deadline: a slice with too little time left is not started — carried forward as a budget stop', () => {
  const root = twoAreaRepo();
  try {
    let calls = 0;
    const t = 1_000_000;
    const slice = sl('invariants', ['one.md']);
    const result = mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'), record: mod.readRunRecord(root),
      slices: [slice], attemptsPerSlice: 1,
      clock: () => t, deadlineMs: t + mod.DEADLINE_RESERVE_MS + mod.MIN_GENERATOR_MS - 1,
      invoke: () => { calls += 1; return { status: 0 }; },
    });
    assert.equal(calls, 0, 'never started a generator that could not finish');
    assert.equal(result.stoppedAtBudget, true);
    assert.equal(result.exitCode, 3, 'a budget stop, not a failure');
    assert.deepEqual(result.backlog, [slice]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── a deadline stop must not let an UNREQUESTED page sink the requested ones ───────────────────
//
// Measured 2026-10-04, run 4606: projects/sast.md was requested; openwiki also forced three covered
// pages whose Claims evidence had moved. The job deadline stopped the generator part-way through one
// of those (projects/keycloak.md), whose half-written bytes broke V16 — a whole-invocation
// conformance failure, so nothing was proposed, although sast.md itself had landed. After a deadline
// stop, what the slice did not ask for is restored before verification.

/** A covered (Claims-verified, manifest-listed) page in the gotchas area, committed. */
function coveredPageRepo() {
  const root = twoAreaRepo();
  const body = '---\ntype: Convention\ntitle: forced\ndescription: Covered.\n---\nOriginal.\n';
  const certified = `sha256:${createHash('sha256').update(body).digest('hex')}`;
  writeFileSync(join(root, 'openwiki', 'gotchas', 'forced.md'), body);
  writeFileSync(join(root, 'openwiki', 'gotchas', 'index.md'), '# Gotchas\n- [forced](forced.md)\n');
  mkdirSync(join(root, 'openwiki', '.claims', 'gotchas'), { recursive: true });
  writeFileSync(join(root, 'openwiki', '.claims', 'gotchas', 'forced.json'), JSON.stringify({ pageVersion: certified, verification: { by: 'x', at: '2026-10-01T00:00:00Z' }, claims: [] }));
  writeFileSync(join(root, 'openwiki', '.page-manifest.json'), JSON.stringify({ schemaVersion: 1, pages: { '/openwiki/gotchas/forced.md': { pageVersion: certified } } }));
  spawnSync('git', ['add', '-A'], { cwd: root });
  spawnSync('git', ['commit', '-qm', 'covered page'], { cwd: root });
  return root;
}

test('revertUnrequested restores unrequested writes and keeps the requested page, its sidecar and its index', () => {
  const root = coveredPageRepo();
  try {
    const before = mod.snapshotTree(root);
    writingStub(root, 'invariants', ['one.md'])(); // requested page + its index
    mkdirSync(join(root, 'openwiki', '.claims', 'invariants'), { recursive: true });
    writeFileSync(join(root, 'openwiki', '.claims', 'invariants', 'one.json'), '{"pageVersion":"x"}');
    writeFileSync(join(root, 'openwiki', 'gotchas', 'forced.md'), 'half-written');            // unrequested, tracked
    writeFileSync(join(root, 'openwiki', '.page-manifest.json'), '{"changed":true}');            // shared bookkeeping
    writeFileSync(join(root, 'openwiki', 'gotchas', 'brand-new.md'), 'x');                     // unrequested, new
    const reverted = mod.revertUnrequested({ root, bundleRoot: join(root, 'openwiki'), slice: sl('invariants', ['one.md']), before });
    assert.match(readFileSync(join(root, 'openwiki', 'gotchas', 'forced.md'), 'utf8'), /Original\./, 'tracked page restored');
    assert.ok(!existsSync(join(root, 'openwiki', 'gotchas', 'brand-new.md')), 'new unrequested file removed');
    assert.doesNotMatch(readFileSync(join(root, 'openwiki', '.page-manifest.json'), 'utf8'), /changed/, 'manifest restored');
    assert.ok(existsSync(join(root, 'openwiki', 'invariants', 'one.md')), 'requested page kept');
    assert.ok(existsSync(join(root, 'openwiki', '.claims', 'invariants', 'one.json')), 'its sidecar kept');
    assert.match(readFileSync(join(root, 'openwiki', 'invariants', 'index.md'), 'utf8'), /one\.md/, 'its index kept');
    assert.ok(reverted.includes('openwiki/gotchas/forced.md') && reverted.includes('openwiki/gotchas/brand-new.md'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('execute: after a DEADLINE stop, a half-written forced page is restored and the requested page is proposable', () => {
  const root = coveredPageRepo();
  try {
    const result = mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'), record: mod.readRunRecord(root),
      slices: [sl('invariants', ['one.md'])], attemptsPerSlice: 1,
      clock: () => 1_000_000, deadlineMs: 1_000_000 + 60 * 60_000,
      invoke: () => {
        writingStub(root, 'invariants', ['one.md'])();
        writeFileSync(join(root, 'openwiki', 'gotchas', 'forced.md'), '---\ntype: Convention\ntitle: forced\ndescription: Half.\n---\nHalf-writ');
        return { status: 124 }; // `timeout` stopped it
      },
    });
    assert.equal(result.outcome, 'completed', 'the requested page landed; the unfinished forced page no longer sinks it');
    assert.equal(result.pagesWritten, 1);
    assert.deepEqual(mod.proposableSlices(result).map((s) => s.pages), [['one.md']]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('execute: on a NORMAL exit, a broken forced page still fails the slice — nothing is silently reverted', () => {
  const root = coveredPageRepo();
  try {
    const result = mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'), record: mod.readRunRecord(root),
      slices: [sl('invariants', ['one.md'])], attemptsPerSlice: 1,
      clock: () => 1_000_000, deadlineMs: 1_000_000 + 60 * 60_000,
      invoke: () => {
        writingStub(root, 'invariants', ['one.md'])();
        writeFileSync(join(root, 'openwiki', 'gotchas', 'forced.md'), 'broken but finished');
        return { status: 0 };
      },
    });
    assert.equal(result.outcome, 'failed');
    assert.match(result.results[0].violations.join('\n'), /V16/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 078 US4 / FR-010: every run records what it cost ────────────────────────────

const PRICES_FIXTURE = { asOf: '2026-09-27', providers: { fireworks: { standard: { uncached: 0.22, cached: 0.007, cacheWrite: 0, output: 0.66 } } } };
const USAGE_CTX = { provider: 'fireworks', model: 'm', tier: null, prices: PRICES_FIXTURE };

test('usage: each invocation gets its own log, and the run record carries the priced total', () => {
  const root = twoAreaRepo();
  try {
    const logs = [];
    const result = mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'), record: mod.readRunRecord(root), usage: USAGE_CTX,
      slices: [sl('invariants', ['one.md']), sl('gotchas', ['two.md'])],
      invoke: (work, ctx) => {
        logs.push(ctx.usageLog);
        writeFileSync(ctx.usageLog, `${JSON.stringify({ kind: 'page', status: 200, ms: 10, uncached: 1_000_000, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 })}\n`, { flag: 'a' });
        writingStub(root, 'invariants', ['one.md'])();
        writingStub(root, 'gotchas', ['two.md'])();
        return { status: 0 };
      },
    });
    assert.equal(logs.length, 1);
    assert.ok(logs[0], 'the invocation was handed a usage log path');
    assert.equal(result.results[0].usage.calls, 1);
    assert.equal(result.usage.estCostUsd, 0.22);
    const rec = mod.readRunRecord(root);
    assert.equal(rec.lastRunUsage.estCostUsd, 0.22);
    assert.equal(rec.lastRunUsage.priceTable, '2026-09-27');
    assert.ok(!existsSync(logs[0]), 'the per-invocation log is temporary');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('usage: a generator that reported nothing is recorded as NOT CAPTURED, never as $0', () => {
  const root = twoAreaRepo();
  try {
    const result = mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'), record: mod.readRunRecord(root), usage: USAGE_CTX,
      slices: [sl('invariants', ['one.md'])],
      invoke: () => { writingStub(root, 'invariants', ['one.md'])(); return { status: 0 }; },
    });
    assert.equal(result.results[0].usage, 'not captured');
    assert.equal(mod.readRunRecord(root).lastRunUsage, 'not captured');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('usage: the real invocation carries the log path to the generator', () => {
  const env = mod.generatorEnv('a message', { PATH: '/bin' }, { usageLog: '/tmp/x.jsonl' });
  assert.equal(env.WIKI_USAGE_LOG, '/tmp/x.jsonl');
  assert.equal(env.WIKI_RUN_MESSAGE, 'a message');
  assert.equal(mod.generatorEnv('a message', { PATH: '/bin' }).WIKI_USAGE_LOG, undefined);
});

// ── 078 FR-005: the model is proven callable before any paid work ────────────────

test('preflight: runs once, before the first slice, when there is work', () => {
  const { root } = repoAtHead();
  try {
    commitCoveredChange(root);
    const order = [];
    mod.runMaintenance({
      root, bundleRoot: join(root, 'openwiki'), policy: realPolicy(), credential: 'present',
      preflight: () => { order.push('preflight'); return { ok: true, detail: 'stub' }; },
      invoke: () => { order.push('invoke'); return { status: 0 }; },
      maxSlices: 1,
    });
    assert.equal(order[0], 'preflight', 'the check comes before any paid slice');
    assert.equal(order.filter((x) => x === 'preflight').length, 1, 'once per run, not per slice');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('preflight: a failure stops the run with exit 2, starts no slice, and leaves the record alone', () => {
  const { root, head } = repoAtHead();
  try {
    commitCoveredChange(root);
    let invoked = 0;
    const result = mod.runMaintenance({
      root, bundleRoot: join(root, 'openwiki'), policy: realPolicy(), credential: 'present',
      preflight: () => ({ ok: false, detail: 'fireworks accounts/fireworks/models/x: HTTP 404 (not_found)' }),
      invoke: () => { invoked++; return { status: 0 }; },
    });
    assert.equal(invoked, 0, 'no paid work after a failed preflight');
    assert.equal(result.exitCode, 2);
    assert.equal(result.reason, 'preflight-failed');
    assert.notEqual(result.outcome, 'nothing-to-do');
    assert.match(result.detail, /HTTP 404/);
    assert.equal(result.persisted, false);
    assert.equal(mod.readRunRecord(root).coveredCommit, head, 'the marker must not move');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('preflight: the free path never calls it', () => {
  const { root } = repoAtHead();
  try {
    let called = 0;
    const result = mod.runMaintenance({
      root, bundleRoot: join(root, 'openwiki'), policy: realPolicy(), credential: null,
      preflight: () => { called++; return { ok: true }; },
      invoke: () => ({ status: 0 }),
    });
    assert.equal(result.outcome, 'nothing-to-do');
    assert.equal(called, 0, 'finding nothing to document needs no model');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('preflight: the CLI --execute path runs the SAME gate, before the proposal branch and any slice', () => {
  // main() drives executeSlices itself rather than through runMaintenance, so a gate added only to
  // runMaintenance would never run in CI. Found while implementing 078 T014 — this pins it.
  // Since #619 the CLI path delegates to executeRun (so a test can drive the whole sequence), so the
  // premise is now: main's execute branch calls executeRun, and executeRun gates before anything else.
  const source = readFileSync(SCRIPT, 'utf8');
  const cli = source.slice(source.indexOf("if (opts.mode === 'execute')"));
  assert.ok(cli.indexOf('executeRun(') > 0, 'the CLI execute path must delegate to executeRun');
  assert.equal(cli.indexOf('executeSlices('), -1, 'and must not drive executeSlices around it');
  const start = source.indexOf('export async function executeRun(');
  const exec = source.slice(start, source.indexOf('\n}\n', start));
  const gate = exec.indexOf('preflightGate(');
  assert.ok(gate > 0, 'the CLI execute path must call preflightGate');
  assert.ok(gate < exec.indexOf('prepareProposalBranch('), 'before the proposal branch is touched');
  assert.ok(gate < exec.indexOf('executeSlices('), 'and before any slice');
});

test('preflight: executeRun stops at a failed preflight — exit 2, no generator, no proposal branch, no outcome', async () => {
  const { root } = repoAtHead();
  try {
    const g = gitIn(root);
    g('branch', '-M', 'main');
    mod.writeRunRecord(root, { ...mod.readRunRecord(root), backlog: [{ area: 'invariants', pages: ['first.md'], areaExists: true, reason: 'source changed' }] });
    const recordBefore = mod.readRunRecord(root);
    let invoked = 0;
    const exit = await mod.executeRun({
      root, opts: EXECUTE_OPTS, policy: realPolicy(), forge: stubForge(),
      invoke: () => { invoked++; return { status: 0 }; },
      preflight: () => ({ ok: false, detail: 'HTTP 401 (authentication_error)' }),
    });
    assert.equal(exit, 2);
    assert.equal(invoked, 0, 'no paid slice');
    assert.notEqual(g('rev-parse', '--verify', '--quiet', mod.PROPOSAL_BRANCH).status, 0, 'the proposal branch was not touched');
    assert.deepEqual(mod.readRunRecord(root), recordBefore, 'no outcome recorded');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('preflight: the gate skips dry runs and reports a failure without throwing', () => {
  assert.equal(mod.preflightGate({ dryRun: true, preflight: () => { throw new Error('must not run'); } }).ok, true);
  const bad = mod.preflightGate({ dryRun: false, preflight: () => ({ ok: false, detail: 'HTTP 401 (authentication_error)' }) });
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /401/);
  assert.equal(mod.preflightGate({ dryRun: false, preflight: null }).ok, true, 'no preflight configured is not a failure');
});

test('credentials: the scrub list covers every provider, Anthropic names first and unchanged (#209)', () => {
  assert.deepEqual(mod.CREDENTIAL_ENV_NAMES.slice(0, 2), ['ANTHROPIC_API_KEY', 'MCM_ANTHROPIC_API_KEY']);
  assert.ok(mod.CREDENTIAL_ENV_NAMES.includes('FIREWORKS_API_KEY'));
  assert.ok(mod.CREDENTIAL_ENV_NAMES.includes('MCM_FIREWORKS_API_KEY'));
});

test('credentials: the credential looked for is the RESOLVED provider\'s', () => {
  assert.equal(mod.credentialFromEnv({ MCM_WIKI_PROVIDER: 'fireworks', MCM_ANTHROPIC_API_KEY: 'a' }), null,
    'an Anthropic key does not satisfy a Fireworks run');
  assert.equal(mod.credentialFromEnv({ MCM_WIKI_PROVIDER: 'fireworks', MCM_FIREWORKS_API_KEY: 'f' }), 'f');
  assert.equal(mod.credentialFromEnv({ MCM_ANTHROPIC_API_KEY: 'a' }), 'a', 'the default is unchanged');
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
    listPulls({ state: want = 'open' } = {}) {
      calls.push({ op: 'listPulls' });
      return state.pulls.filter((p) => p.state === want);
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

// ── #619: the whole --execute sequence, closed-unmerged proposal included ─────────────────────────

const EXECUTE_OPTS = { mode: 'execute', since: null, json: false, dryRun: false, maxSlices: null, pageBudget: mod.PAGE_BUDGET, timeBudgetSeconds: 3600, propose: true, dispatched: false };

/** A non-documentation commit, so a run's baseCommit differs from the marker it found. */
function commitNonDoc(g, root, name) {
  writeFileSync(join(root, name), `${name}\n`);
  g('add', name);
  g('commit', '-qm', `touch ${name}`);
  return g('rev-parse', 'HEAD').stdout.trim();
}

/** A generator stub that writes whatever invariants pages it is asked for, and records the ask. */
function recordingWriter(root, asked) {
  return (slice) => {
    for (const part of slice.parts ?? [slice]) asked.push(...part.pages);
    return writingStub(root, 'invariants', (slice.parts ?? [slice]).flatMap((p) => p.pages))();
  };
}

test('execute (#619): a proposal closed unmerged is reconciled BEFORE planning, so its work is re-planned from the pre-run marker', async () => {
  const { root, head: m0 } = repoAtHead();
  try {
    const g = gitIn(root);
    g('branch', '-M', 'main');
    const forge = stubForge();
    const slice = { area: 'invariants', pages: ['first.md'], areaExists: true, reason: 'source changed' };
    mod.writeRunRecord(root, { ...mod.readRunRecord(root), backlog: [slice] });
    const m1 = commitNonDoc(g, root, 'one.txt');

    // Run 1 proposes first.md. Its proposal must remember the marker the run FOUND (m0), not the one
    // the run advanced to (m1) — otherwise "roll back" on a later close is a no-op.
    const asked1 = [];
    const exit1 = await mod.executeRun({ root, opts: EXECUTE_OPTS, policy: realPolicy(), forge, invoke: recordingWriter(root, asked1), preflight: null });
    assert.equal(exit1, 0);
    assert.deepEqual(asked1, ['first.md']);
    const after1 = mod.readRunRecord(root);
    assert.equal(after1.coveredCommit, m1, 'run 1 advanced its marker');
    assert.equal(after1.proposal.markerBefore, m0, 'markerBefore is the marker BEFORE the run that opened the proposal');

    // A reviewer closes it unmerged. A CI runner is a fresh checkout, so no local proposal branch.
    forge.state.pulls[0].state = 'closed';
    g('branch', '-D', mod.PROPOSAL_BRANCH);
    commitNonDoc(g, root, 'two.txt');

    // Run 2 must plan the returned slice. Its generator fails, so the slice stays in the backlog and
    // the marker stays rolled back — neither may be overwritten by a plan made before reconciling.
    const asked2 = [];
    const exit2 = await mod.executeRun({ root, opts: EXECUTE_OPTS, policy: realPolicy(), forge, invoke: (s) => { asked2.push(...(s.parts ?? [s]).flatMap((p) => p.pages)); return { status: 0 }; }, preflight: null });
    assert.equal(exit2, 1, 'the slice failed');
    assert.deepEqual(asked2, ['first.md', 'first.md', 'first.md'], 'the closed proposal\'s slice was planned (and retried)');
    const after2 = mod.readRunRecord(root);
    assert.deepEqual(after2.backlog.map((s) => s.pages), [['first.md']], 'its work is back in the backlog, not lost');
    assert.equal(after2.coveredCommit, m0, 'and the marker is not past markerBefore');
    assert.equal(after2.proposal, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('execute (#619): a re-proposal after a close carries the rolled-back marker as its markerBefore', async () => {
  const { root, head: m0 } = repoAtHead();
  try {
    const g = gitIn(root);
    g('branch', '-M', 'main');
    const forge = stubForge();
    mod.writeRunRecord(root, { ...mod.readRunRecord(root), backlog: [{ area: 'invariants', pages: ['first.md'], areaExists: true, reason: 'source changed' }] });
    commitNonDoc(g, root, 'one.txt');
    await mod.executeRun({ root, opts: EXECUTE_OPTS, policy: realPolicy(), forge, invoke: recordingWriter(root, []), preflight: null });
    forge.state.pulls[0].state = 'closed';
    g('branch', '-D', mod.PROPOSAL_BRANCH);
    g('checkout', '-q', '--', 'openwiki');
    const m2 = commitNonDoc(g, root, 'two.txt');

    const asked = [];
    const exit = await mod.executeRun({ root, opts: EXECUTE_OPTS, policy: realPolicy(), forge, invoke: recordingWriter(root, asked), preflight: null });
    assert.equal(exit, 0);
    assert.deepEqual(asked, ['first.md'], 'the returned slice was re-done');
    const rec = mod.readRunRecord(root);
    assert.equal(rec.coveredCommit, m2);
    assert.equal(rec.proposal.number, 2, 'a fresh proposal, not the closed one');
    assert.equal(rec.proposal.markerBefore, m0, 'it covers the whole range from the rolled-back marker');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('execute: slices the PLAN deferred beyond the page budget are carried in the backlog, not lost', async () => {
  const { root } = repoAtHead();
  const many = Array.from({ length: 20 }, (_, i) => `p${i + 1}.md`);
  try {
    const g = gitIn(root);
    g('branch', '-M', 'main');
    mod.writeRunRecord(root, { ...mod.readRunRecord(root), backlog: [{ area: 'invariants', pages: many, areaExists: true, reason: 'many pages' }] });
    // Twenty pages exceed one run's page budget, so computePlan defers some AT PLAN TIME — before
    // executeSlices ever sees them. Expectations come from the plan, not from remembered constants.
    const plan = mod.computePlan({ root, policy: realPolicy() });
    assert.ok(plan.deferred.length > 0, 'premise: the plan defers work');
    const deferredPages = plan.deferred.flatMap((s) => s.pages);

    const asked = [];
    const exit = await mod.executeRun({ root, opts: { ...EXECUTE_OPTS, propose: false }, policy: realPolicy(), invoke: recordingWriter(root, asked), preflight: null });
    assert.deepEqual(asked, plan.slices.flatMap((s) => s.pages), 'only the planned slices are invoked');
    assert.equal(exit, 3, 'outstanding work is exit 3, not a clean 0');
    assert.deepEqual(mod.readRunRecord(root).backlog.flatMap((s) => s.pages), deferredPages, 'the deferred slices survive the marker advancing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A committed, stale page in gotchas/ with a committed sidecar — for the #685 manifest edge cases. */
function certifiedStalePage(root, { withManifest }) {
  writeFileSync(join(root, 'README.md'), 'source\n');
  const text = '---\ntype: Convention\ntitle: two\ndescription: Stale.\nresource: README.md\ntimestamp: 2020-01-01T00:00:00Z\n---\nBody.\n';
  const hash = `sha256:${createHash('sha256').update(text).digest('hex')}`;
  writeFileSync(join(root, 'openwiki', 'gotchas', 'two.md'), text);
  writeFileSync(join(root, 'openwiki', 'gotchas', 'index.md'), '# Gotchas\n- [two](two.md)\n');
  if (withManifest) {
    mkdirSync(join(root, 'openwiki', '.claims', 'gotchas'), { recursive: true });
    writeFileSync(join(root, 'openwiki', '.claims', 'gotchas', 'two.json'), JSON.stringify({ pageVersion: hash, verification: { by: 'x', at: '2020-01-02T00:00:00Z' }, claims: [] }));
    writeFileSync(join(root, 'openwiki', '.page-manifest.json'), JSON.stringify({ schemaVersion: 1, pages: { '/openwiki/gotchas/two.md': { pageVersion: hash } } }));
  }
  spawnSync('git', ['add', '-A'], { cwd: root });
  spawnSync('git', ['commit', '-qm', 'stale page'], { cwd: root });
  return text;
}

test('execute (#685): with NO manifest before the invocation, an entry the generator created for a failed page is removed with its sidecar', () => {
  const root = twoAreaRepo();
  try {
    const text = certifiedStalePage(root, { withManifest: false });
    const result = mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'), record: mod.readRunRecord(root),
      slices: [sl('invariants', ['one.md']), sl('gotchas', ['two.md'])], attemptsPerSlice: 1,
      invoke: () => {
        writingStub(root, 'invariants', ['one.md'])();
        const hash = `sha256:${createHash('sha256').update(text).digest('hex')}`;
        mkdirSync(join(root, 'openwiki', '.claims', 'gotchas'), { recursive: true });
        writeFileSync(join(root, 'openwiki', '.claims', 'gotchas', 'two.json'), JSON.stringify({ pageVersion: hash, verification: { by: 'x', at: '2020-01-02T00:00:00Z' }, claims: [] }));
        writeFileSync(join(root, 'openwiki', '.page-manifest.json'), JSON.stringify({ schemaVersion: 1, pages: { '/openwiki/gotchas/two.md': { pageVersion: hash } } }));
        return { status: 0 };
      },
    });
    assert.equal(result.outcome, 'failed');
    assert.ok(!existsSync(join(root, 'openwiki', '.claims', 'gotchas', 'two.json')), 'the new sidecar is gone');
    const manifest = JSON.parse(readFileSync(join(root, 'openwiki', '.page-manifest.json'), 'utf8'));
    assert.equal(manifest.pages['/openwiki/gotchas/two.md'], undefined, 'and so is its entry — never one pointing at a sidecar that does not exist');
    const okf = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'check-openwiki-okf.mjs'), '--bundle', join(root, 'openwiki')], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.doesNotMatch(`${okf.stdout}${okf.stderr}`, /V16/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('execute (#685): an UNPARSABLE manifest after a failure does not crash the run — V16 reports it and the record is still written', () => {
  const root = twoAreaRepo();
  try {
    certifiedStalePage(root, { withManifest: true });
    const result = mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'), record: mod.readRunRecord(root),
      slices: [sl('gotchas', ['two.md'])], attemptsPerSlice: 1,
      invoke: () => { writeFileSync(join(root, 'openwiki', '.page-manifest.json'), '{"schemaVersion": 1, "pa'); return { status: 0 }; },
    });
    assert.equal(result.outcome, 'failed');
    assert.equal(mod.readRunRecord(root).lastOutcome, 'failed', 'the run record was persisted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('execute (#683): a stray 429 the SDK absorbed inside a working attempt is NOT a rate limit', () => {
  const root = tmpGitRepo('conformant-bundle');
  try {
    let t = 0;
    const slept = [];
    let call = 0;
    const { value: result, lines } = capturingErrors(() => mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'), record: mod.readRunRecord(root),
      slices: [sl('invariants', ['one.md'])],
      clock: () => t,
      sleep: (ms) => { slept.push(ms); t += ms; },
      invoke: (slice, ctx) => {
        call++;
        t += 10_000;
        if (call === 1) return rateLimitedStub(1, { ok: 9 })(slice, ctx);
        return writingStub(root, 'invariants', ['one.md'])();
      },
    }));
    assert.equal(call, 2);
    assert.deepEqual(slept, [], 'no wait');
    assert.equal(result.results[0].rateLimited, null);
    assert.ok(!lines.some((l) => /RATE-LIMITED/.test(l)), lines.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('execute (#619): a DRY run reconciles in memory only — the record is not written', async () => {
  const { root } = repoAtHead();
  try {
    const g = gitIn(root);
    g('branch', '-M', 'main');
    const forge = stubForge({ existing: { number: 7, head: mod.PROPOSAL_BRANCH, state: 'closed', merged: false } });
    mod.writeRunRecord(root, { ...mod.readRunRecord(root), coveredCommit: 'advanced', proposal: { number: 7, markerBefore: 'before', slices: [{ area: 'invariants', pages: ['first.md'], areaExists: true, reason: 'r' }] } });
    const recordBefore = mod.readRunRecord(root);
    const exit = await mod.executeRun({ root, opts: { ...EXECUTE_OPTS, dryRun: true }, policy: realPolicy(), forge, invoke: () => { throw new Error('a dry run invokes nothing'); }, preflight: null });
    assert.equal(exit, 0);
    assert.deepEqual(mod.readRunRecord(root), recordBefore, 'a dry run persists nothing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('execute (#619): a forge that cannot be reached for the reconcile stops the run (exit 2) rather than planning without it', async () => {
  const { root } = repoAtHead();
  try {
    mod.writeRunRecord(root, { ...mod.readRunRecord(root), proposal: { number: 7, markerBefore: 'before', slices: [] } });
    const recordBefore = mod.readRunRecord(root);
    let invoked = 0;
    const forge = { getPull: () => { throw new Error('forge GET /pulls/7 → 503'); }, listPulls: () => [] };
    const exit = await mod.executeRun({ root, opts: EXECUTE_OPTS, policy: realPolicy(), forge, invoke: () => { invoked++; return { status: 0 }; }, preflight: null });
    assert.equal(exit, 2);
    assert.equal(invoked, 0);
    assert.deepEqual(mod.readRunRecord(root), recordBefore);
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

// ── The proposal branch across EPHEMERAL runners ──────────────────────────────────────
//
// Every test above runs each "run" in ONE repository, where the local proposal branch survives from
// one run to the next. CI never does: each run is a fresh checkout, so the branch exists only on the
// remote. Measured 2026-09-27/28 on proposal #594: prepareProposalBranch looked only at refs/heads/,
// found nothing, started a new branch from main, and --force-with-lease (whose lease is the
// remote-tracking ref the checkout had just fetched) overwrote the open proposal — twice, discarding
// a 4-page and an 8-page paid slice while the run record went on listing both as proposed.

/** A bare "forge" remote holding `main`, seeded from the conformant fixture. */
function bareRemote() {
  const { root } = repoAtHead();
  const g = gitIn(root);
  g('branch', '-M', 'main');
  g('add', '-A');
  g('commit', '-qm', 'run record');
  const bare = mkdtempSync(join(tmpdir(), 'wm-bare-'));
  spawnSync('git', ['clone', '-q', '--bare', root, bare]);
  rmSync(root, { recursive: true, force: true });
  return bare;
}

/**
 * A fresh runner checkout, as CI starts every run: `main` checked out, every other branch present ONLY
 * as a remote-tracking ref (actions/checkout with fetch-depth 0). That tracking ref is what made the
 * overwrite succeed — it is the lease --force-with-lease compares against.
 */
function freshCheckout(bare) {
  const dir = mkdtempSync(join(tmpdir(), 'wm-ci-'));
  spawnSync('git', ['clone', '-q', '--branch', 'main', bare, dir]);
  return dir;
}

/** One CI-shaped run: fresh checkout, prepare (adopting an open proposal), generate, publish, push. */
function ciRun(bare, forge, page, { adoptRemote = true } = {}) {
  const dir = freshCheckout(bare);
  try {
    const g = gitIn(dir);
    mod.prepareProposalBranch({ root: dir, baseBranch: 'main', git: g, remote: 'origin', adoptRemote });
    dirtyBundle(dir, page);
    return mod.publishProposal({
      root: dir, record: mod.readRunRecord(dir), forge, baseBranch: 'main', body: page, git: g,
      remote: 'origin', returnTo: 'main',
      slices: [{ area: 'invariants', pages: [page], areaExists: true, reason: 'source changed' }],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const remoteFiles = (bare) => spawnSync('git', ['ls-tree', '-r', '--name-only', mod.PROPOSAL_BRANCH], { cwd: bare, encoding: 'utf8' }).stdout;

test('proposal (fresh runner): a second run APPENDS to the open proposal on the remote, never replaces it', () => {
  const bare = bareRemote();
  try {
    const forge = stubForge();
    ciRun(bare, forge, 'first.md');
    ciRun(bare, forge, 'second.md');
    assert.equal(forge.state.pulls.length, 1, 'still exactly one proposal');
    const files = remoteFiles(bare);
    assert.match(files, /invariants\/second\.md/);
    assert.match(files, /invariants\/first\.md/, 'the first run\'s paid work must still be on the proposal branch');
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

test('proposal (fresh runner): a reviewer commit pushed to the remote branch survives the next run', () => {
  const bare = bareRemote();
  try {
    const forge = stubForge();
    ciRun(bare, forge, 'first.md');

    const human = mkdtempSync(join(tmpdir(), 'wm-human-'));
    spawnSync('git', ['clone', '-q', '--branch', mod.PROPOSAL_BRANCH, bare, human]);
    const h = gitIn(human);
    writeFileSync(join(human, 'openwiki', 'invariants', 'first.md'),
      '---\ntype: Convention\ntitle: first.md\ndescription: Corrected by a human reviewer.\n---\nHuman correction.\n');
    h('commit', '-qam', 'HUMAN: fix the wording in first.md');
    h('push', '-q', 'origin', mod.PROPOSAL_BRANCH);
    rmSync(human, { recursive: true, force: true });

    ciRun(bare, forge, 'second.md');
    const log = spawnSync('git', ['log', mod.PROPOSAL_BRANCH, '--format=%s'], { cwd: bare, encoding: 'utf8' }).stdout;
    assert.match(log, /HUMAN: fix the wording/);
    const content = spawnSync('git', ['show', `${mod.PROPOSAL_BRANCH}:openwiki/invariants/first.md`], { cwd: bare, encoding: 'utf8' }).stdout;
    assert.match(content, /Human correction/);
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

test('proposal (fresh runner): a CLOSED-unmerged proposal is not revived — its work went back to the backlog', () => {
  const bare = bareRemote();
  try {
    const forge = stubForge();
    ciRun(bare, forge, 'first.md');
    forge.state.pulls[0].state = 'closed';
    // The caller adopts the remote branch only for a proposal that is still open.
    ciRun(bare, forge, 'second.md', { adoptRemote: false });
    const files = remoteFiles(bare);
    assert.match(files, /invariants\/second\.md/);
    assert.doesNotMatch(files, /invariants\/first\.md/, 'the rejected content must not reappear in the new proposal');
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

test('proposal (fresh runner): publishing REFUSES to push over an open proposal it would truncate', () => {
  // Defence in depth: whatever prepared the branch, the push is the irreversible step. If the open
  // proposal on the remote holds a commit the local branch does not, stop before --force-with-lease.
  const bare = bareRemote();
  try {
    const forge = stubForge();
    ciRun(bare, forge, 'first.md');
    assert.throws(() => ciRun(bare, forge, 'second.md', { adoptRemote: false }),
      /would discard 1 commit/, 'a replace-by-accident must fail loudly, not overwrite paid work');
    assert.match(remoteFiles(bare), /invariants\/first\.md/, 'and the remote is untouched');
  } finally {
    rmSync(bare, { recursive: true, force: true });
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

test('an index file is writable but is NOT a subject the bundle summarizes', () => {
  // Found on the first live run: it proposed writing `invariants/claude.md` and
  // `invariants/agents.md` — concepts summarizing the index that points AT them. `regenerate` answers
  // "may this be written?"; it does not answer "should the bundle summarize it?".
  const policy = realPolicy();
  assert.equal(mod.isCoverageTarget(policy, 'CLAUDE.md'), false, 'the index must not become a concept');
  assert.equal(mod.isCoverageTarget(policy, 'AGENTS.md'), false);
  assert.equal(mod.mayWrite(policy, 'CLAUDE.md', 'agent').allowed, true, 'but an agent still maintains it');

  // A genuine document is still covered.
  assert.equal(mod.isCoverageTarget(policy, 'docs/runbooks/wiki-maintenance.md'), true);

  const slices = mod.planSlices({
    bundleRoot: join(REPO_ROOT, 'openwiki'),
    changedPaths: ['CLAUDE.md', 'AGENTS.md'],
    policy,
  });
  assert.deepEqual(slices.flatMap((s) => s.pages), [], 'a change to the index alone plans no work');
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
  //
  // Feature 078 moved the generator call out of the target's shell string into wiki-generate.mjs, which
  // passes the message as ONE argv element with no shell at all (pinned in wiki-generate.test.mjs). The
  // premise is unchanged — the message travels in WIKI_RUN_MESSAGE, never through nx --args — so that
  // is what is asserted here.
  const updateCmd = project.targets['wiki-update'].options.command;
  assert.equal(updateCmd, 'node scripts/wiki-generate.mjs', 'the target runs the launcher, which owns the generator call');
  assert.doesNotMatch(updateCmd, /--args/, 'the message must not travel through nx --args');
  const launcher = readFileSync(join(REPO_ROOT, 'scripts', 'wiki-generate.mjs'), 'utf8');
  assert.match(launcher, /WIKI_RUN_MESSAGE/, 'the launcher reads the message from the environment variable');
  assert.doesNotMatch(launcher, /shell:\s*true|execSync|\bexec\(/, 'and never hands it to a shell');
  assert.equal(project.targets['wiki-plan'].options.command, 'node scripts/wiki-maintain.mjs --plan');
  assert.equal(project.targets['wiki-maintain'].options.command, 'node scripts/wiki-maintain.mjs --execute');
  for (const t of ['wiki-plan', 'wiki-maintain']) {
    assert.ok(project.targets[t].metadata?.description?.length > 80,
      `${t} needs a description saying why the target must be used rather than a bare call`);
  }
});

// ── one bad slice must not starve the work behind it ────────────────────────────

test('a failed slice does not block the next one, but consecutive failures stop the run', () => {
  // Measured on `main`: an unsatisfiable slice sat at the head of the backlog and starved the
  // legitimate work behind it, run after run, because execution stopped at the first failure.
  const root = tmpGitRepo('conformant-bundle');
  try {
    const attempted = [];
    const result = mod.executeSlices({
      root,
      bundleRoot: join(root, 'openwiki'),
      slices: [
        { area: 'invariants', pages: ['impossible.md'], areaExists: true, reason: 'cannot be written' },
        { area: 'invariants', pages: ['good.md'], areaExists: true, reason: 'perfectly fine' },
      ],
      record: mod.readRunRecord(root),
      attemptsPerSlice: 2, // keep the arithmetic legible; the property is about SLICES, not attempts
      invoke: (slice) => {
        attempted.push(slice.pages[0]);
        if (slice.pages[0] === 'impossible.md') return { status: 0 }; // writes nothing, every time
        return writingStub(root, 'invariants', slice.pages)();
      },
    });

    assert.deepEqual([...new Set(attempted)], ['impossible.md', 'good.md'], 'the second slice must still be attempted');
    assert.equal(attempted.filter((p) => p === 'impossible.md').length, 2, 'and the bad one retried before being given up on');
    assert.equal(result.pagesWritten, 1, 'and its page written');
    assert.equal(result.outcome, 'failed', 'while the run still reports the failure');
    assert.deepEqual(result.backlog.map((s) => s.pages[0]), ['impossible.md'], 'only the bad slice carries forward');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('two consecutive failures stop the run — that is a broken run, not a bad slice', () => {
  const root = tmpGitRepo('conformant-bundle');
  try {
    const attempted = [];
    const result = mod.executeSlices({
      root,
      bundleRoot: join(root, 'openwiki'),
      slices: ['a.md', 'b.md', 'c.md'].map((p) => ({ area: 'invariants', pages: [p], areaExists: true, reason: 'r' })),
      record: mod.readRunRecord(root),
      attemptsPerSlice: 1, // isolate the consecutive-failure rule from the retry rule
      invoke: (slice) => { attempted.push(slice.pages[0]); return { status: 0 }; }, // everything fails
    });
    assert.deepEqual(attempted, ['a.md', 'b.md'], 'the third slice is not attempted — paid capacity is not spent on the same fault');
    assert.equal(result.stoppedAtFailureLimit, true);
    assert.equal(result.exitCode, 1);
    assert.equal(result.backlog.length, 3, 'and nothing is lost');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('carried-forward work is re-validated against the CURRENT policy', () => {
  // A committed backlog outlives the policy that produced it. Without this, declaring a source
  // `coverage: false` leaves a slice for a page nothing will ever legitimately write, retried forever.
  const slices = mod.planSlices({
    bundleRoot: join(REPO_ROOT, 'openwiki'),
    changedPaths: [],
    backlog: [{ area: 'invariants', pages: ['claude.md', 'agents.md'], reason: 'planned under an older policy' }],
    policy: realPolicy(),
    allDocPaths: ['CLAUDE.md', 'AGENTS.md', 'docs/runbooks/wiki-maintenance.md'],
  });
  assert.deepEqual(slices.flatMap((s) => s.pages), [], 'the stale pages are dropped');
  assert.deepEqual(slices.dropped.sort(), ['invariants/agents.md', 'invariants/claude.md'],
    'and reported — work vanishing silently is indistinguishable from work forgotten');

  // A page whose source IS covered survives, even when an uncovered source maps to the same name.
  const kept = mod.planSlices({
    bundleRoot: join(REPO_ROOT, 'openwiki'),
    changedPaths: [],
    backlog: [{ area: 'runbooks', pages: ['wiki-maintenance.md'], reason: 'legitimate' }],
    policy: realPolicy(),
    allDocPaths: ['CLAUDE.md', 'docs/runbooks/wiki-maintenance.md'],
  });
  assert.deepEqual(kept.flatMap((s) => s.pages), ['wiki-maintenance.md']);
});

test('a retry cannot launder a policy violation from an earlier attempt', () => {
  // Found by the existing policy-guard tests the moment retries were added: re-snapshotting the tree
  // per attempt made attempt 1's forbidden write "pre-existing" by attempt 2, and the slice passed.
  // The snapshot is taken once, before the first attempt.
  const root = repoWithPolicy('conformant-bundle');
  try {
    let attempt = 0;
    const result = mod.executeSlices({
      root,
      bundleRoot: join(root, 'openwiki'),
      slices: [{ area: 'invariants', pages: ['ok-page.md'], areaExists: true, reason: 'r' }],
      record: mod.readRunRecord(root),
      policy: realPolicy(),
      attemptsPerSlice: 2,
      invoke: () => {
        attempt++;
        writeFileSync(join(root, 'openwiki', 'invariants', 'ok-page.md'),
          '---\ntype: Convention\ntitle: Ok\ndescription: The requested page.\n---\nBody.\n');
        writeFileSync(join(root, 'openwiki', 'invariants', 'index.md'),
          '# Invariants\n- [Auth Chain](auth-chain.md)\n- [Ok](ok-page.md)\n');
        // Only the FIRST attempt strays outside the permitted scope.
        if (attempt === 1) writeFileSync(join(root, 'openwiki', 'INSTRUCTIONS.md'), '# rewritten by the run\n');
        return { status: 0 };
      },
    });
    assert.equal(result.outcome, 'failed', 'the forbidden write must not be forgiven by a later attempt');
    assert.match(result.results[0].violations.join('\n'), /INSTRUCTIONS\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a slice that fails once and succeeds on retry is a success, and says how many attempts it took', () => {
  const root = tmpGitRepo('conformant-bundle');
  try {
    let attempt = 0;
    const result = mod.executeSlices({
      root,
      bundleRoot: join(root, 'openwiki'),
      slices: [{ area: 'invariants', pages: ['flaky.md'], areaExists: true, reason: 'r' }],
      record: mod.readRunRecord(root),
      invoke: (slice) => (++attempt === 1 ? { status: 0 } : writingStub(root, 'invariants', slice.pages)()),
    });
    assert.equal(result.outcome, 'completed');
    assert.equal(result.results[0].attempts, 2, 'the retry is reported, not hidden');
    assert.equal(result.pagesWritten, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('retries do not run past the wall-clock budget', () => {
  const root = tmpGitRepo('conformant-bundle');
  try {
    let invocations = 0;
    let t = 0;
    mod.executeSlices({
      root,
      bundleRoot: join(root, 'openwiki'),
      slices: [{ area: 'invariants', pages: ['never.md'], areaExists: true, reason: 'r' }],
      record: mod.readRunRecord(root),
      attemptsPerSlice: 5,
      timeBudgetSeconds: 60,
      clock: () => (t += 45 * 1000), // each read advances 45s
      invoke: () => { invocations++; return { status: 0 }; },
    });
    assert.ok(invocations < 5, `retrying must stop at the budget, got ${invocations} invocations`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── FR-016 must hold even when the run record is LOST ───────────────────────────

test('proposal: an open proposal is adopted when the run record has lost its pointer', () => {
  // This happened on `main`: a run created the proposal, its marker commit failed to push
  // (non-fast-forward against a branch that moved during the debounce sleep), and the pointer never
  // landed. The next run therefore tried to open a SECOND proposal for the same branch and died on
  // `forge POST /pulls → 409`. The invariant survived only because the forge refused.
  //
  // The record is a CACHE of what the forge knows. The forge is the source of truth.
  const { root } = repoAtHead();
  try {
    const g = gitIn(root);
    g('branch', '-M', 'main');
    const forge = stubForge();

    const first = runOnce(root, g, forge, 'first.md', 'run one');
    assert.equal(forge.state.pulls.length, 1);

    // Simulate the lost record: the proposal exists on the forge, the record does not know it.
    mod.writeRunRecord(root, { ...mod.readRunRecord(root), proposal: null });

    writeFileSync(join(root, 'docs', 'runbooks', 'later.md'), '# Later\n');
    g('add', '-A');
    g('commit', '-qm', 'later work on main');
    const second = runOnce(root, g, forge, 'second.md', 'run two');

    assert.equal(forge.state.pulls.length, 1, 'still exactly one proposal — no second one opened');
    assert.equal(second.number, first.number, 'and it is the same one, found on the forge');
    assert.ok(forge.calls.some((c) => c.op === 'listPulls'), 'the forge was asked what exists');
    assert.ok(forge.calls.some((c) => c.op === 'updatePull'), 'and the existing proposal was updated');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('proposal: findOpenProposal matches on the head branch, not on anything else', () => {
  const forge = stubForge();
  forge.state.pulls.push(
    { number: 7, head: { ref: 'some-other-branch' }, state: 'open' },
    { number: 8, head: { ref: mod.PROPOSAL_BRANCH }, state: 'open' },
    { number: 9, head: { ref: mod.PROPOSAL_BRANCH }, state: 'closed' },
  );
  assert.equal(mod.findOpenProposal(forge, mod.PROPOSAL_BRANCH).number, 8);
  assert.equal(mod.findOpenProposal(forge, 'no-such-branch'), null);

  // A forge client without the endpoint must degrade, not throw.
  assert.equal(mod.findOpenProposal({ getPull: () => null }, mod.PROPOSAL_BRANCH), null);
});

test('proposal: a publish that fails after generation holds the marker and returns the work to the backlog', () => {
  // executeSlices advances the marker before publishing. If the push is then refused, the pages exist
  // only on a runner about to be discarded — the record must not certify them as dealt with.
  const { root, head } = repoAtHead();
  try {
    const before = mod.readRunRecord(root);
    const slice = { area: 'invariants', pages: ['first.md'], areaExists: true, reason: 'source changed' };
    mod.writeRunRecord(root, { ...before, coveredCommit: 'advanced-by-execute', lastOutcome: 'completed', backlog: [], lastRunUsage: { estCostUsd: 0.1 } });

    const held = mod.holdMarkerOnPublishFailure({ root, before, slices: [slice] });

    assert.equal(held.coveredCommit, head, 'the marker is back where the run found it');
    assert.equal(held.lastOutcome, 'failed');
    assert.deepEqual(held.backlog.map((s) => s.pages), [['first.md']], 'the run\'s work is outstanding again');
    assert.deepEqual(held.lastRunUsage, { estCostUsd: 0.1 }, 'the money was still spent — usage is kept');
    assert.equal(mod.readRunRecord(root).coveredCommit, head, 'persisted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 078 US6: escalation tags in the run record ──────────────────────────────────

test('US6 record: the committed record has no escalations and loads as none (FR-018)', () => {
  const root = mkdtempSync(join(tmpdir(), 'wiki-esc-'));
  try {
    mkdirSync(join(root, 'openwiki'), { recursive: true });
    cpSync(join(REPO_ROOT, mod.STATE_FILE), join(root, mod.STATE_FILE));
    assert.deepEqual(mod.readRunRecord(root).escalations, {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('US6 record: a malformed escalations map never reaches disk (Review Focus 4)', () => {
  const root = mkdtempSync(join(tmpdir(), 'wiki-esc-'));
  try {
    for (const bad of [[], 'x', { 'a/b.md': { effort: 'low', failuresAtLow: -1 } }, { 'a/b.md': { failuresAtLow: 0 } }, { 'a/b.md': null }]) {
      assert.throws(() => mod.writeRunRecord(root, { escalations: bad }), /escalations/, JSON.stringify(bad));
    }
    assert.deepEqual(mod.writeRunRecord(root, { escalations: { 'a/b.md': { effort: 'low', reason: 'deadline', since: 't', failuresAtLow: 0 } } }).escalations['a/b.md'].failuresAtLow, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 078 US6: escalation inside a run ─────────────────────────────────────────────

const DEADLINE = { clock: () => 1_000_000, deadlineMs: 1_000_000 + 60 * 60_000 };
const FIREWORKS_POLICY = { explicit: null, supportsLow: true };
const TAG = (n = 0) => ({ effort: 'low', reason: 'deadline', since: 't0', failuresAtLow: n });
// Writes exactly the invocation's own pages, so a split run never writes outside its boundary.
const ownPagesStub = (root) => (work) => {
  for (const p of mod.partsOf(work)) writingStub(root, p.area, p.pages)();
  return { status: 0 };
};

test('US6 run: a deadline stop that lands nothing tags the requested pages (AC1)', () => {
  const root = twoAreaRepo();
  try {
    const result = mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'), record: mod.readRunRecord(root), slices: [sl('invariants', ['one.md'])],
      attemptsPerSlice: 1, effortPolicy: FIREWORKS_POLICY, ...DEADLINE, invoke: () => ({ status: 124 }),
    });
    assert.equal(result.outcome, 'failed');
    const esc = mod.readRunRecord(root).escalations;
    assert.deepEqual(Object.keys(esc), ['invariants/one.md']);
    assert.equal(esc['invariants/one.md'].reason, 'deadline');
    assert.equal(result.results[0].deadlineStop, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('US6 run: a normal-exit failure tags nothing (AC2)', () => {
  const root = twoAreaRepo();
  try {
    mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'), record: mod.readRunRecord(root), slices: [sl('invariants', ['one.md'])],
      attemptsPerSlice: 1, effortPolicy: FIREWORKS_POLICY, ...DEADLINE, invoke: () => ({ status: 0 }),
    });
    assert.deepEqual(mod.readRunRecord(root).escalations, {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('US6 run: tagged pages run first, alone, at low; the rest at the default; landing clears the tag (AC3, AC5, FR-019)', () => {
  const root = twoAreaRepo();
  try {
    const calls = [];
    const stub = ownPagesStub(root);
    const record = { ...mod.readRunRecord(root), escalations: { 'gotchas/two.md': TAG() } };
    mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'), record, effortPolicy: FIREWORKS_POLICY,
      slices: [sl('invariants', ['one.md']), sl('gotchas', ['two.md'])],
      invoke: (work, ctx) => { calls.push({ pages: work.pages, effort: ctx.reasoningEffort }); return stub(work); },
    });
    assert.deepEqual(calls, [{ pages: ['two.md'], effort: 'low' }, { pages: ['one.md'], effort: null }]);
    assert.deepEqual(mod.readRunRecord(root).escalations, {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('US6 run: an explicit effort wins, packing is unchanged, and the tags are kept with exact keys (AC4, Review Focus 3)', () => {
  const root = twoAreaRepo();
  try {
    const calls = [];
    const record = { ...mod.readRunRecord(root), escalations: { 'gotchas/two.md': TAG(1) } };
    mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'), record, effortPolicy: { explicit: 'high', supportsLow: true },
      slices: [sl('invariants', ['one.md']), sl('gotchas', ['two.md'])], attemptsPerSlice: 1,
      invoke: (work, ctx) => { calls.push({ pages: work.pages, effort: ctx.reasoningEffort }); return { status: 0 }; },
    });
    assert.deepEqual(calls, [{ pages: ['invariants/one.md', 'gotchas/two.md'], effort: null }], 'one packed invocation, no override');
    assert.deepEqual(mod.readRunRecord(root).escalations, { 'gotchas/two.md': TAG(1) }, 'kept as-is: not reset, not counted, no area/area/page key');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('US6 run: a provider without effort ignores the tags and keeps them (AC7)', () => {
  const root = twoAreaRepo();
  try {
    const calls = [];
    const record = { ...mod.readRunRecord(root), escalations: { 'gotchas/two.md': TAG() } };
    mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'), record, effortPolicy: { explicit: null, supportsLow: false },
      slices: [sl('gotchas', ['two.md'])], attemptsPerSlice: 1,
      invoke: (work, ctx) => { calls.push(ctx.reasoningEffort); return { status: 0 }; },
    });
    assert.deepEqual(calls, [null]);
    assert.deepEqual(mod.readRunRecord(root).escalations, { 'gotchas/two.md': TAG() });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('US6 run: failing again at low increments the count and says so in the log (AC6, FR-021)', (t) => {
  const root = twoAreaRepo();
  try {
    const errors = t.mock.method(console, 'error', () => {});
    const record = { ...mod.readRunRecord(root), escalations: { 'gotchas/two.md': TAG(1) } };
    mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'), record, effortPolicy: FIREWORKS_POLICY,
      slices: [sl('gotchas', ['two.md'])], attemptsPerSlice: 1, invoke: () => ({ status: 0 }),
    });
    assert.equal(mod.readRunRecord(root).escalations['gotchas/two.md'].failuresAtLow, 2);
    assert.ok(mod.readRunRecord(root).backlog.some((b) => b.area === 'gotchas' && b.pages.includes('two.md')),
      'still queued: escalation never parks a page (FR-023)');
    const lines = errors.mock.calls.map((c) => String(c.arguments[0]));
    assert.ok(lines.some((l) => /escalated to low and still failing \(2\): gotchas\/two\.md/.test(l)), lines.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('US6 run: the usage summary carries the effort actually used (FR-022)', () => {
  const root = twoAreaRepo();
  try {
    const stub = ownPagesStub(root);
    const record = { ...mod.readRunRecord(root), escalations: { 'gotchas/two.md': TAG() } };
    const result = mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'), record, effortPolicy: FIREWORKS_POLICY, usage: USAGE_CTX,
      slices: [sl('gotchas', ['two.md'])],
      invoke: (work, ctx) => {
        writeFileSync(ctx.usageLog, `${JSON.stringify({ kind: 'page', status: 200, ms: 10, uncached: 1, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 })}\n`, { flag: 'a' });
        return stub(work);
      },
    });
    assert.equal(result.results[0].usage.reasoningEffort, 'low');
    assert.equal(result.results[0].effortUsed, 'low');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('US6 env: generatorEnv overrides the effort only when asked', () => {
  const base = { PATH: '/bin', MCM_WIKI_REASONING_EFFORT: '' };
  assert.equal(mod.generatorEnv('m', base, { reasoningEffort: 'low' }).MCM_WIKI_REASONING_EFFORT, 'low');
  assert.equal(mod.generatorEnv('m', base, {}).MCM_WIKI_REASONING_EFFORT, '');
  assert.equal(mod.generatorEnv('m', base, { reasoningEffort: null }).MCM_WIKI_REASONING_EFFORT, '');
});

test('US6 env: the CLI path hands executeSlices the escalation policy (structural, like the preflight pin)', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  const main = src.slice(src.indexOf('async function main'));
  assert.match(main, /effortPolicy:\s*escalationPolicy\(process\.env\)/);
});

test('US6 run: a deadline stop tags only the unlanded page of a multi-page part (review I1)', () => {
  const root = twoAreaRepo();
  try {
    mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'), record: mod.readRunRecord(root), slices: [sl('invariants', ['one.md', 'three.md'])],
      attemptsPerSlice: 1, effortPolicy: FIREWORKS_POLICY, ...DEADLINE,
      invoke: () => { writingStub(root, 'invariants', ['one.md'])(); return { status: 124 }; },
    });
    assert.deepEqual(Object.keys(mod.readRunRecord(root).escalations), ['invariants/three.md']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('US6 run: the record lists each invocation with the effort it ran at (FR-022, review I2)', () => {
  const root = twoAreaRepo();
  try {
    const stub = ownPagesStub(root);
    const record = { ...mod.readRunRecord(root), escalations: { 'gotchas/two.md': TAG() } };
    mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'), record, effortPolicy: FIREWORKS_POLICY,
      slices: [sl('invariants', ['one.md']), sl('gotchas', ['two.md'])], invoke: (work) => stub(work),
    });
    assert.deepEqual(mod.readRunRecord(root).lastRunInvocations.map(({ pages, effort, deadlineStop }) => ({ pages, effort, deadlineStop })), [
      { pages: ['gotchas/two.md'], effort: 'low', deadlineStop: false },
      { pages: ['invariants/one.md'], effort: null, deadlineStop: false },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── #682: the per-call usage log survives the run, in the bundle ──────────────────────────────────

test('usage (#682): in CI, each invocation\'s per-call tap lines are kept as a step log the digest bundles', async () => {
  const root = tmpGitRepo('conformant-bundle');
  const logRoot = mkdtempSync(join(tmpdir(), 'step-logs-'));
  try {
    const env = { GITHUB_RUN_ID: '4960', GITHUB_JOB: 'maintain', CI_STEP_LOG_ROOT: logRoot, HOME: logRoot };
    mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'), record: mod.readRunRecord(root),
      slices: [sl('invariants', ['one.md'])], attemptsPerSlice: 1, archiveEnv: env,
      invoke: (slice, { usageLog }) => {
        writeFileSync(usageLog, `${JSON.stringify({ kind: 'chat', status: 200, ms: 5, uncached: 100, cached: 170000 })}\n`);
        return writingStub(root, 'invariants', ['one.md'])();
      },
    });
    const kept = join(logRoot, '4960', 'maintain', 'wiki-usage.log');
    assert.ok(existsSync(kept), 'the tap lines outlive the temporary usage directory');
    const text = readFileSync(kept, 'utf8');
    assert.match(text, /invariants\/one\.md/, 'each invocation is headed by the pages it was for');
    assert.match(text, /"cached":170000/, 'and carries the per-call counts verbatim');
    const digest = await import(pathToFileURL(join(REPO_ROOT, 'scripts', 'ci-failure-digest.mjs')).href);
    const { excerpts } = digest.collectEvidence({ home: logRoot, cwd: root, env });
    assert.ok(excerpts.some((e) => e.source === 'step:wiki-usage'), 'the digest collector picks it up — writer and reader agree on the directory');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(logRoot, { recursive: true, force: true });
  }
});

test('usage (#682): outside CI (no GITHUB_RUN_ID) nothing is written beside the run', () => {
  const root = tmpGitRepo('conformant-bundle');
  const logRoot = mkdtempSync(join(tmpdir(), 'step-logs-'));
  try {
    mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'), record: mod.readRunRecord(root),
      slices: [sl('invariants', ['one.md'])], attemptsPerSlice: 1, archiveEnv: { CI_STEP_LOG_ROOT: logRoot },
      invoke: (slice, { usageLog }) => { writeFileSync(usageLog, '{"status":200}\n'); return writingStub(root, 'invariants', ['one.md'])(); },
    });
    assert.deepEqual(readdirSync(logRoot), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(logRoot, { recursive: true, force: true });
  }
});
