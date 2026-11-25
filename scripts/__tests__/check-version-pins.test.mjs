// Feature 107 (item #1128) — the version-pin guard. Pure-function tests over in-memory trees, plus the
// repository-state tests that hold the committed tree to the guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILTIN_ACTION_INPUTS,
  checkTree,
  classifyPins,
  detectPins,
  formatReport,
  loadExclusions,
  managedOccurrences,
} from '../check-version-pins.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'check-version-pins.mjs');
const REASON = 'held by the SDK wrapper and moves with an SDK upgrade only';
const NO_EXCLUSIONS = { valid: [], invalid: [] };

const regexManager = (filePattern, matchString, extra = {}) => ({
  customType: 'regex',
  managerFilePatterns: [filePattern],
  matchStrings: [matchString],
  datasourceTemplate: 'npm',
  ...extra,
});
const config = (...customManagers) => ({ customManagers });
const pinsIn = (path, text) => detectPins({ [path]: text });
const onlyPin = (path, text) => {
  const pins = pinsIn(path, text);
  assert.equal(pins.length, 1, `expected 1 pin, got ${pins.length}: ${JSON.stringify(pins)}`);
  return pins[0];
};
const shPin = { file: 'scripts/a.sh', line: 2, shape: 'assignment', name: 'FOO_VERSION', value: '1.2.3' };
const coverageOf = (file, line, manager) => new Map([[file, new Map([[line, manager]])]]);

// ── coverage: which manager extracts which line (research R1, R2) ──────────────────────────────

test('coverage: a matchString capturing currentValue covers that line only', () => {
  const tree = { 'scripts/a.sh': 'set -e\nFOO_VERSION=1.2.3\necho done\n' };
  const cov = managedOccurrences(tree, config(regexManager('/^scripts/a\\.sh$/', 'FOO_VERSION=(?<currentValue>[\\d.]+)', { depNameTemplate: 'foo' })));
  assert.equal(cov.get('scripts/a.sh')?.get(2), 'foo', 'expected line 2 covered by foo');
  assert.equal(cov.get('scripts/a.sh').size, 1);
});

test('coverage: a file pattern that matches with a matchString that captures nothing covers nothing', () => {
  const tree = { 'scripts/a.sh': 'FOO_VERSION=1.2.3\n' };
  const cov = managedOccurrences(tree, config(regexManager('/^scripts/a\\.sh$/', 'NOPE_VERSION=(?<currentValue>[\\d.]+)', { depNameTemplate: 'foo' })));
  assert.equal(cov.get('scripts/a.sh')?.size ?? 0, 0);
});

test('coverage: regex and glob managerFilePatterns both resolve against repository-relative paths', () => {
  const tree = { 'scripts/lib/b.sh': 'FOO_VERSION=1.2.3\n', 'other/b.sh': 'FOO_VERSION=1.2.3\n' };
  const cov = managedOccurrences(tree, config(
    regexManager('scripts/**/*.sh', 'FOO_VERSION=(?<currentValue>[\\d.]+)', { depNameTemplate: 'glob' }),
    regexManager('/^nowhere$/', 'FOO_VERSION=(?<currentValue>[\\d.]+)', { depNameTemplate: 'regex' }),
  ));
  assert.equal(cov.get('scripts/lib/b.sh')?.get(1), 'glob', 'expected line 1 covered by the glob manager');
  assert.equal(cov.get('other/b.sh')?.size ?? 0, 0);
});

test('coverage: a multi-line match is attributed to the line where currentValue starts', () => {
  const tree = { 'scripts/n.mjs': '{\n  "installation": {\n    "version": "22.7.7"\n  }\n}\n' };
  const cov = managedOccurrences(tree, config(regexManager('/^scripts/n\\.mjs$/', '"installation":\\s*\\{[\\s\\S]*?"version":\\s*"(?<currentValue>[^"]+)"', { depNameTemplate: 'nx' })));
  assert.equal(cov.get('scripts/n.mjs')?.get(3), 'nx', 'expected line 3 covered by nx');
});

