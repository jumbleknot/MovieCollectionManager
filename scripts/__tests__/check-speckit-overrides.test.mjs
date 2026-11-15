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
import { fileURLToPath } from 'node:url';
import {
  LOCAL_EDITS,
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
const TDD_TEMPLATE = 'docs/templates/feature-test-tasks-template.md';
const INVENTORY = 'docs/runbooks/spec-kit.md';
// The sweep task plus the TDD checkpoint pair (constitution "TDD Checkpoint Format"); every
// fixture override carries both unless a test removes one.
const SWEEP_TASK = [
  '- [ ] T002 **Doc-impact sweep** — list the identifiers this feature changes',
  `- [ ] T010 [US1] Test for [behaviour] (format: ${TDD_TEMPLATE})`,
  '  - **Verify RED**: `<command>` → 1 failing',
  '- [ ] T011 [US1] Implement [behaviour]',
  '  - **Verify GREEN**: `<command>` → 1 passed',
  '',
].join('\n');
const SKILL = '.claude/skills/speckit-taskstoissues/SKILL.md';
const MANIFEST = '.specify/integrations/claude.manifest.json';
const UPSTREAM_SKILL = '# taskstoissues\n\nUse the GitHub MCP server to create issues.\n';
const LOCAL_SKILL = '# taskstoissues\n\nnode scripts/backlog.mjs create --title "T001: x"\n';
const REGISTRY = [{ file: SKILL, marker: 'scripts/backlog.mjs', why: 'Forgejo backlog (feature 049)' }];
const inventoryFor = (files) => `# Spec Kit\n\n${files.map((f) => `- \`${f}\``).join('\n')}\n`;
// Names every file either registry might hold: tests that pass no registry use the real LOCAL_EDITS.
const INVENTORY_OK = inventoryFor([
  '.specify/templates/overrides/tasks-template.md',
  TDD_TEMPLATE,
  ...new Set([SKILL, ...LOCAL_EDITS.map((e) => e.file)]),
]);
// The shape Spec Kit 0.16.x ships: an input-validation `return $null` BEFORE the override check
// (harmless — it resolves nothing), and a second resolver, Resolve-TemplateContent, whose output is
// what /speckit-tasks actually reads (TASKS_TEMPLATE_CONTENT).
const resolver = (name, ret) => [
  `function ${name} {`,
  '    param([string]$TemplateName, [string]$RepoRoot)',
  "    if ($TemplateName -cnotmatch '^[a-z0-9-]+$') { return $null }",
  '    $base = Join-Path $RepoRoot \'.specify/templates\'',
  '    $override = Join-Path $base "overrides/$TemplateName.md"',
  `    if (Test-Path $override) { return ${ret('$override')} }`,
  '    $presetsDir = Join-Path $RepoRoot \'.specify/presets\'',
  '    $extDir = Join-Path $RepoRoot \'.specify/extensions\'',
  '    $core = Join-Path $base "$TemplateName.md"',
  `    if (Test-Path $core) { return ${ret('$core')} }`,
  '}',
  '',
];
const COMMON_OK = [
  ...resolver('Resolve-Template', (p) => p),
  ...resolver('Resolve-TemplateContent', (p) => `[System.IO.File]::ReadAllText(${p})`),
].join('\n');
const SETUP_OK = [
  "$tasksTemplate = Resolve-Template -TemplateName 'tasks-template' -RepoRoot $paths.REPO_ROOT",
  "$tasksTemplateContent = Resolve-TemplateContent -TemplateName 'tasks-template' -RepoRoot $paths.REPO_ROOT",
  '',
].join('\n');

const sha = (s) => createHash('sha256').update(s).digest('hex');
const header = (hash) => `<!-- forked-from: ${CORE} sha256=${hash} spec-kit=0.11.2 -->\n`;

function fixture({
  core = CORE_BODY,
  override,
  common = COMMON_OK,
  setup = SETUP_OK,
  inventory = INVENTORY_OK,
  manifest = null, // { [path]: hash } — written as a Spec Kit integration manifest when given
  files = {}, // extra files, e.g. the skill a manifest lists
  git = false,
} = {}) {
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
  put(INVENTORY, inventory);
  if (manifest) put(MANIFEST, JSON.stringify({ integration: 'claude', version: '0.16.5', files: manifest }));
  for (const [rel, body] of Object.entries(files)) put(rel, body);
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
  const override = header(sha(CORE_BODY)) + CORE_BODY +
    SWEEP_TASK.replace(/^.*\*\*Doc-impact sweep\*\*.*$/m, 'The **Doc-impact sweep** is described elsewhere.');
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

test('a resolver that RETURNS A PATH before checking overrides/ fails resolution-broken', () => {
  const common = COMMON_OK.replace(
    "{ return $null }",
    "{ return (Join-Path $RepoRoot '.specify/templates/tasks-template.md') }",
  );
  assert.deepEqual(codes(checkSpeckitOverrides({ root: fixture({ common }) })), ['resolution-broken']);
});

test('setup-tasks.ps1 that no longer resolves the CONTENT through Resolve-TemplateContent fails resolution-broken', () => {
  const setup = SETUP_OK.replace(/^\$tasksTemplateContent = .*$/m, "$tasksTemplateContent = Get-Content '.specify/templates/tasks-template.md' -Raw");
  assert.deepEqual(codes(checkSpeckitOverrides({ root: fixture({ setup }) })), ['resolution-broken']);
});

test('Resolve-TemplateContent that checks presets before overrides/ fails resolution-broken', () => {
  const [path, content] = COMMON_OK.split(/(?=^function Resolve-TemplateContent)/m);
  const swapped = content.replace(/^.*overrides\/.*\n.*Test-Path \$override.*\n/m, '').replace(
    /^\}$/m,
    '    $override = Join-Path $base "overrides/$TemplateName.md"\n    if (Test-Path $override) { return $override }\n}\n',
  );
  assert.deepEqual(codes(checkSpeckitOverrides({ root: fixture({ common: path + swapped }) })), ['resolution-broken']);
});

test('a common.ps1 without Resolve-TemplateContent fails resolution-broken', () => {
  const common = COMMON_OK.split(/(?=^function Resolve-TemplateContent)/m)[0];
  assert.deepEqual(codes(checkSpeckitOverrides({ root: fixture({ common }) })), ['resolution-broken']);
});

test('CLI entry point runs when invoked as a script, on every platform', () => {
  // The old guard compared import.meta.url to `file://${argv[1]}`, which never matches a Windows
  // path (file:///E:/… vs E:\…): the gate exited 0 having checked nothing.
  const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'check-speckit-overrides.mjs');
  const out = execFileSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.match(out, /^usage: node scripts\/check-speckit-overrides\.mjs/);
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

