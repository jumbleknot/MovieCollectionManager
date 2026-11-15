// Feature 101 (item #1021) — the Spec Kit tasks-template override gate.
// Each test builds a throwaway fixture tree and asserts on the failure CODE, so a message rewording
// never breaks a test but a lost detection always does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  checkSpeckitOverrides,
  main,
  parseForkPoint,
  recordForkPoint,
} from '../check-speckit-overrides.mjs';

const CORE = '.specify/templates/tasks-template.md';
const OVERRIDE = '.specify/templates/overrides/tasks-template.md';
const COMMON = '.specify/scripts/powershell/common.ps1';
const SETUP = '.specify/scripts/powershell/setup-tasks.ps1';

const CORE_BODY = '# Tasks: [FEATURE NAME]\n\n## Phase 1: Setup\n\n- [ ] T001 Create project structure\n';
const SWEEP_TASK = '- [ ] T002 **Doc-impact sweep** — list the identifiers this feature changes\n';
const COMMON_OK = [
  'function Resolve-Template {',
  '    param([string]$TemplateName, [string]$RepoRoot)',
  '    $base = Join-Path $RepoRoot \'.specify/templates\'',
  '    $override = Join-Path $base "overrides/$TemplateName.md"',
  '    if (Test-Path $override) { return $override }',
  '    $presetsDir = Join-Path $RepoRoot \'.specify/presets\'',
  '    $extDir = Join-Path $RepoRoot \'.specify/extensions\'',
  '    $core = Join-Path $base "$TemplateName.md"',
  '    if (Test-Path $core) { return $core }',
  '}',
  '',
].join('\n');
const SETUP_OK = "$tasksTemplate = Resolve-Template -TemplateName 'tasks-template' -RepoRoot $paths.REPO_ROOT\n";

const sha = (s) => createHash('sha256').update(s).digest('hex');
const header = (hash) => `<!-- forked-from: ${CORE} sha256=${hash} spec-kit=0.11.2 -->\n`;