test('coverage: an unsupported matchStringsStrategy throws, naming the manager', () => {
  const tree = { 'scripts/a.sh': 'FOO_VERSION=1.2.3\n' };
  assert.throws(
    () => managedOccurrences(tree, config(regexManager('/^scripts/a\\.sh$/', 'FOO_VERSION=(?<currentValue>[\\d.]+)', { depNameTemplate: 'foo', matchStringsStrategy: 'combination' }))),
    /combination.*foo|foo.*combination/,
  );
});

test('coverage: a captured depName names the manager when there is no depNameTemplate', () => {
  const tree = { 'x/Dockerfile': '# renovate: datasource=github-releases depName=docker/compose\nARG DOCKER_COMPOSE_VERSION=v5.3.1\n' };
  const cov = managedOccurrences(tree, config({
    customType: 'regex',
    managerFilePatterns: ['/Dockerfile$/'],
    matchStrings: ['# renovate: datasource=(?<datasource>\\S+) depName=(?<depName>\\S+)\\s+ARG \\w+=(?<currentValue>\\S+)'],
  }));
  assert.equal(cov.get('x/Dockerfile')?.get(2), 'docker/compose', 'expected line 2 covered by docker/compose');
});

test('coverage: the built-in action-input table is exactly the four Renovate known actions', () => {
  // Copied from renovate@44 dist/modules/manager/github-actions/known-actions/github-releases.js.
  // Re-read that file when .forgejo/renovate-version crosses a major.
  assert.deepEqual([...BUILTIN_ACTION_INPUTS.keys()].sort(), [
    'actions/setup-go:go-version',
    'actions/setup-node:node-version',
    'actions/setup-python:python-version',
    'astral-sh/setup-uv:version',
  ]);
});

// ── assignment ────────────────────────────────────────────────────────────────────────────────

for (const [label, path, text, name, value, line] of [
  ['a shell variable', 'scripts/a.sh', 'set -e\nFOO_VERSION=1.2.3\n', 'FOO_VERSION', '1.2.3', 2],
  ['a Dockerfile ARG', 'infra/app/Dockerfile', 'FROM x\nARG GRADLE_VERSION=9.4.1\n', 'GRADLE_VERSION', '9.4.1', 2],
  ['a Dockerfile ENV in space form', 'infra/app/Dockerfile', 'ENV X_VERSION 1.2\n', 'X_VERSION', '1.2', 1],
  ['a JS constant', 'scripts/lib/w.mjs', "export const CCUSAGE_VERSION = '20.0.48';\n", 'CCUSAGE_VERSION', '20.0.48', 1],
  ['a workflow env value', '.forgejo/workflows/w.yml', "env:\n  SEMGREP_PIN: '1.2.3'\n", 'SEMGREP_PIN', '1.2.3', 2],
  ['a PowerShell variable', 'scripts/x.ps1', "$PNPM_VERSION = '11.17.0'\n", 'PNPM_VERSION', '11.17.0', 1],
  ['a digits-only build number outside JS', '.devcontainer/toolchain.Dockerfile', 'ARG ANDROID_CLT_VERSION=11076708\n', 'ANDROID_CLT_VERSION', '11076708', 1],
]) {
  test(`assignment: ${label} is a pin`, () => {
    const pin = onlyPin(path, text);
    assert.deepEqual(pin, { file: path, line, shape: 'assignment', name, value });
  });
}

for (const [label, path, text] of [
  ['PIN only as part of a word (SPINNER)', 'scripts/a.sh', 'SPINNER_INTERVAL=100\n'],
  ['a digits-only JS constant (a format version)', 'scripts/lib/p.mjs', 'export const PARSER_VERSION = 2;\n'],
  ['a non-version value', 'scripts/a.sh', 'X_VERSION=latest\n'],
  ['a variable reference', 'scripts/a.sh', 'X_VERSION=${Y}\n'],
]) {
  test(`assignment: ${label} is not a pin`, () => {
    assert.deepEqual(pinsIn(path, text), []);
  });
}

// ── action-input ──────────────────────────────────────────────────────────────────────────────

const steps = (body) => `jobs:\n  a:\n    steps:\n${body}`;