// ── Gap 2: the TDD checkpoint format lives in the override, not only in the constitution ──────────

test('an override without a Verify RED / Verify GREEN sample fails tdd-format-missing', () => {
  const noTdd = header(sha(CORE_BODY)) + CORE_BODY + '- [ ] T002 **Doc-impact sweep** — x\n';
  assert.deepEqual(codes(checkSpeckitOverrides({ root: fixture({ override: noTdd }) })), ['tdd-format-missing']);
});

test('an override that drops only Verify GREEN, or only the template pointer, fails tdd-format-missing', () => {
  for (const cut of ['  - **Verify GREEN**: `<command>` → 1 passed\n', ` (format: ${TDD_TEMPLATE})`]) {
    const override = header(sha(CORE_BODY)) + CORE_BODY + SWEEP_TASK.replace(cut, '');
    assert.deepEqual(codes(checkSpeckitOverrides({ root: fixture({ override }) })), ['tdd-format-missing'], cut);
  }
});

test('recordForkPoint refuses to record a fork that lost the TDD checkpoint sample', () => {
  const root = fixture({ override: header(sha(CORE_BODY)) + CORE_BODY + '- [ ] T002 **Doc-impact sweep** — x\n' });
  assert.throws(() => recordForkPoint({ root }), /Verify RED/);
});

// ── Gap 3: deliberate edits to Spec Kit-managed files are registered and guarded ──────────────────

test('a registered local edit that is in place passes', () => {
  const root = fixture({ manifest: { [SKILL]: sha(UPSTREAM_SKILL) }, files: { [SKILL]: LOCAL_SKILL } });
  assert.deepEqual(checkSpeckitOverrides({ root, localEdits: REGISTRY }), { ok: true, failures: [] });
});