function fixture({ core = CORE_BODY, override, common = COMMON_OK, setup = SETUP_OK, git = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'speckit-overrides-'));
  const put = (rel, body) => {
    if (body === null) return;
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  put(CORE, core);
  put(OVERRIDE, override === undefined ? header(sha(core)) + core + SWEEP_TASK : override);
  put(COMMON, common);
  put(SETUP, setup);
  put('.specify/init-options.json', JSON.stringify({ speckit_version: '0.11.2' }));
  if (git) {
    const g = (...a) => execFileSync('git', a, { cwd: root, stdio: 'pipe' });
    g('init', '-q');
    g('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A');
    g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fork base');
  }
  return root;
}
const codes = (r) => r.failures.map((f) => f.code).sort();
// main() reports an argv error through dieOnArgvError({ hard: false }), which sets process.exitCode
// for the CLI; inside the test runner that would fail the whole file, so it is restored here.
const quiet = (fn) => {
  const { log, error } = console;
  const exitCode = process.exitCode;
  const out = [];
  console.log = console.error = (...a) => out.push(a.join(' '));
  try {
    return { rc: fn(), out: out.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
    process.exitCode = exitCode;
  }
};

test('parseForkPoint reads a well-formed header', () => {
  const h = 'a'.repeat(64);
  assert.deepEqual(parseForkPoint(`<!-- forked-from: ${CORE} sha256=${h} spec-kit=0.11.2 -->`), {
    corePath: CORE,
    sha256: h,
    specKit: '0.11.2',
  });
});

test('parseForkPoint rejects a wrong core path, a short hash and a non-comment', () => {
  const h = 'a'.repeat(64);
  assert.equal(parseForkPoint(`<!-- forked-from: other.md sha256=${h} spec-kit=0.11.2 -->`), null);
  assert.equal(parseForkPoint(`<!-- forked-from: ${CORE} sha256=abc spec-kit=0.11.2 -->`), null);
  assert.equal(parseForkPoint(`forked-from: ${CORE} sha256=${h} spec-kit=0.11.2`), null);
  assert.equal(parseForkPoint('# Tasks'), null);
});

test('a clean tree passes', () => {
  const r = checkSpeckitOverrides({ root: fixture() });
  assert.deepEqual(r, { ok: true, failures: [] });
});

test('a missing override fails override-missing', () => {
  assert.deepEqual(codes(checkSpeckitOverrides({ root: fixture({ override: null }) })), ['override-missing']);
});

test('an override whose first line is not a fork point fails header-invalid', () => {
  const r = checkSpeckitOverrides({ root: fixture({ override: CORE_BODY + SWEEP_TASK }) });
  assert.deepEqual(codes(r), ['header-invalid']);
});

test('an override without the sweep TASK fails sweep-missing, even if the words appear in prose', () => {
  const override = header(sha(CORE_BODY)) + CORE_BODY + 'The **Doc-impact sweep** is described elsewhere.\n';
  assert.deepEqual(codes(checkSpeckitOverrides({ root: fixture({ override }) })), ['sweep-missing']);
});

test('a changed core template fails core-changed, names both files, and says history is unavailable outside git', () => {
  const root = fixture();
  writeFileSync(join(root, CORE), CORE_BODY + '- [ ] T009 upstream improvement\n');
  const r = checkSpeckitOverrides({ root });
  assert.deepEqual(codes(r), ['core-changed']);
  const msg = r.failures[0].message;
  assert.match(msg, /\.specify\/templates\/tasks-template\.md/);
  assert.match(msg, /\.specify\/templates\/overrides\/tasks-template\.md/);
  assert.match(msg, /history unavailable/);
});

test('in a git repo, core-changed prints the upstream diff since the fork base', () => {
  const root = fixture({ git: true });
  writeFileSync(join(root, CORE), CORE_BODY + '- [ ] T009 upstream improvement\n');
  const r = checkSpeckitOverrides({ root });
  assert.deepEqual(codes(r), ['core-changed']);
  assert.match(r.failures[0].message, /^\+- \[ \] T009 upstream improvement$/m);
});

test('setup-tasks.ps1 that no longer resolves through Resolve-Template fails resolution-broken', () => {
  const setup = "$tasksTemplate = Join-Path $root '.specify/templates/tasks-template.md'\n";
  assert.deepEqual(codes(checkSpeckitOverrides({ root: fixture({ setup }) })), ['resolution-broken']);
});

test('Resolve-Template that checks presets before overrides/ fails resolution-broken', () => {
  const common = COMMON_OK.replace(
    '    $override = Join-Path $base "overrides/$TemplateName.md"\n    if (Test-Path $override) { return $override }\n',
    '',
  ).replace(
    "    $extDir",
    '    $override = Join-Path $base "overrides/$TemplateName.md"\n    if (Test-Path $override) { return $override }\n    $extDir',
  );
  assert.deepEqual(codes(checkSpeckitOverrides({ root: fixture({ common }) })), ['resolution-broken']);
});

test('a common.ps1 without Resolve-Template fails resolution-broken', () => {
  assert.deepEqual(codes(checkSpeckitOverrides({ root: fixture({ common: '# nothing here\n' }) })), ['resolution-broken']);
});

test('every fault is reported, not just the first', () => {
  const root = fixture({ setup: '# gone\n' });
  writeFileSync(join(root, CORE), 'changed\n');
  assert.deepEqual(codes(checkSpeckitOverrides({ root })), ['core-changed', 'resolution-broken']);
});

test('the real tree resolves tasks-template override-first', () => {
  const r = checkSpeckitOverrides();
  assert.ok(!codes(r).includes('resolution-broken'), JSON.stringify(r.failures));
});

test('recordForkPoint rewrites the fork point from the core, after which the scan is clean', () => {
  const root = fixture();
  writeFileSync(join(root, CORE), CORE_BODY + 'upstream\n');
  const { previous, current } = recordForkPoint({ root });
  assert.equal(previous, sha(CORE_BODY));
  assert.equal(current, sha(CORE_BODY + 'upstream\n'));
  assert.equal(readFileSync(join(root, OVERRIDE), 'utf8').split('\n')[0] + '\n', header(current));
  assert.deepEqual(checkSpeckitOverrides({ root }), { ok: true, failures: [] });
});

test('recordForkPoint also repairs a placeholder header, keeping the body', () => {
  const root = fixture({ override: `<!-- forked-from: ${CORE} sha256=0 spec-kit=0.11.2 -->\n` + CORE_BODY + SWEEP_TASK });
  recordForkPoint({ root });
  const text = readFileSync(join(root, OVERRIDE), 'utf8');
  assert.equal(text, header(sha(CORE_BODY)) + CORE_BODY + SWEEP_TASK);
});

test('recordForkPoint refuses to record a fork that lost the sweep task', () => {
  const root = fixture({ override: header(sha(CORE_BODY)) + CORE_BODY });
  assert.throws(() => recordForkPoint({ root }), /Doc-impact sweep/);
});

test('CLI: a typo exits 2 and writes nothing', () => {
  const root = fixture();
  writeFileSync(join(root, CORE), 'changed\n');
  const before = readFileSync(join(root, OVERRIDE), 'utf8');
  assert.equal(quiet(() => main(['--recrod'], { root })).rc, 2);
  assert.equal(readFileSync(join(root, OVERRIDE), 'utf8'), before);
});

test('CLI: --help exits 0 and writes nothing, even beside --record', () => {
  const root = fixture();
  writeFileSync(join(root, CORE), 'changed\n');
  const before = readFileSync(join(root, OVERRIDE), 'utf8');
  assert.equal(quiet(() => main(['--record', '--help'], { root })).rc, 0);
  assert.equal(readFileSync(join(root, OVERRIDE), 'utf8'), before);
});

test('CLI: scan exits 1 on drift and 0 after --record', () => {
  const root = fixture();
  writeFileSync(join(root, CORE), 'changed\n');
  const red = quiet(() => main([], { root }));
  assert.equal(red.rc, 1);
  assert.match(red.out, /core-changed/);
  assert.match(red.out, /--record/);
  assert.equal(quiet(() => main(['--record'], { root })).rc, 0);
  assert.equal(quiet(() => main([], { root })).rc, 0);
  rmSync(root, { recursive: true, force: true });
});

test('CLI: --record and --selftest together exit 2', () => {
  assert.equal(quiet(() => main(['--record', '--selftest'], { root: fixture() })).rc, 2);
});