test('action-input: a block-form with: input is a pin named after its action, a comment line between', () => {
  const pin = onlyPin('.forgejo/workflows/w.yml', steps(
    '      - uses: actions/setup-node@949feb24 # v7\n        # why\n        with:\n          node-version: 26.13.1\n          cache: pnpm\n',
  ));
  assert.deepEqual(pin, { file: '.forgejo/workflows/w.yml', line: 7, shape: 'action-input', name: 'actions/setup-node:node-version', value: '26.13.1' });
});

test('action-input: a flow-form with: input is a pin', () => {
  const pin = onlyPin('.forgejo/workflows/w.yml', steps('      - uses: actions/setup-node@949feb24\n        with: { node-version: 26.13.1, cache: pnpm }\n'));
  assert.deepEqual(pin, { file: '.forgejo/workflows/w.yml', line: 5, shape: 'action-input', name: 'actions/setup-node:node-version', value: '26.13.1' });
});

test('action-input: a quoted version input with a trailing comment is a pin', () => {
  const pin = onlyPin('.forgejo/workflows/w.yml', steps("      - name: uv\n        uses: astral-sh/setup-uv@abc123\n        with:\n          version: '0.13.9' # uv-version\n"));
  assert.equal(pin.name, 'astral-sh/setup-uv:version');
  assert.equal(pin.value, '0.13.9');
  assert.equal(pin.line, 7);
});

test('action-input: a version input under a step with no uses: throws, naming file and line', () => {
  assert.throws(
    () => detectPins({ '.forgejo/workflows/w.yml': steps('      - name: x\n        with:\n          node-version: 26.13.1\n') }),
    /\.forgejo\/workflows\/w\.yml:6/,
  );
});

// ── command-spec ──────────────────────────────────────────────────────────────────────────────

for (const [label, path, text, name, value, line] of [
  ['a workflow run: block', '.forgejo/workflows/w.yml', steps('      - run: |\n          npm install -g openwiki@1.2.3\n'), 'openwiki', '1.2.3', 5],
  ['a shell script', 'scripts/a.sh', 'npm install -g openwiki@1.2.3\n', 'openwiki', '1.2.3', 1],
  ['a Dockerfile RUN continuation line', 'x/Dockerfile', 'RUN cargo install --locked \\\n      cargo-audit@0.23.0 \\\n      other\n', 'cargo-audit', '0.23.0', 2],
  ['a pip == spec', 'scripts/a.sh', 'pip install semgrep==1.2.3\n', 'semgrep', '1.2.3', 1],
]) {
  test(`command-spec: ${label} is a pin`, () => {
    const pin = onlyPin(path, text);
    assert.deepEqual(pin, { file: path, line, shape: 'command-spec', name, value });
  });
}

for (const [label, path, text] of [
  ['a tool@version inside a JS string', 'scripts/c.mjs', "const s = 'pnpm@11.17.0';\n"],
  ['an action ref outside run:', '.forgejo/workflows/w.yml', steps('      - uses: actions/checkout@v4.1.0\n')],
  ['a # comment', 'scripts/a.sh', '# FOO_VERSION=1.2.3 and npm i openwiki@1.2.3\n'],
  ['a // comment', 'scripts/c.mjs', "// const X_VERSION = '1.2.3';\n"],
  ['a * comment', 'scripts/c.mjs', "/**\n * X_VERSION=1.2.3\n */\n"],
  ['a Markdown file', 'docs/a.md', 'FOO_VERSION=1.2.3\n'],
  ['a specs/ file', 'specs/107-x/plan.sh', 'FOO_VERSION=1.2.3\n'],
  ['a lockfile', 'pnpm-lock.yaml', 'FOO_VERSION: 1.2.3\n'],
  ['the devcontainer lockfile', '.devcontainer/devcontainer-lock.json', 'FOO_VERSION=1.2.3\n'],
  ['a test fixture', 'scripts/__tests__/fixtures/a.sh', 'FOO_VERSION=1.2.3\n'],
]) {
  test(`not a pin: ${label}`, () => {
    assert.deepEqual(pinsIn(path, text), []);
  });
}

// ── verdict ───────────────────────────────────────────────────────────────────────────────────

