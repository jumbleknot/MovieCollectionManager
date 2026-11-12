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
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync, statSync, existsSync, cpSync, appendFileSync } from 'node:fs';
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
const { readDerivedPage, recordSourceFingerprint } = await import(pathToFileURL(join(REPO_ROOT, 'scripts', 'openwiki-fingerprint.mjs')).href);

const FIXTURES = join(REPO_ROOT, 'scripts', '__tests__', 'fixtures', 'wiki-maintain');

// ── 098: a rebuild keeps no state, and openwiki's own bookkeeping is not this module's ──────────

// openwiki's .last-update.json (043 data-model E3), the retired run record and the retired Claims
// sidecars are all gitignored since feature 098. Executable code that named any of them would be a
// rebuild writing, or planning from, state that no longer exists.
test('the module names no retired bookkeeping file in executable code', () => {
  const source = readFileSync(SCRIPT, 'utf8');
  const mentions = source.split('\n')
    .filter((l) => /\.last-update\.json|\.maintenance-state\.json|\.page-manifest\.json|\.claims\b/.test(l) && !/^\s*(\/\/|\*)/.test(l));
  assert.deepEqual(mentions, [], 'only comments may name them');
});

// ── the CLI harness ─────────────────────────────────────────────────────────────

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

test('run-message rendering carries every page of a full slice', () => {
  const pages = Array.from({ length: mod.MAX_PAGES_PER_SLICE }, (_, i) => `page-${i + 1}.md`);
  const message = mod.renderRunMessage({ area: 'invariants', pages, areaExists: false, reason: 'r' });
  for (const p of pages) assert.ok(message.includes(p), `run message must name ${p}`);
  assert.equal((message.match(/page-\d\.md/g) ?? []).length >= mod.MAX_PAGES_PER_SLICE, true);
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
    const slices = [{ area: 'invariants', pages: ['brand-new.md'], areaExists: true, reason: 'source changed' }];

    const result = mod.executeSlices({
      root,
      bundleRoot: join(root, 'openwiki'),
      slices,
      invoke: () => ({ status: 0 }), // exits 0, writes nothing at all
    });

    assert.equal(result.outcome, 'failed', 'zero pages written must be a failure whatever the generator says');
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.notLanded, ['invariants/brand-new.md'], 'the page must be reported as not landed');
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
    assert.deepEqual(result.notLanded, []);
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
    assert.deepEqual(result.notLanded, ['invariants/broken.md']);
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
        policy: realPolicy(),
        invoke: stubWriting(root, forbidden),
      });

      assert.equal(result.outcome, 'failed', `writing ${forbidden} must fail the run`);
      assert.equal(result.exitCode, 1);
      const surfaced = result.results[0].violations.join('\n');
      assert.match(surfaced, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the failure must name the offending path');
      assert.match(surfaced, expected, 'and say which policy state forbade it');
      assert.deepEqual(result.notLanded, ['invariants/ok-page.md'], 'the page is not landed');
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

test('bounds: one invocation of at most 4 pages, and the job deadline is the only stop (078 R9, item #613, 098)', () => {
  // 8 → 4 on 2026-11-03 (item #613, operator decision). Measured over 85 single-invocation runs: an
  // invocation of 5–8 pages hit the job deadline 69% of the time, 1–2 pages 37%, 3–4 pages 46%; none of
  // 5+ pages ever ended on its own. Source size predicted duration no better than page count (r 0.39).
  assert.equal(mod.MAX_PAGES_PER_INVOCATION, 4);
  // 30 → 65 on 2026-11-01 (item #613): derived from the measured fixture in wiki-maintain.guard.test.mjs.
  assert.equal(mod.WORST_INVOCATION_SECONDS, 65 * 60, 'measured 2958 s worst that ended on its own, +30%');
  // Feature 098: the page and start budgets carried work to the next scheduled fire, and there is none.
  for (const gone of ['PAGE_BUDGET', 'TIME_BUDGET_SECONDS']) assert.ok(!(gone in mod), `${gone} is retired with the backlog`);
  const header = readFileSync(SCRIPT, 'utf8');
  const c6 = header.slice(header.indexOf('C6 — what bounds a rebuild'));
  assert.match(c6, /runner occupancy/i, 'what the job deadline actually bounds is stated where the numbers are');
  assert.match(c6, /NOT A MONETARY BOUND/, 'and that it is not a cost control');
});

// ── 098 US4: a manual rebuild of operator-named pages (`--pages`) ──────────────────
//
// Scenarios covered: US4-AC1/AC2 (FR-018, FR-019). The generator stays only as a manual rebuild of
// the pages an operator names; nothing plans from a git range, nothing is carried in a backlog, and
// no run record is written. A landed page leaves with its source fingerprint recorded (V17).

const { sourceFingerprint } = await import(pathToFileURL(join(REPO_ROOT, 'scripts', 'openwiki-fingerprint.mjs')).href);
const SRC = 'scripts/__tests__/fixtures/wiki-maintain/source.txt';
const SRC_FP = sourceFingerprint(join(REPO_ROOT, SRC));
const STALE_FP = createHash('sha256').update('an older version of the source\n').digest('hex');

const derivedPage = (title, { fp = SRC_FP, extra = '', body = 'Body.' } = {}) =>
  `---\ntype: Runbook\ntitle: ${title}\ndescription: A derived page.\nresource: ${SRC}\nresource-sha256: ${fp}\n${extra}---\n${body}\n`;

/** A git repo whose bundle has runbooks/{a,b}.md and projects/c.md (derived) and invariants/canon.md (canonical). */
function rebuildRepo({ stale = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wiki-rebuild-'));
  const w = (rel, text) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  w('openwiki/index.md', '---\nokf_version: "0.1"\n---\n# Bundle\n- [r](runbooks/index.md)\n- [p](projects/index.md)\n- [i](invariants/index.md)\n');
  for (const [area, pages] of [['runbooks', ['a.md', 'b.md']], ['projects', ['c.md']]]) {
    for (const p of pages) {
      w(`openwiki/${area}/${p}`, derivedPage(p, stale.includes(`${area}/${p}`)
        ? { fp: STALE_FP, extra: 'sources:\n  - id: openwiki-source-1\n    resource: repo://x\nverified:\n  - by: openwiki/0.7.1\n    at: 2026-10-01T00:00:00Z\n' }
        : {}));
    }
    w(`openwiki/${area}/index.md`, `# ${area}\n${pages.map((p) => `- [${p}](${p})`).join('\n')}\n`);
  }
  w('openwiki/invariants/canon.md', '---\ntype: Invariant\ntitle: Canon\ndescription: Canonical.\n---\nBody.\n');
  w('openwiki/invariants/index.md', '# invariants\n- [canon](canon.md)\n');
  const g = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'test@example.invalid');
  g('config', 'user.name', 'Test');
  g('add', '-A');
  g('commit', '-qm', 'baseline');
  return root;
}

/** A stub generator that rewrites the BODY of each requested page and nothing else. */
const rewriting = (root, { skip = [] } = {}) => (work) => {
  for (const part of mod.partsOf(work)) {
    for (const page of part.pages) {
      if (skip.includes(`${part.area}/${page}`)) continue;
      const file = join(root, 'openwiki', part.area, page);
      writeFileSync(file, readFileSync(file, 'utf8').replace(/\nBody\.\n$/, '\nBody, rebuilt.\n'));
    }
  }
  return { status: 0 };
};

test('--pages: named pages are grouped into one slice per area, each carrying renderRunMessage\'s message', () => {
  const root = rebuildRepo();
  try {
    const slices = mod.pagesToSlices({ root, pages: 'runbooks/a.md,runbooks/b.md,projects/c.md' });
    assert.deepEqual(slices.map((s) => [s.area, s.pages]), [['runbooks', ['a.md', 'b.md']], ['projects', ['c.md']]]);
    for (const s of slices) {
      assert.equal(s.areaExists, true);
      assert.equal(s.kind, 'refresh');
      const { runMessage, ...slice } = s;
      assert.equal(runMessage, mod.renderRunMessage(slice));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--pages: a canonical page, an unknown page and an empty list are refused before anything runs', () => {
  const root = rebuildRepo();
  try {
    assert.throws(() => mod.pagesToSlices({ root, pages: 'invariants/canon.md' }), /canonical/);
    assert.throws(() => mod.pagesToSlices({ root, pages: 'runbooks/nope.md' }), /no such page/);
    assert.throws(() => mod.pagesToSlices({ root, pages: ' , ' }), /no page/);
    assert.throws(() => mod.pagesToSlices({ root, pages: '../etc/passwd' }), /area\/page\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--pages CLI: refusals exit 2 and invoke nothing — canonical, unknown, empty, and the retired --since', () => {
  for (const args of [
    ['--pages', 'invariants/auth-chain.md'],
    ['--pages', 'runbooks/no-such-page.md'],
    ['--pages', ','],
    ['--pages='],
    ['--pages', 'runbooks/backlog.md', '--since', 'HEAD~1'],
    ['--plan'],
    ['--execute'],
  ]) {
    const { code, invoked, out } = runCli(args);
    assert.equal(code, 2, `${args.join(' ')} → ${code}\n${out}`);
    assert.equal(invoked, '', `${args.join(' ')} must invoke nothing`);
  }
});

test('--pages CLI: --dry-run renders one slice per area and invokes nothing', () => {
  const { code, invoked, out } = runCli(['--pages', 'runbooks/backlog.md,runbooks/local-dev.md,projects/bff.md', '--dry-run']);
  assert.equal(code, 0, out);
  assert.equal(invoked, '');
  assert.match(out, /rebuilding 3 named page\(s\) in 2 slice\(s\)/);
  assert.match(out, /^ {2}runbooks\/ — backlog\.md, local-dev\.md$/m);
  assert.match(out, /^ {2}projects\/ — bff\.md$/m);
  assert.match(out, /runbooks \+ projects\/ →/, 'the two areas pack into ONE invocation (078 US2)');
  assert.match(out, /openwiki\/runbooks\/backlog\.md; openwiki\/runbooks\/local-dev\.md; openwiki\/projects\/bff\.md/);
});

test('--pages: a landed page leaves with its current fingerprint and without sources/verified', () => {
  const root = rebuildRepo({ stale: ['runbooks/a.md'] });
  try {
    const result = mod.executeSlices({
      root,
      slices: mod.pagesToSlices({ root, pages: 'runbooks/a.md' }),
      invoke: rewriting(root),
    });
    assert.equal(result.exitCode, 0, JSON.stringify(result.results.map((r) => r.violations)));
    const text = readFileSync(join(root, 'openwiki/runbooks/a.md'), 'utf8');
    assert.match(text, new RegExp(`^resource-sha256: ${SRC_FP}$`, 'm'));
    assert.doesNotMatch(text, /^(sources|verified):/m);
    assert.match(text, /Body, rebuilt\./);
    assert.deepEqual(result.landed, ['runbooks/a.md']);
    assert.deepEqual(result.notLanded, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--pages: exit 0 when every named page landed, 1 when any did not — and both are named', () => {
  const root = rebuildRepo({ stale: ['runbooks/a.md', 'runbooks/b.md'] });
  try {
    const result = mod.executeSlices({
      root,
      slices: mod.pagesToSlices({ root, pages: 'runbooks/a.md,runbooks/b.md' }),
      invoke: rewriting(root, { skip: ['runbooks/b.md'] }),
      attemptsPerSlice: 1,
    });
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.landed, ['runbooks/a.md']);
    assert.deepEqual(result.notLanded, ['runbooks/b.md']);
    assert.match(result.results[0].violations.join(' '), /runbooks\/b\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--pages: the report lists `landed:` and `not landed:`, and no run record is written', async () => {
  const root = rebuildRepo({ stale: ['runbooks/a.md', 'projects/c.md'] });
  try {
    const lines = [];
    const log = console.log;
    const err = console.error;
    console.log = (...a) => lines.push(a.join(' '));
    console.error = (...a) => lines.push(a.join(' '));
    let code;
    try {
      code = await mod.executeRun({
        root,
        opts: { pages: 'runbooks/a.md,projects/c.md', dryRun: false, json: false, propose: false },
        invoke: rewriting(root, { skip: ['projects/c.md'] }),
        preflight: null,
        attemptsPerSlice: 1,
      });
    } finally {
      console.log = log;
      console.error = err;
    }
    assert.equal(code, 1);
    const out = lines.join('\n');
    assert.match(out, /^\[wiki-maintain\] landed: runbooks\/a\.md$/m);
    assert.match(out, /^\[wiki-maintain\] not landed: projects\/c\.md$/m);
    assert.equal(existsSync(join(root, 'openwiki', '.maintenance-state.json')), false, 'a rebuild keeps no run record');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--pages: a page the generator did not rewrite, whose source moved since its fingerprint, is not landed', () => {
  const root = rebuildRepo({ stale: ['runbooks/a.md'] });
  try {
    const result = mod.executeSlices({
      root,
      slices: mod.pagesToSlices({ root, pages: 'runbooks/a.md' }),
      invoke: () => ({ status: 0 }),
      attemptsPerSlice: 1,
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.results[0].violations.join(' '), /still stale/);
    assert.match(readFileSync(join(root, 'openwiki/runbooks/a.md'), 'utf8'), new RegExp(`resource-sha256: ${STALE_FP}`), 'an unrefreshed page is never re-recorded');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--pages: a page whose source has NOT moved may honestly be left as it is', () => {
  const root = rebuildRepo();
  try {
    const result = mod.executeSlices({ root, slices: mod.pagesToSlices({ root, pages: 'projects/c.md' }), invoke: () => ({ status: 0 }) });
    assert.equal(result.exitCode, 0, JSON.stringify(result.results.map((r) => r.violations)));
    assert.equal(result.results[0].noChange, true);
    assert.deepEqual(result.landed, ['projects/c.md']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--pages: an unrequested page the generator rewrote is put back, whatever the exit', () => {
  const root = rebuildRepo({ stale: ['runbooks/a.md'] });
  try {
    const result = mod.executeSlices({
      root,
      slices: mod.pagesToSlices({ root, pages: 'runbooks/a.md' }),
      invoke: (work) => {
        rewriting(root)(work);
        writeFileSync(join(root, 'openwiki/projects/c.md'), derivedPage('c.md', { body: 'Rewritten without being asked.' }));
        return { status: 0 };
      },
    });
    assert.equal(result.exitCode, 0, JSON.stringify(result.results.map((r) => r.violations)));
    assert.doesNotMatch(readFileSync(join(root, 'openwiki/projects/c.md'), 'utf8'), /without being asked/);
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
    const { code, out } = runCli(['--pages', 'runbooks/backlog.md'], { env: { [name]: 'sk-ant-planted-by-the-test' } });
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

test('CLI: --pages without a credential exits 2 rather than pretending there was nothing to do', () => {
  // FR-017: a credential failure must NEVER be reported as `nothing-to-do`. That is the one
  // misclassification that makes the cheap path look reachable while the work silently never happens.
  const { code, out } = runCli(['--pages', 'runbooks/backlog.md']);
  assert.equal(code, 2, `expected exit 2, got ${code}\n${out}`);
  assert.match(out, /ANTHROPIC_API_KEY/);
  assert.doesNotMatch(out, /nothing-to-do/);
});

test('CLI: --dry-run writes nothing and invokes nothing, even with a credential present', () => {
  const before = spawnSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout;
  const { code, out, invoked } = runCli(['--pages', 'runbooks/backlog.md', '--dry-run'], { env: { ANTHROPIC_API_KEY: 'not-a-real-key' } });
  assert.equal(invoked, '', 'a dry run must invoke nothing');
  assert.equal(code, 0, out);
  assert.match(out, /pnpm nx wiki-update infrastructure-as-code/);
  const after = spawnSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout;
  assert.equal(after, before, 'a dry run must not touch the tree');
});

test('dry run renders the exact command and message per slice, and invokes nothing', () => {
  const root = tmpGitRepo('conformant-bundle');
  try {
    let invoked = 0;
    const result = mod.executeSlices({
      root,
      bundleRoot: join(root, 'openwiki'),
      slices: [{ area: 'gotchas', pages: ['a.md', 'b.md'], areaExists: true, reason: 'r' }],
      dryRun: true,
      invoke: () => { invoked++; return { status: 0 }; },
    });
    assert.equal(invoked, 0, 'a dry run must invoke nothing');
    assert.deepEqual(result.results[0].command.slice(0, 4), ['pnpm', 'nx', 'wiki-update', 'infrastructure-as-code']);
    assert.match(result.results[0].runMessage, /openwiki\/gotchas\/a\.md/);
    assert.match(result.results[0].runMessage, /openwiki\/gotchas\/b\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: mutually exclusive modes, a missing mode and retired flags exit 2; --help exits 0 and does nothing', () => {
  assert.equal(runCli(['--pages', 'runbooks/backlog.md', '--selftest']).code, 2);
  assert.equal(runCli([]).code, 2);
  assert.equal(runCli(['--normalize-links', '--propose']).code, 2, '--propose applies only to --pages');
  for (const retired of ['--max-slices', '--merge-record', '--claims-audit', '--page-budget']) {
    assert.equal(runCli(['--pages', 'runbooks/backlog.md', retired, '1']).code, 2, retired);
  }
  const help = runCli(['--pages', 'runbooks/backlog.md', '--help']);
  assert.equal(help.code, 0);
  assert.equal(help.invoked, '');
  assert.match(help.out, /--pages/);
});

/** A temp repo with the real policy and a conformant bundle, committed. */
function repoAtHead(fixtureName = 'conformant-bundle') {
  const root = repoWithPolicy(fixtureName);
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  return { root, head };
}

// ── 078 US2 / FR-007: one generator run per group of areas, not one per area ─────────
//
// Every generator invocation pays a fixed planning pass (~$0.33 on Sonnet, research R5) whatever its
// scope, and slices are per area. Packing same-kind slices into one invocation pays it once. The
// per-area SLICE stays the unit of verification, so a failure still narrows to the areas that failed.

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

test('packing: two slices of the SAME area are never re-merged — they were split on purpose', () => {
  // pagesToSlices only produces two slices for one area when that area exceeds the slice cap; packing
  // them back together would undo that decision.
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

// ── PR #857: the verifier runs the GOVERNANCE gate, not only the OKF gate ──────────────────────
// Measured on run 6049: the generator rewrote openwiki/projects/bff.md WITHOUT its `resource:` (and
// without description/tags). The page stayed OKF-conformant, so verifySlice passed it and the run
// opened a PR that guardrails then failed on G11 — "NEITHER derived nor authoritative". The gate
// that would have refused it already existed; the verifier never called it.

/** A full root with BOTH governance files, committed: the governance fixture that passes. */
function governedRepo() {
  const root = mkdtempSync(join(tmpdir(), 'wiki-gov-'));
  cpSync(join(REPO_ROOT, 'scripts', '__tests__', 'fixtures', 'openwiki-governance', 'valid'), root, { recursive: true });
  // V17 (feature 098): every derived page must carry its source's current fingerprint. The fixture's
  // pages cite real repository files, resolved — like the OKF gate does — from REPO_ROOT, so they are
  // recorded here, at copy time, rather than pinned in a fixture that every source edit would break.
  for (const area of readdirSync(join(root, 'openwiki'), { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.'))) {
    for (const f of readdirSync(join(root, 'openwiki', area.name)).filter((n) => n.endsWith('.md') && n !== 'index.md')) {
      const abs = join(root, 'openwiki', area.name, f);
      if (readDerivedPage(abs, { root: REPO_ROOT })) recordSourceFingerprint(abs, { root: REPO_ROOT });
    }
  }
  for (const args of [['init', '-q'], ['config', 'user.email', 't@e.invalid'], ['config', 'user.name', 'T'], ['add', '-A'], ['commit', '-qm', 'baseline']]) {
    spawnSync('git', args, { cwd: root });
  }
  return root;
}

/** A real refresh rewrites the BODY — a header-only change reads as still stale, a different violation. */
const refreshed = (text) => text.replace(/\n---\n/, '\n---\nRefreshed. ');

test('verify: a regenerated page that DROPS its resource is a governance violation, not a proposable page (#857)', () => {
  const root = governedRepo();
  try {
    const page = join(root, 'openwiki', 'runbooks', 'local-dev.md');
    const before = mod.snapshotTree(root);
    // What the generator did to bff.md: same page, front matter rewritten without `resource:`.
    writeFileSync(page, refreshed(readFileSync(page, 'utf8')).replace(/^resource: .*\n/m, ''));
    const v = mod.verifySlice({ root, bundleRoot: join(root, 'openwiki'), slice: sl('runbooks', ['local-dev.md']), before });
    assert.equal(v.ok, false, 'a page with no determinable home must not be proposed');
    assert.ok(v.violations.some((x) => /governance/i.test(x) && /local-dev\.md/.test(x)), v.violations.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verify: the same rewrite KEEPING its resource passes both gates — the check is not a blanket refusal', () => {
  const root = governedRepo();
  try {
    const page = join(root, 'openwiki', 'runbooks', 'local-dev.md');
    const before = mod.snapshotTree(root);
    writeFileSync(page, refreshed(readFileSync(page, 'utf8')).replace('Summary of the local stack bring-up order.', 'The local stack bring-up order.'));
    const v = mod.verifySlice({ root, bundleRoot: join(root, 'openwiki'), slice: sl('runbooks', ['local-dev.md']), before });
    assert.deepEqual(v.violations, []);
    assert.equal(v.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Item #777: openwiki's MINIMAL front-matter rebuild drops the repository's keys ─────────────
// openwiki 0.7.1 repairs a page whose model-written YAML does not parse by rebuilding a minimal header
// (okf/frontmatter.js repairOkfFrontmatter → rebuildMinimalConcept): `type: "Reference"`, a quoted
// title, `openwiki_generated: true`, then verified/sources/generated on finalisation. Everything else
// is gone — #775 stacks.md, #791 renovate.md, #857 bff.md. The harness restores the lost keys from
// HEAD (`resource-sha256` among them since feature 098), as it fixes link form.

/** The #775 shape: the page as the rebuild leaves it. */
function minimalRebuild(root, rel = 'runbooks/local-dev.md') {
  const page = join(root, 'openwiki', rel);
  const body = readFileSync(page, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '');
  const rebuilt = '---\ntype: "Reference"\ntitle: "Local Development Stack"\nopenwiki_generated: true\n'
    + 'verified:\n  - by: openwiki/0.7.1\n    at: 2026-10-17T13:24:33.842Z\n'
    + 'sources:\n  - id: openwiki-source-1\n    resource: repo://docs/runbooks/local-dev.md\n'
    + 'generated: { by: "openwiki/0.7.1", at: "2026-10-17T13:24:33.842Z" }\n---\n' + body;
  writeFileSync(page, rebuilt);
  return page;
}

test('frontmatter (#777): a minimal rebuild gets resource/fingerprint/description/type back from HEAD', () => {
  const root = governedRepo();
  try {
    const page = minimalRebuild(root);
    const changed = mod.restoreRebuiltFrontmatter({ root, files: ['openwiki/runbooks/local-dev.md'] });
    assert.equal(changed.length, 1, 'the rebuilt page was not restored');
    const text = readFileSync(page, 'utf8');
    const header = text.match(/^---\n([\s\S]*?)\n---\n/)[1];
    assert.match(header, /^resource: docs\/runbooks\/local-dev\.md$/m, 'resource not restored');
    assert.match(header, /^resource-sha256: [0-9a-f]{64}$/m, 'the source fingerprint not restored (V17 would then fail an unchanged page)');
    assert.match(header, /^description: Summary of the local stack bring-up order\.$/m, 'description not restored');
    assert.match(header, /^type: Runbook$/m, 'the fallback type was kept instead of HEAD\'s');
    assert.doesNotMatch(header, /openwiki_generated/, 'the rebuild marker was left behind');
    assert.match(header, /^ {4}resource: repo:\/\/docs\/runbooks\/local-dev\.md$/m, 'a NESTED sources resource was disturbed (the fingerprint post-step strips sources, not this function)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('frontmatter (#777): verifySlice proposes a minimal-rebuilt page once restored — governance passes', () => {
  const root = governedRepo();
  try {
    const before = mod.snapshotTree(root);
    minimalRebuild(root);
    const v = mod.verifySlice({ root, bundleRoot: join(root, 'openwiki'), slice: sl('runbooks', ['local-dev.md']), before });
    assert.deepEqual(v.violations.filter((x) => /governance/i.test(x)), [], v.violations.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('frontmatter (#777): a page WITHOUT the rebuild marker is left alone — a plain drop still fails governance', () => {
  // The #857 guard above stays meaningful: only openwiki's diagnosed fallback is repaired.
  const root = governedRepo();
  try {
    const page = join(root, 'openwiki', 'runbooks', 'local-dev.md');
    writeFileSync(page, readFileSync(page, 'utf8').replace(/^resource: .*\n/m, ''));
    const changed = mod.restoreRebuiltFrontmatter({ root, files: ['openwiki/runbooks/local-dev.md'] });
    assert.deepEqual(changed, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('frontmatter (#777): a NEW page (not at HEAD) carrying the marker is left alone — there is nothing to restore from', () => {
  const root = governedRepo();
  try {
    const rel = 'openwiki/runbooks/brand-new.md';
    writeFileSync(join(root, rel), '---\ntype: "Reference"\ntitle: "New"\nopenwiki_generated: true\n---\n# New\n');
    assert.deepEqual(mod.restoreRebuiltFrontmatter({ root, files: [rel] }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('execute: three areas are written by ONE invocation (SC-003), and every page is verified', () => {
  const root = twoAreaRepo();
  try {
    const calls = [];
    const result = mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'),
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
    assert.deepEqual(result.notLanded, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('execute: when one area of a group fails, ONLY that area is not landed', () => {
  const root = twoAreaRepo();
  try {
    const good = sl('invariants', ['one.md']);
    const bad = sl('gotchas', ['two.md']);
    const result = mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'),
      slices: [good, bad], attemptsPerSlice: 1,
      invoke: () => { writingStub(root, 'invariants', ['one.md'])(); return { status: 0 }; },
    });
    assert.equal(result.outcome, 'failed');
    assert.deepEqual(result.notLanded, ['gotchas/two.md'], 'the landed area is not reported as failed');
    assert.ok(existsSync(join(root, 'openwiki', 'invariants', 'one.md')), 'and its page is kept');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('execute: the LANDED part of a failed group is counted and proposable, not just left on the runner', () => {
  // Measured 2026-10-01, run 4399: runbooks/backlog.md verified, projects/sast.md was still stale when
  // the deadline stopped the generator. The group failed, so main() proposed nothing (it proposed only
  // r.ok results), and the landed page was LOST. A failure attributable to a part (missing/stale;
  // conformance and policy clean) must leave the landed parts proposable.
  const root = twoAreaRepo();
  try {
    const good = sl('invariants', ['one.md']);
    const bad = sl('gotchas', ['two.md']);
    const result = mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'),
      slices: [good, bad], attemptsPerSlice: 1,
      invoke: () => { writingStub(root, 'invariants', ['one.md'])(); return { status: 0 }; },
    });
    assert.equal(result.outcome, 'failed', 'the run still reports the failure');
    assert.deepEqual(result.notLanded, ['gotchas/two.md'], 'only the failed page is not landed');
    assert.deepEqual(result.results[0].landedParts, [good]);
    assert.equal(result.pagesWritten, 1, 'the landed page counts, so a proposal is published');
    assert.deepEqual(mod.landedPages(result), ['invariants/one.md'], 'and it is what the proposal carries');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A derived page citing the stable fixture source with an OUTDATED fingerprint: stale going in. */
const stalePage = (title, body = 'Body.', extra = '') =>
  `---\ntype: Convention\ntitle: ${title}\ndescription: Stale.\nresource: ${SRC}\nresource-sha256: ${STALE_FP}\n${extra}---\n${body}\n`;

test('execute (#685): a failed part\'s restore-only change does NOT ride along with the landed part (run 4801)', () => {
  // Run 4801: projects/sast verified; runbooks/sast-scanning's worker exited without submitting, and
  // openwiki's restore path rewrote that page's HEADER only. No gate noticed, and the landed part's
  // proposal carried the failed page too. The failed page must go back to its committed bytes.
  const root = twoAreaRepo();
  try {
    writeFileSync(join(root, 'openwiki', 'gotchas', 'two.md'), stalePage('two', 'Body.', 'tags: [a]\n'));
    writeFileSync(join(root, 'openwiki', 'gotchas', 'index.md'), '# Gotchas\n- [two](two.md)\n');
    spawnSync('git', ['add', '-A'], { cwd: root });
    spawnSync('git', ['commit', '-qm', 'stale page'], { cwd: root });
    const committed = (rel) => spawnSync('git', ['show', `HEAD:${rel}`], { cwd: root, encoding: 'utf8' }).stdout;

    const good = sl('invariants', ['one.md']);
    const restoredOnly = sl('gotchas', ['two.md']);
    const { value: result, lines } = capturingErrors(() => mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'),
      slices: [good, restoredOnly], attemptsPerSlice: 1,
      invoke: () => {
        writingStub(root, 'invariants', ['one.md'])();
        writeFileSync(join(root, 'openwiki', 'gotchas', 'two.md'), stalePage('two'));
        return { status: 0 };
      },
    }));

    assert.equal(result.outcome, 'failed');
    assert.deepEqual(result.results[0].stalePages, ['gotchas/two.md'], 'premise: the header-only page failed as stale');
    assert.deepEqual(mod.landedPages(result), ['invariants/one.md'], 'the landed part is still proposed');
    assert.equal(readFileSync(join(root, 'openwiki/gotchas/two.md'), 'utf8'), committed('openwiki/gotchas/two.md'), 'the failed page is back at its committed bytes');
    assert.ok(existsSync(join(root, 'openwiki', 'invariants', 'one.md')), 'the landed page is untouched');
    const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout;
    assert.doesNotMatch(dirty, /gotchas\/two/, `nothing of the failed part is left to ride along:\n${dirty}`);
    assert.ok(lines.some((l) => /\[wiki-maintain\].*restored.*gotchas\/two\.md/.test(l)), `the run says what it restored:\n${lines.join('\n')}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('execute (#720): one failed page does NOT discard its landed AREA-MATES (run 5010)', () => {
  // Run 5010 (2026-10-10): runbooks/devcontainer-sandbox.md exited without submitting, while
  // runbooks/ci-evidence-pipeline.md and runbooks/sast-scanning.md completed. Failure was judged per
  // AREA, so the two completed pages were restored with the failed one, and only projects/sast.md
  // (another area) was proposed. Landing is a property of a PAGE.
  const root = twoAreaRepo();
  try {
    writeFileSync(join(root, 'openwiki', 'gotchas', 'stuck.md'), stalePage('stuck', 'Original.', 'tags: [a]\n'));
    writeFileSync(join(root, 'openwiki', 'gotchas', 'two.md'), '---\ntype: Convention\ntitle: two\ndescription: Old.\n---\nOld.\n');
    writeFileSync(join(root, 'openwiki', 'gotchas', 'three.md'), '---\ntype: Convention\ntitle: three\ndescription: Old.\n---\nOld.\n');
    writeFileSync(join(root, 'openwiki', 'gotchas', 'index.md'), '# Gotchas\n- [stuck](stuck.md)\n- [two](two.md)\n- [three](three.md)\n');
    spawnSync('git', ['add', '-A'], { cwd: root });
    spawnSync('git', ['commit', '-qm', 'run 5010 shape'], { cwd: root });
    const committed = (rel) => spawnSync('git', ['show', `HEAD:${rel}`], { cwd: root, encoding: 'utf8' }).stdout;

    const other = sl('invariants', ['one.md']);
    const area = sl('gotchas', ['stuck.md', 'two.md', 'three.md']);
    const result = mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'),
      slices: [other, area], attemptsPerSlice: 1,
      invoke: () => {
        writingStub(root, 'invariants', ['one.md'])();
        writingStub(root, 'gotchas', ['two.md', 'three.md'])();
        // The worker that never submitted: its header touched, its body not — still stale.
        writeFileSync(join(root, 'openwiki', 'gotchas', 'stuck.md'), stalePage('stuck', 'Original.'));
        return { status: 0 };
      },
    });

    assert.equal(result.outcome, 'failed', 'the stuck page still fails the run');
    assert.deepEqual(result.results[0].failedPages, ['gotchas/stuck.md'], 'premise: exactly one page failed');
    assert.deepEqual(result.notLanded, ['gotchas/stuck.md'], 'only the failed PAGE is not landed, not its area-mates');
    assert.deepEqual(mod.landedPages(result), ['invariants/one.md', 'gotchas/two.md', 'gotchas/three.md'], 'the landed area-mates are proposed');
    assert.equal(result.pagesWritten, 3, 'and counted');
    assert.equal(readFileSync(join(root, 'openwiki', 'gotchas', 'stuck.md'), 'utf8'), committed('openwiki/gotchas/stuck.md'),
      'only the failed page is restored');
    for (const page of ['two.md', 'three.md']) {
      assert.match(readFileSync(join(root, 'openwiki', 'gotchas', page), 'utf8'), /Written by the stub/, `${page} keeps its new bytes`);
    }
    const okf = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'check-openwiki-okf.mjs'), '--bundle', join(root, 'openwiki')], { cwd: REPO_ROOT, encoding: 'utf8' });
    const notV17 = `${okf.stdout}${okf.stderr}`.split('\n').filter((l) => l.includes('✗') && !/\(V17\)|violation\(s\)/.test(l));
    assert.deepEqual(notV17, [], 'the proposed tree stays conformant, index.md included (V9) — only the restored stale page remains for V17');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('execute (#719): a failed page\'s worker trail is printed from the page-attributed usage log', () => {
  const root = twoAreaRepo();
  const logged = [];
  const realError = console.error;
  console.error = (...args) => { logged.push(args.join(' ')); };
  try {
    const tap = (o) => `${JSON.stringify({ kind: 'page', status: 200, uncached: 10, cached: 0, output: 1, badArgs: 0, ...o })}\n`;
    mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'),
      slices: [sl('invariants', ['one.md']), sl('gotchas', ['two.md'])], attemptsPerSlice: 1,
      invoke: (_work, { usageLog }) => {
        writingStub(root, 'invariants', ['one.md'])();
        appendFileSync(usageLog, tap({ page: 'invariants/one.md', finish: 'tool_calls', tools: ['submit_page'] }));
        appendFileSync(usageLog, tap({ page: 'gotchas/two.md', finish: 'tool_calls', tools: ['write_file'] }));
        appendFileSync(usageLog, tap({ page: 'gotchas/two.md', finish: 'length', tools: [] }));
        return { status: 0 };
      },
    });
  } finally {
    console.error = realError;
    rmSync(root, { recursive: true, force: true });
  }
  const trail = logged.filter((l) => /worker trail/.test(l));
  assert.equal(trail.length, 1, `exactly the failed page is traced:\n${logged.join('\n')}`);
  assert.match(trail[0], /gotchas\/two\.md: 2 call\(s\).*never called submit_page.*tool_calls\[write_file\] → length\[\]/);
});

test('execute (#685): a failed part\'s path that was ALREADY dirty before the invocation is left alone', () => {
  const root = twoAreaRepo();
  try {
    writeFileSync(join(root, 'openwiki', 'gotchas', 'two.md'), stalePage('two', 'Committed.'));
    writeFileSync(join(root, 'openwiki', 'gotchas', 'index.md'), '# Gotchas\n- [two](two.md)\n');
    spawnSync('git', ['add', '-A'], { cwd: root });
    spawnSync('git', ['commit', '-qm', 'stale page'], { cwd: root });
    // An operator's uncommitted edit: its bytes are not in git, so restoring would destroy it.
    writeFileSync(join(root, 'openwiki', 'gotchas', 'two.md'), stalePage('two', 'Operator edit.'));

    const result = mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'),
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
      root, bundleRoot: join(root, 'openwiki'),
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('execute (#683): a rate limit whose wait would overrun the job deadline is NOT retried, and is reported as a rate limit', () => {
  const root = tmpGitRepo('conformant-bundle');
  try {
    let t = 0;
    const slept = [];
    let call = 0;
    const { value: result, lines } = capturingErrors(() => mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'),
      slices: [sl('invariants', ['one.md'])],
      // The generator's minimum plus 30 s: after a 10 s attempt, a 60 s wait would leave less than it.
      deadlineMs: mod.DEADLINE_RESERVE_MS + mod.MIN_GENERATOR_MS + 30_000,
      clock: () => t,
      sleep: (ms) => { slept.push(ms); t += ms; },
      invoke: (slice, ctx) => { call++; t += 10_000; return rateLimitedStub(3)(slice, ctx); },
    }));
    assert.equal(call, 1, 'retrying straight into an active rate limit cannot succeed');
    assert.deepEqual(slept, []);
    assert.equal(result.outcome, 'failed');
    assert.deepEqual(result.results[0].rateLimited, { attempts: 1, calls: 3 });
    assert.ok(lines.some((l) => /\[wiki-maintain\].*RATE-LIMITED.*not retrying/i.test(l)), lines.join('\n'));
    assert.ok(!lines.some((l) => /produced nothing usable — retrying/.test(l)), 'never the ordinary "produced nothing" retry');
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
      root, bundleRoot: join(root, 'openwiki'),
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
    assert.ok(lines.some((l) => /attempt 1 produced nothing usable — retrying \(2\/3\)/.test(l)), lines.join('\n'));
    assert.ok(!lines.some((l) => /RATE-LIMITED/.test(l)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('execute: a whole-invocation failure (conformance/policy) proposes nothing and fails every part', () => {
  const root = twoAreaRepo();
  try {
    const good = sl('invariants', ['one.md']);
    const other = sl('gotchas', ['two.md']);
    const result = mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'),
      slices: [good, other], attemptsPerSlice: 1,
      // Lands both pages but leaves the bundle non-conformant (the index links a page that does not
      // exist, V15). Not an unrequested PAGE: those are put back before verification (feature 098).
      invoke: () => {
        writingStub(root, 'invariants', ['one.md'])();
        writingStub(root, 'gotchas', ['two.md'])();
        writeFileSync(join(root, 'openwiki', 'gotchas', 'index.md'), '# Gotchas\n- [two](two.md)\n- [gone](gone.md)\n');
        return { status: 0 };
      },
    });
    assert.equal(result.outcome, 'failed');
    assert.deepEqual(result.results[0].landedParts ?? [], [], 'nothing is proposable from a non-conformant tree');
    assert.deepEqual(mod.landedPages(result), []);
    assert.deepEqual(result.notLanded, ['invariants/one.md', 'gotchas/two.md'], 'every page is not landed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('execute: a stale page left unwritten in ONE area fails only that area, by area/page (#587)', () => {
  const root = twoAreaRepo();
  try {
    // Both pages' recorded fingerprints are outdated going in.
    writeFileSync(join(root, 'openwiki', 'invariants', 'one.md'), stalePage('one'));
    writeFileSync(join(root, 'openwiki', 'gotchas', 'two.md'), stalePage('two'));
    writeFileSync(join(root, 'openwiki', 'invariants', 'index.md'), '# Invariants\n- [Auth Chain](auth-chain.md)\n- [one](one.md)\n');
    writeFileSync(join(root, 'openwiki', 'gotchas', 'index.md'), '# Gotchas\n- [two](two.md)\n');
    spawnSync('git', ['add', '-A'], { cwd: root });
    spawnSync('git', ['commit', '-qm', 'stale pages'], { cwd: root });

    const good = sl('invariants', ['one.md']);
    const skipped = sl('gotchas', ['two.md']);
    const calls = [];
    const result = mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'),
      slices: [good, skipped], attemptsPerSlice: 1,
      // Rewrites one area's page and silently skips the other's: the 2026-09-26 renovate.md shape.
      invoke: (work) => {
        calls.push(work);
        writeFileSync(join(root, 'openwiki', 'invariants', 'one.md'), stalePage('one', 'Body, rewritten.'));
        return { status: 0 };
      },
    });
    assert.equal(calls.length, 1, 'one generator run for both areas');
    assert.equal(result.outcome, 'failed');
    assert.deepEqual(result.results[0].stalePages, ['gotchas/two.md']);
    const why = result.results[0].violations.join('\n');
    assert.match(why, /gotchas\/two\.md/);
    assert.doesNotMatch(why, /invariants\/one\.md/, 'the area that was rewritten is not blamed');
    assert.deepEqual(result.notLanded, ['gotchas/two.md'], 'only the stale area is not landed');
    assert.match(readFileSync(join(root, 'openwiki/invariants/one.md'), 'utf8'), new RegExp(`resource-sha256: ${SRC_FP}`), 'the rewritten page is recorded');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('execute: a requested page changed ONLY in front matter is still stale — not a refresh (#616)', () => {
  // Measured on #615: the run deleted a `verified:` block from runbooks/ci-diagnostics.md, left the
  // body alone, and reported the page "written". A header-only change is not a refresh: it is not
  // recorded, and the page fails as stale.
  const root = twoAreaRepo();
  try {
    writeFileSync(join(root, 'openwiki', 'gotchas', 'two.md'), stalePage('two', 'Body.', 'tags: [a]\n'));
    writeFileSync(join(root, 'openwiki', 'gotchas', 'index.md'), '# Gotchas\n- [two](two.md)\n');
    spawnSync('git', ['add', '-A'], { cwd: root });
    spawnSync('git', ['commit', '-qm', 'stale page'], { cwd: root });

    const result = mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'),
      slices: [sl('gotchas', ['two.md'])], attemptsPerSlice: 1,
      invoke: () => { writeFileSync(join(root, 'openwiki', 'gotchas', 'two.md'), stalePage('two')); return { status: 0 }; },
    });
    assert.equal(result.outcome, 'failed', 'a front-matter-only change must not pass as a refresh');
    assert.deepEqual(result.results[0].stalePages, ['gotchas/two.md']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── the job deadline (item #613) ────────────────────────────────────────────────────────────────
//
// A generator that hangs (a model request accepted and never answered) used to run until the CI job
// timeout killed everything — no record, no digest, no cost line (runs 4290, 4385, 4386). The
// generator now runs under a deadline derived from the job's own, so a hang ends as a failed slice
// and the run still reports itself.

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
      root, bundleRoot: join(root, 'openwiki'),
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

test('deadline: a slice with too little time left is not started — its pages are not landed', () => {
  const root = twoAreaRepo();
  try {
    let calls = 0;
    const t = 1_000_000;
    const result = mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'),
      slices: [sl('invariants', ['one.md'])], attemptsPerSlice: 1,
      clock: () => t, deadlineMs: t + mod.DEADLINE_RESERVE_MS + mod.MIN_GENERATOR_MS - 1,
      invoke: () => { calls += 1; return { status: 0 }; },
    });
    assert.equal(calls, 0, 'never started a generator that could not finish');
    assert.equal(result.stoppedAtDeadline, true);
    assert.equal(result.exitCode, 1, 'a named page that was never attempted did not land');
    assert.deepEqual(result.notLanded, ['invariants/one.md']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── a deadline stop must not let an UNREQUESTED page sink the requested ones ───────────────────
//
// Measured 2026-10-04, run 4606: projects/sast.md was requested; openwiki also rewrote three pages it
// had not been asked about. The job deadline stopped the generator part-way through one of those,
// whose half-written bytes failed conformance for the whole invocation, so nothing was proposed
// although sast.md itself had landed. After a deadline stop, what the slice did not ask for is
// restored before verification; after a normal exit, the unrequested PAGES are (feature 098).

/** A committed page in the gotchas area the slices below do NOT request. */
function unrequestedPageRepo() {
  const root = twoAreaRepo();
  writeFileSync(join(root, 'openwiki', 'gotchas', 'forced.md'), '---\ntype: Convention\ntitle: forced\ndescription: Other.\n---\nOriginal.\n');
  writeFileSync(join(root, 'openwiki', 'gotchas', 'index.md'), '# Gotchas\n- [forced](forced.md)\n');
  spawnSync('git', ['add', '-A'], { cwd: root });
  spawnSync('git', ['commit', '-qm', 'other page'], { cwd: root });
  return root;
}

test('revertUnrequested (deadline stop) restores every unrequested write and keeps the requested page and its index', () => {
  const root = unrequestedPageRepo();
  try {
    const before = mod.snapshotTree(root);
    writingStub(root, 'invariants', ['one.md'])(); // requested page + its index
    writeFileSync(join(root, 'openwiki', 'gotchas', 'forced.md'), 'half-written');   // unrequested, tracked
    writeFileSync(join(root, 'openwiki', 'gotchas', 'index.md'), '# changed\n');     // another area's index
    writeFileSync(join(root, 'openwiki', 'gotchas', 'brand-new.md'), 'x');           // unrequested, new
    const reverted = mod.revertUnrequested({ root, bundleRoot: join(root, 'openwiki'), slice: sl('invariants', ['one.md']), before });
    assert.match(readFileSync(join(root, 'openwiki', 'gotchas', 'forced.md'), 'utf8'), /Original\./, 'tracked page restored');
    assert.ok(!existsSync(join(root, 'openwiki', 'gotchas', 'brand-new.md')), 'new unrequested file removed');
    assert.match(readFileSync(join(root, 'openwiki', 'gotchas', 'index.md'), 'utf8'), /forced\.md/, 'another area\'s index restored');
    assert.ok(existsSync(join(root, 'openwiki', 'invariants', 'one.md')), 'requested page kept');
    assert.match(readFileSync(join(root, 'openwiki', 'invariants', 'index.md'), 'utf8'), /one\.md/, 'its index kept');
    assert.ok(reverted.includes('openwiki/gotchas/forced.md') && reverted.includes('openwiki/gotchas/brand-new.md'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('revertUnrequested (normal exit) puts back only unrequested PAGES the generator may write, never a forbidden write', () => {
  const root = repoWithPolicy('conformant-bundle');
  try {
    const before = mod.snapshotTree(root);
    writingStub(root, 'invariants', ['one.md'])();
    writeFileSync(join(root, 'openwiki', 'invariants', 'unasked.md'), '---\ntype: Convention\ntitle: x\n---\nWritten unasked.\n');
    // invariants/auth-chain.md is AUTHORITATIVE in the real policy (event-driven, actor agent): the
    // generator may not write it at all, so its write must survive to fail the invocation.
    writeFileSync(join(root, 'openwiki', 'invariants', 'auth-chain.md'), '---\ntype: Convention\ntitle: x\n---\nRewritten unasked.\n');
    writeFileSync(join(root, 'docs', 'runbooks', 'local-dev.md'), '# out of scope\n');
    const reverted = mod.revertUnrequested({ root, bundleRoot: join(root, 'openwiki'), slice: sl('invariants', ['one.md']), before, scope: 'unrequested-pages', policy: realPolicy() });
    assert.deepEqual(reverted, ['openwiki/invariants/unasked.md']);
    assert.match(readFileSync(join(root, 'openwiki', 'invariants', 'auth-chain.md'), 'utf8'), /Rewritten unasked/, 'a forbidden bundle write is left for the verifier');
    assert.match(readFileSync(join(root, 'docs', 'runbooks', 'local-dev.md'), 'utf8'), /out of scope/, 'and so is one outside the bundle');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 078 US4 / FR-010: every run records what it cost ────────────────────────────

const PRICES_FIXTURE = { asOf: '2026-09-27', providers: { fireworks: { standard: { uncached: 0.22, cached: 0.007, cacheWrite: 0, output: 0.66 } } } };
const USAGE_CTX = { provider: 'fireworks', model: 'm', tier: null, prices: PRICES_FIXTURE };

test('usage: each invocation gets its own log, and the run carries the priced total', () => {
  const root = twoAreaRepo();
  try {
    const logs = [];
    const result = mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'), usage: USAGE_CTX,
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
    assert.equal(result.usage.priceTable, '2026-09-27');
    assert.ok(!existsSync(logs[0]), 'the per-invocation log is temporary');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('usage: a generator that reported nothing is recorded as NOT CAPTURED, never as $0', () => {
  const root = twoAreaRepo();
  try {
    const result = mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'), usage: USAGE_CTX,
      slices: [sl('invariants', ['one.md'])],
      invoke: () => { writingStub(root, 'invariants', ['one.md'])(); return { status: 0 }; },
    });
    assert.equal(result.results[0].usage, 'not captured');
    assert.equal(result.usage, 'not captured');
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

/** The --pages options executeRun takes. */
const PAGES_OPTS = (pages) => ({ mode: 'pages', pages, json: false, dryRun: false, propose: false });

/** rebuildRepo plus the real policy, with the branch named main. */
function rebuildRepoOnMain(opts) {
  const root = rebuildRepo(opts);
  spawnSync('git', ['branch', '-M', 'main'], { cwd: root });
  return root;
}

test('preflight: runs once, before the first slice, when there is work', async () => {
  const root = rebuildRepoOnMain({ stale: ['runbooks/a.md', 'projects/c.md'] });
  try {
    const order = [];
    await mod.executeRun({
      root, opts: PAGES_OPTS('runbooks/a.md,projects/c.md'), attemptsPerSlice: 1,
      preflight: () => { order.push('preflight'); return { ok: true, detail: 'stub' }; },
      invoke: (work) => { order.push('invoke'); return rewriting(root)(work); },
    });
    assert.equal(order[0], 'preflight', 'the check comes before any paid slice');
    assert.equal(order.filter((x) => x === 'preflight').length, 1, 'once per run, not per slice');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('preflight: the CLI --pages path runs the SAME gate, before the proposal branch and any slice', () => {
  // main delegates to executeRun (so a test can drive the whole sequence), and executeRun gates
  // before anything else.
  const source = readFileSync(SCRIPT, 'utf8');
  const cli = source.slice(source.indexOf('async function main('));
  assert.ok(cli.indexOf('executeRun(') > 0, 'the CLI --pages path must delegate to executeRun');
  assert.equal(cli.indexOf('executeSlices('), -1, 'and must not drive executeSlices around it');
  const start = source.indexOf('export async function executeRun(');
  const exec = source.slice(start, source.indexOf('\n}\n', start));
  const gate = exec.indexOf('preflightGate(');
  assert.ok(gate > 0, 'the --pages path must call preflightGate');
  assert.ok(gate < exec.indexOf('prepareProposalBranch('), 'before the proposal branch is touched');
  assert.ok(gate < exec.indexOf('executeSlices('), 'and before any slice');
});

test('preflight: executeRun stops at a failed preflight — exit 2, no generator, no proposal branch', async () => {
  const root = rebuildRepoOnMain({ stale: ['runbooks/a.md'] });
  try {
    let invoked = 0;
    const exit = await mod.executeRun({
      root, opts: { ...PAGES_OPTS('runbooks/a.md'), propose: true }, forge: stubForge(),
      invoke: () => { invoked++; return { status: 0 }; },
      preflight: () => ({ ok: false, detail: 'HTTP 401 (authentication_error)' }),
    });
    assert.equal(exit, 2);
    assert.equal(invoked, 0, 'no paid slice');
    assert.notEqual(spawnSync('git', ['rev-parse', '--verify', '--quiet', mod.PROPOSAL_BRANCH], { cwd: root }).status, 0, 'the proposal branch was not touched');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('executeRun refuses a bad page list with exit 2 before the preflight', async () => {
  const root = rebuildRepoOnMain();
  try {
    let preflights = 0;
    const exit = await mod.executeRun({ root, opts: PAGES_OPTS('invariants/canon.md'), preflight: () => { preflights++; return { ok: true }; }, invoke: () => ({ status: 0 }) });
    assert.equal(exit, 2);
    assert.equal(preflights, 0, 'a refused list costs nothing, not even a preflight');
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
    root, forge, baseBranch: 'main', body, git: g, returnTo: 'main',
    slices: [{ area: 'invariants', pages: [page], areaExists: true, reason: 'source changed' }],
  });
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

test('execute (#683): a stray 429 the SDK absorbed inside a working attempt is NOT a rate limit', () => {
  const root = tmpGitRepo('conformant-bundle');
  try {
    let t = 0;
    const slept = [];
    let call = 0;
    const { value: result, lines } = capturingErrors(() => mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'),
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
      root: dir, forge, baseBranch: 'main', body: page, git: g,
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
});

test('local parity: CI and local drive the identical entry point', () => {
  // FR-020. If the workflow had its own orchestration, the local path would stop being a rehearsal of
  // the CI one and the two would drift — which is how "works locally" starts meaning nothing.
  const workflow = readFileSync(join(REPO_ROOT, '.forgejo', 'workflows', 'wiki-maintain.yml'), 'utf8');
  assert.match(workflow, /node scripts\/wiki-maintain\.mjs --pages "\$INPUT_PAGES" --propose/);
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
  assert.equal(project.targets['wiki-plan'], undefined, 'the free planner went with range planning (feature 098)');
  assert.equal(project.targets['wiki-maintain'].options.command, 'node scripts/wiki-maintain.mjs');
  assert.ok(project.targets['wiki-maintain'].metadata?.description?.length > 80,
    'wiki-maintain needs a description saying why the target must be used rather than a bare call');
  assert.match(project.targets['wiki-maintain'].metadata.description, /--pages/);
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
    assert.deepEqual(result.notLanded, ['invariants/impossible.md'], 'only the bad slice is not landed');
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
      attemptsPerSlice: 1, // isolate the consecutive-failure rule from the retry rule
      invoke: (slice) => { attempted.push(slice.pages[0]); return { status: 0 }; }, // everything fails
    });
    assert.deepEqual(attempted, ['a.md', 'b.md'], 'the third slice is not attempted — paid capacity is not spent on the same fault');
    assert.equal(result.stoppedAtFailureLimit, true);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.notLanded, ['invariants/a.md', 'invariants/b.md', 'invariants/c.md'], 'and every unattempted page is named, not lost');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
      invoke: (slice) => (++attempt === 1 ? { status: 0 } : writingStub(root, 'invariants', slice.pages)()),
    });
    assert.equal(result.outcome, 'completed');
    assert.equal(result.results[0].attempts, 2, 'the retry is reported, not hidden');
    assert.equal(result.pagesWritten, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── FR-016: one open proposal, and the forge is its only record ─────────────────

test('proposal: an open proposal is found on the FORGE — a second run never opens another', () => {
  // This happened on `main`: a run created the proposal, its marker commit failed to push
  // (non-fast-forward against a branch that moved during the debounce sleep), and the pointer never
  // landed. The next run therefore tried to open a SECOND proposal for the same branch and died on
  // `forge POST /pulls → 409`. The invariant survived only because the forge refused.
  //
  // The run record was only ever a cache of that fact, and feature 098 retired it: the forge is the
  // only record now.
  const { root } = repoAtHead();
  try {
    const g = gitIn(root);
    g('branch', '-M', 'main');
    const forge = stubForge();

    const first = runOnce(root, g, forge, 'first.md', 'run one');
    assert.equal(forge.state.pulls.length, 1);

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

// ── #682: the per-call usage log survives the run, in the bundle ──────────────────────────────────

test('usage (#682): in CI, each invocation\'s per-call tap lines are kept as a step log the digest bundles', async () => {
  const root = tmpGitRepo('conformant-bundle');
  const logRoot = mkdtempSync(join(tmpdir(), 'step-logs-'));
  try {
    const env = { GITHUB_RUN_ID: '4960', GITHUB_JOB: 'maintain', CI_STEP_LOG_ROOT: logRoot, HOME: logRoot };
    mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'),
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
      root, bundleRoot: join(root, 'openwiki'),
      slices: [sl('invariants', ['one.md'])], attemptsPerSlice: 1, archiveEnv: { CI_STEP_LOG_ROOT: logRoot },
      invoke: (slice, { usageLog }) => { writeFileSync(usageLog, '{"status":200}\n'); return writingStub(root, 'invariants', ['one.md'])(); },
    });
    assert.deepEqual(readdirSync(logRoot), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(logRoot, { recursive: true, force: true });
  }
});

// ── #516: an invocation whose telemetry record shows an event was sent stops the rebuild ──────────

const SENT = '{"disabled":false,"sent":true}';
const HELD = '{"disabled":true,"sent":false}';

test('execute (#516): every invocation gets its own telemetry path, and a held opt-out changes nothing', () => {
  const root = tmpGitRepo('conformant-bundle');
  try {
    const paths = [];
    const result = mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'),
      slices: [sl('invariants', ['one.md'])],
      invoke: (slice, ctx) => { paths.push(ctx.telemetryFile); writeFileSync(ctx.telemetryFile, HELD); return writingStub(root, 'invariants', ['one.md'])(); },
    });
    assert.equal(paths.length, 1);
    assert.match(paths[0], /telemetry\.json$/);
    assert.equal(result.outcome, 'completed');
    assert.equal(result.exitCode, 0);
    assert.equal(result.telemetrySent, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('execute (#516): a SENT record fails the run even when the page landed, and says why', () => {
  const root = tmpGitRepo('conformant-bundle');
  try {
    const { value: result, lines } = capturingErrors(() => mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'),
      slices: [sl('invariants', ['one.md'])],
      invoke: (slice, ctx) => { writeFileSync(ctx.telemetryFile, SENT); return writingStub(root, 'invariants', ['one.md'])(); },
    }));
    assert.equal(result.exitCode, 1);
    assert.equal(result.outcome, 'failed');
    assert.match(result.telemetrySent, /disabled=false sent=true/);
    assert.ok(lines.some((l) => /TELEMETRY: .*#516/.test(l)), lines.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('execute (#516): a SENT record is never retried — each retry would send another event', () => {
  const root = tmpGitRepo('conformant-bundle');
  try {
    let calls = 0;
    const { value: result } = capturingErrors(() => mod.executeSlices({
      root, bundleRoot: join(root, 'openwiki'),
      slices: [sl('invariants', ['one.md'])],
      attemptsPerSlice: 3,
      invoke: (slice, ctx) => { calls++; writeFileSync(ctx.telemetryFile, SENT); return { status: 0 }; },
    }));
    assert.equal(calls, 1);
    assert.equal(result.exitCode, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('execute (#516): the env handed to the launcher names the telemetry path', () => {
  const env = mod.generatorEnv('one safe line', {}, { telemetryFile: '/tmp/x/telemetry.json' });
  assert.equal(env.WIKI_TELEMETRY_FILE, '/tmp/x/telemetry.json');
  assert.equal(mod.generatorEnv('one safe line', {}).WIKI_TELEMETRY_FILE, undefined);
});