test('an upgrade that restores the upstream file over a registered edit fails local-edit-reverted', () => {
  const root = fixture({ manifest: { [SKILL]: sha(UPSTREAM_SKILL) }, files: { [SKILL]: UPSTREAM_SKILL } });
  const r = checkSpeckitOverrides({ root, localEdits: REGISTRY });
  assert.deepEqual(codes(r), ['local-edit-reverted']);
  assert.match(r.failures[0].message, /speckit-taskstoissues/);
});

test('the CRLF form of the upstream file still counts as reverted (a Windows checkout)', () => {
  const crlf = UPSTREAM_SKILL.replace(/\n/g, '\r\n');
  const root = fixture({ manifest: { [SKILL]: sha(UPSTREAM_SKILL) }, files: { [SKILL]: crlf } });
  assert.deepEqual(codes(checkSpeckitOverrides({ root, localEdits: REGISTRY })), ['local-edit-reverted']);
});

test('a registered edit that differs from upstream but lost its marker fails local-edit-reverted', () => {
  const root = fixture({ manifest: { [SKILL]: sha(UPSTREAM_SKILL) }, files: { [SKILL]: '# rewritten, no backlog\n' } });
  assert.deepEqual(codes(checkSpeckitOverrides({ root, localEdits: REGISTRY })), ['local-edit-reverted']);
});

test('an edit to a managed file that is NOT registered fails unregistered-edit', () => {
  const other = '.claude/skills/speckit-plan/SKILL.md';
  const root = fixture({
    manifest: { [SKILL]: sha(UPSTREAM_SKILL), [other]: sha('upstream plan\n') },
    files: { [SKILL]: LOCAL_SKILL, [other]: 'locally edited plan\n' },
  });
  const r = checkSpeckitOverrides({ root, localEdits: REGISTRY });
  assert.deepEqual(codes(r), ['unregistered-edit']);
  assert.match(r.failures[0].message, /speckit-plan/);
});

test('a CRLF-only difference from the manifest is not an edit', () => {
  const other = '.claude/skills/speckit-plan/SKILL.md';
  const root = fixture({
    manifest: { [SKILL]: sha(UPSTREAM_SKILL), [other]: sha('upstream plan\n') },
    files: { [SKILL]: LOCAL_SKILL, [other]: 'upstream plan\r\n' },
  });
  assert.deepEqual(checkSpeckitOverrides({ root, localEdits: REGISTRY }), { ok: true, failures: [] });
});

test('a registered file that no manifest lists any more fails registry-stale', () => {
  const root = fixture({ manifest: { '.claude/skills/speckit-plan/SKILL.md': sha('p\n') }, files: { '.claude/skills/speckit-plan/SKILL.md': 'p\n' } });
  assert.deepEqual(codes(checkSpeckitOverrides({ root, localEdits: REGISTRY })), ['registry-stale']);
});

// ── Gap 1: one inventory names every customisation, and the gate keeps it honest ──────────────────

test('an inventory runbook that omits a guarded customisation fails inventory-stale, naming it', () => {
  const root = fixture({
    inventory: inventoryFor(['.specify/templates/overrides/tasks-template.md', TDD_TEMPLATE]),
    manifest: { [SKILL]: sha(UPSTREAM_SKILL) },
    files: { [SKILL]: LOCAL_SKILL },
  });
  const r = checkSpeckitOverrides({ root, localEdits: REGISTRY });
  assert.deepEqual(codes(r), ['inventory-stale']);
  assert.match(r.failures[0].message, /speckit-taskstoissues/);
});

test('a missing inventory runbook fails inventory-stale', () => {
  assert.deepEqual(codes(checkSpeckitOverrides({ root: fixture({ inventory: null }) })), ['inventory-stale']);
});

test('the real tree: every managed-file edit is registered and every customisation is inventoried', () => {
  const r = checkSpeckitOverrides();
  const relevant = ['unregistered-edit', 'local-edit-reverted', 'registry-stale', 'inventory-stale', 'tdd-format-missing'];
  assert.deepEqual(codes(r).filter((c) => relevant.includes(c)), [], JSON.stringify(r.failures));
});

test('CLI: --selftest passes', () => {
  assert.equal(quiet(() => main(['--selftest'])).rc, 0);
});

test('CLI: --record and --selftest together exit 2', () => {
  assert.equal(quiet(() => main(['--record', '--selftest'], { root: fixture() })).rc, 2);
});