test('verdict: an uncovered, unexcluded pin is unmanaged and fails', () => {
  const v = classifyPins([shPin], new Map(), NO_EXCLUSIONS);
  assert.equal(v.pins[0]?.status, 'unmanaged', `expected status unmanaged, got ${v.pins[0]?.status}`);
  assert.equal(v.ok, false);
});

test('verdict: a pin a customManager captures is managed by it', () => {
  const v = classifyPins([shPin], coverageOf('scripts/a.sh', 2, 'foo'), NO_EXCLUSIONS);
  assert.equal(v.pins[0]?.status, 'managed');
  assert.equal(v.pins[0].manager, 'foo');
  assert.equal(v.pins[0].coverage, 'custom');
  assert.equal(v.ok, true);
});

test('verdict: a setup-node input is managed by the built-in github-actions manager', () => {
  const pin = { file: '.forgejo/workflows/w.yml', line: 7, shape: 'action-input', name: 'actions/setup-node:node-version', value: '26.13.1' };
  const v = classifyPins([pin], new Map(), NO_EXCLUSIONS);
  assert.equal(v.pins[0]?.status, 'managed');
  assert.equal(v.pins[0].manager, 'github-actions:actions/setup-node');
  assert.equal(v.pins[0].coverage, 'builtin');
});

test('verdict: a pin covered by a customManager AND the built-in table reports the customManager', () => {
  const pin = { file: '.forgejo/workflows/w.yml', line: 7, shape: 'action-input', name: 'astral-sh/setup-uv:version', value: '0.13.9' };
  const v = classifyPins([pin], coverageOf('.forgejo/workflows/w.yml', 7, 'astral-sh/uv'), NO_EXCLUSIONS);
  assert.equal(v.pins[0]?.manager, 'astral-sh/uv');
  assert.equal(v.pins[0].coverage, 'custom');
});

test('verdict: an unmanaged pin with a valid exclusion is excluded and carries its reason', () => {
  const v = classifyPins([shPin], new Map(), { valid: [{ file: 'scripts/a.sh', name: 'FOO_VERSION', reason: REASON }], invalid: [] });
  assert.equal(v.pins[0]?.status, 'excluded');
  assert.equal(v.pins[0].reason, REASON);
  assert.equal(v.ok, true);
});

test('verdict: the report names file, line, pin and both remedies, with a summary on pass and fail', () => {
  const failing = formatReport(classifyPins([shPin], new Map(), NO_EXCLUSIONS));
  assert.match(failing, /^UNMANAGED\s+scripts\/a\.sh:2\s+FOO_VERSION = 1\.2\.3$/m);
  assert.match(failing, /customManager.*renovate\.json.*version-pin-exclusions\.json/);
  assert.match(failing, /── 1 pins: 0 managed, 0 excluded, 1 unmanaged · 0 stale · 0 redundant · 0 invalid ──/);
  const passing = formatReport(classifyPins([shPin], coverageOf('scripts/a.sh', 2, 'foo'), NO_EXCLUSIONS));
  assert.match(passing, /^managed\s+scripts\/a\.sh:2\s+FOO_VERSION = 1\.2\.3\s+← foo$/m);
  assert.match(passing, /── 1 pins: 1 managed, 0 excluded, 0 unmanaged/);
});

test('verdict: checkTree exits 1 on a finding, 0 when managed, 3 when the config cannot be read', () => {
  const files = { 'scripts/a.sh': 'FOO_VERSION=1.2.3\n' };
  assert.equal(checkTree({ files, renovateText: '{}', exclusionsText: null }).exitCode, 1);
  const managed = JSON.stringify(config(regexManager('/^scripts/a\\.sh$/', 'FOO_VERSION=(?<currentValue>[\\d.]+)', { depNameTemplate: 'foo' })));
  assert.equal(checkTree({ files, renovateText: managed, exclusionsText: null }).exitCode, 0);
  assert.equal(checkTree({ files, renovateText: '{not json', exclusionsText: null }).exitCode, 3);
});

// ── exclusion validity ────────────────────────────────────────────────────────────────────────

const ok = { file: 'scripts/a.sh', name: 'FOO_VERSION', reason: REASON };
for (const [label, entries] of [
  ['a missing reason', [{ file: ok.file, name: ok.name }]],
  ['a reason under 20 characters', [{ ...ok, reason: 'n/a' }]],
  ['a wildcard name', [{ ...ok, name: 'FOO_*' }]],
  ['a wildcard file', [{ ...ok, file: 'scripts/?.sh' }]],
  ['a duplicate {file, name}', [ok, { ...ok }]],
]) {
  test(`invalid exclusion: ${label}`, () => {
    const { invalid } = loadExclusions(JSON.stringify(entries));
    assert.equal(invalid.length, 1, `expected 1 invalid exclusion, got ${invalid.length}`);
  });
}

test('invalid exclusion: a file that is not a JSON array cannot be checked (exit 3)', () => {
  assert.throws(() => loadExclusions('{}'));
  assert.equal(checkTree({ files: {}, renovateText: '{}', exclusionsText: '{}' }).exitCode, 3);
});

test('invalid exclusion: an invalid entry fails the check', () => {
  const v = classifyPins([], new Map(), loadExclusions(JSON.stringify([{ file: ok.file, name: ok.name }])));
  assert.equal(v.invalidExclusions.length, 1);
  assert.equal(v.ok, false);
});

// ── stale / redundant ─────────────────────────────────────────────────────────────────────────

test('stale: an exclusion matching no pin fails and says to delete it', () => {
  const v = classifyPins([], new Map(), { valid: [{ file: 'scripts/a.sh', name: 'GONE_VERSION', reason: REASON }], invalid: [] });
  assert.equal(v.staleExclusions.length, 1, `expected 1 stale exclusion, got ${v.staleExclusions.length}`);
  assert.equal(v.ok, false);
  assert.match(formatReport(v), /^STALE\s+exclusion \{file: scripts\/a\.sh, name: GONE_VERSION\} matches no pin — delete it$/m);
});

test('redundant: an exclusion whose pins are all managed fails, naming the manager', () => {
  const v = classifyPins([shPin], coverageOf('scripts/a.sh', 2, 'foo'), { valid: [ok], invalid: [] });
  assert.equal(v.redundantExclusions.length, 1, `expected 1 redundant exclusion, got ${v.redundantExclusions.length}`);
  assert.equal(v.ok, false);
  assert.match(formatReport(v), /^REDUNDANT\s+exclusion \{file: scripts\/a\.sh, name: FOO_VERSION\} — the pin is managed by foo; delete the exclusion$/m);
});

test('redundant: an exclusion still excusing one of two occurrences is neither stale nor redundant', () => {
  const second = { ...shPin, line: 5 };
  const v = classifyPins([shPin, second], coverageOf('scripts/a.sh', 2, 'foo'), { valid: [ok], invalid: [] });
  assert.equal(v.staleExclusions.length, 0);
  assert.equal(v.redundantExclusions.length, 0);
  assert.deepEqual(v.pins.map((p) => p.status), ['managed', 'excluded']);
});

// ── repository tree ───────────────────────────────────────────────────────────────────────────

test('repository tree: every pin in the committed tree is managed or excluded', () => {
  const result = checkTree();
  const unmanaged = (result.verdict?.pins ?? []).filter((p) => p.status === 'unmanaged').map((p) => `${p.file}:${p.line} ${p.name} = ${p.value}`);
  assert.equal(result.exitCode, 0, `${result.error ?? ''}\n${unmanaged.join('\n')}\n${formatReport(result.verdict ?? classifyPins([], new Map(), NO_EXCLUSIONS))}`);
});

test('repository tree: the verdict is the same on repeated runs', () => {
  assert.deepEqual(checkTree(), checkTree());
});

test('repository tree: the check imports only Node built-ins and ./lib/, and makes no network call', () => {
  const source = readFileSync(SCRIPT, 'utf8');
  const imports = [...source.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
  assert.ok(imports.length > 0, 'no imports found: the scan is broken');
  for (const spec of imports) assert.match(spec, /^(node:(?!https?$)|\.\/lib\/)/, `forbidden import ${spec}`);
  assert.doesNotMatch(source, /\bfetch\(|import\(/);
});
