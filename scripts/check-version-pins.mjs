#!/usr/bin/env node
// Feature 107 (item #1128): every hand-written version pin is managed by Renovate or excused.
//
// WHY. Renovate never proposes an update for a pin no manager can see, and nothing reports that
// silence: the pin ages until it is a CVE, an `engines` failure or a skew. Each past case (#303,
// #307, #1114, #1119, #1120, #1126) was found by someone reading the right file, and fixed with a
// manager for that one pin. This makes the next one a red check on the PR that adds it.
//
// "Managed" is decided OFFLINE (spec FR-009) by evaluating renovate.json's own customManagers per
// captured occurrence — a manager whose file pattern names the file but whose regex captures nothing
// on that line does NOT count (the nx #194 shape) — plus the version inputs Renovate's built-in
// github-actions manager reads. Running Renovate itself takes ~70 s, needs the network and was
// OOM-killed in an 8 GB container (research R1). The evaluation supports exactly the regex features
// renovate.json uses and THROWS on anything else rather than guessing.
//
// Known limit: a version embedded in a URL path or a non-UPPER_SNAKE name is out of the detector's
// sight (research R3). The Dependency Dashboard (item #29) lists what Renovate actually extracts.
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArgvError, partitionArgs, wantsHelp, dieOnArgvError } from './lib/argv-contract.mjs';
import { isMain } from './lib/is-main.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const EXCLUSIONS_FILE = '.forgejo/version-pin-exclusions.json';
const REMEDY = `  → add a customManager to renovate.json that captures it, or add {file, name, reason} to ${EXCLUSIONS_FILE}`;
const MIN_REASON = 20;

export const USAGE = `check-version-pins.mjs — every version pin is managed by Renovate or excused (item #1128).

  node scripts/check-version-pins.mjs          check the tree and print the classification
  node scripts/check-version-pins.mjs --json   the same, as JSON on stdout
  node scripts/check-version-pins.mjs --help   this text

Read-only: no flag writes anything. Tracked files only (git ls-files).
Exit 0 every pin managed or excluded; 1 an unmanaged pin or a stale, redundant or invalid exclusion;
2 bad arguments; 3 the check could not run (never reported as a finding).
Exclusions: ${EXCLUSIONS_FILE} — docs/runbooks/renovate.md, "The version-pin guard".`;

/** Thrown when the check cannot reach a verdict; the CLI maps it to exit 3, never to a finding. */
export class InstrumentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InstrumentError';
  }
}

// ── what is scanned (FR-001) ─────────────────────────────────────────────────────────────────

export const SCANNED_SURFACES = [
  { pattern: /^\.forgejo\/workflows\/[^/]+\.ya?ml$/, describes: 'CI workflows' },
  { pattern: /^scripts\/(?!__tests__\/).+\.(sh|mjs|ps1)$/, describes: 'shell, Node and PowerShell scripts under scripts/ (not scripts/__tests__/)' },
  { pattern: /(^|\/)(Dockerfile[^/]*|[^/]+\.Dockerfile)$/, describes: 'Dockerfiles, anywhere' },
  { pattern: /^\.devcontainer\/.+/, describes: 'dev-container configuration' },
];
const NEVER_SCANNED = [/(^|\/)__tests__\//, /(^|\/)fixtures\//, /^specs\//, /^docs\//, /\.md$/, /-lock\.json$/];

export function isScanned(path) {
  return SCANNED_SURFACES.some((s) => s.pattern.test(path)) && !NEVER_SCANNED.some((p) => p.test(path));
}

function kindOf(path) {
  if (/^\.forgejo\/workflows\//.test(path)) return 'workflow';
  if (/(^|\/)(Dockerfile[^/]*|[^/]+\.Dockerfile)$/.test(path)) return 'dockerfile';
  if (path.endsWith('.sh')) return 'shell';
  if (path.endsWith('.mjs')) return 'js';
  if (path.endsWith('.ps1')) return 'powershell';
  return 'other';
}

// ── detection (FR-002, research R3, data-model.md Pin) ────────────────────────────────────────

const DOTTED = /^v?\d+\.\d+(\.\d+)?([-+.][\w.-]+)?$/;
const DIGITS = /^\d+$/;
const PIN_NAME = /(^|_)(VERSION|PIN)(_|$)/;
// A name and what follows it are matched in two steps: a single regex would consume `ARG NAME` as
// name=ARG, value=NAME, and never see NAME=value.
const ASSIGNED_NAME = /(?<![\w$.-])\$?(?<name>[A-Z][A-Z0-9_]*)/g;
const ASSIGNED_VALUE = /(?<sep>\s*[=:]\s*|\s+)(?<q>['"]?)(?<value>[\w.+-]+)\k<q>/y;
const COMMAND_SPEC = /(?<![\w@/.-])(?<name>@?[a-z0-9][\w./-]*?)(?:@|==)(?<value>v?\d+\.\d+(?:\.\d+)?[\w.+-]*)/g;
const VERSION_INPUT = /^(version|[a-z0-9-]+-version)$/;

const isComment = (line) => /^\s*(#|\/\/|\*|\/\*)/.test(line);
const indentOf = (line) => line.match(/^\s*/)[0].length;

function assignmentsIn(line, kind) {
  const found = [];
  for (const m of line.matchAll(ASSIGNED_NAME)) {
    const { name } = m.groups;
    if (!PIN_NAME.test(name)) continue;
    ASSIGNED_VALUE.lastIndex = m.index + m[0].length;
    const rest = ASSIGNED_VALUE.exec(line);
    if (!rest) continue;
    const { sep, value } = rest.groups;
    if (!/[=:]/.test(sep) && !(kind === 'dockerfile' && /^\s*ENV\s/.test(line))) continue;
    const digitsOnly = DIGITS.test(value) && kind !== 'js';
    if (!DOTTED.test(value) && !digitsOnly) continue;
    found.push({ name, value });
  }
  return found;
}

function commandSpecsIn(text) {
  const found = [];
  for (const m of text.matchAll(COMMAND_SPEC)) {
    if (DOTTED.test(m.groups.value)) found.push({ name: m.groups.name, value: m.groups.value });
  }
  return found;
}

const unquote = (raw) => raw.trim().replace(/\s+#.*$/, '').replace(/^(['"])(.*)\1$/, '$2');

/** Lines that are shell: a workflow run: block, a Dockerfile RUN with its continuations, a .sh file. */
function shellLines(lines, kind) {
  const shell = new Set();
  if (kind === 'shell') lines.forEach((_, i) => shell.add(i));
  if (kind === 'dockerfile') {
    let continuing = false;
    let inRun = false;
    lines.forEach((line, i) => {
      if (!continuing) inRun = /^\s*RUN\b/i.test(line);
      if (inRun && !isComment(line)) shell.add(i);
      continuing = line.trimEnd().endsWith('\\');
    });
  }
  if (kind === 'workflow') {
    let blockIndent = -1;
    lines.forEach((line, i) => {
      if (blockIndent >= 0) {
        if (line.trim() === '' || indentOf(line) > blockIndent) return shell.add(i);
        blockIndent = -1;
      }
      const run = line.match(/^(\s*(?:-\s+)?)run:\s*(.*)$/);
      if (!run) return;
      if (/^[|>][-+]?\s*(#.*)?$/.test(run[2])) blockIndent = run[1].length;
      else shell.add(i);
    });
  }
  return shell;
}

/** Version inputs in steps' `with:`, block or flow form, attributed to the step's `uses:` action. */
function actionInputsIn(lines, file) {
  const found = [];
  let step = null;
  let withIndent = -1;
  const record = (key, raw, i) => {
    if (!VERSION_INPUT.test(key)) return;
    const value = unquote(raw);
    if (!DOTTED.test(value)) return;
    if (!step?.uses) throw new InstrumentError(`${file}:${i + 1} a with: version input under a step with no uses: — cannot attribute it`);
    found.push({ line: i + 1, name: `${step.uses}:${key}`, value });
  };
  lines.forEach((line, i) => {
    if (line.trim() === '' || isComment(line)) return;
    const indent = indentOf(line);
    if (withIndent >= 0) {
      if (indent > withIndent) {
        const kv = line.match(/^\s*([a-z0-9-]+):\s*(.*)$/);
        if (kv) record(kv[1], kv[2], i);
        return;
      }
      withIndent = -1;
    }
    const item = line.match(/^(\s*)-\s+(.*)$/);
    if (item) step = { indent: item[1].length + 2, uses: null };
    else if (step && indent < step.indent) step = null;
    const body = item ? item[2] : line.trim();
    const uses = body.match(/^uses:\s*['"]?([^@'"\s]+)@/);
    if (uses && step) step.uses = uses[1];
    const withKey = body.match(/^with:\s*(.*)$/);
    if (!withKey || !step) return;
    const rest = withKey[1].replace(/\s+#.*$/, '').trim();
    if (rest === '') {
      withIndent = item ? step.indent : indent;
      return;
    }
    if (!/^\{.*\}$/.test(rest)) throw new InstrumentError(`${file}:${i + 1} a with: form this check cannot read: ${rest}`);
    for (const pair of rest.slice(1, -1).split(',')) {
      const kv = pair.match(/^\s*([a-z0-9-]+):\s*(.*)$/);
      if (kv) record(kv[1], kv[2], i);
    }
  });
  return found;
}

export function detectPins(tree) {
  const pins = [];
  for (const file of Object.keys(tree).map((f) => f.replaceAll('\\', '/')).filter(isScanned).sort()) {
    const kind = kindOf(file);
    const lines = tree[file].split(/\r?\n/);
    const shell = shellLines(lines, kind);
    lines.forEach((line, i) => {
      if (isComment(line)) return;
      for (const a of assignmentsIn(line, kind)) pins.push({ file, line: i + 1, shape: 'assignment', ...a });
      if (shell.has(i)) {
        for (const c of commandSpecsIn(line.replace(/^\s*(?:-\s+)?run:\s*/, ''))) pins.push({ file, line: i + 1, shape: 'command-spec', ...c });
      }
    });
    if (kind === 'workflow') {
      for (const a of actionInputsIn(lines, file)) pins.push({ file, shape: 'action-input', ...a });
    }
  }
  return pins.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.name.localeCompare(b.name));
}

// ── coverage (FR-003, research R1/R2, data-model.md Coverage) ─────────────────────────────────

/** Renovate 44's github-actions manager reads these inputs (known-actions/github-releases.js). */
export const BUILTIN_ACTION_INPUTS = new Map([
  ['actions/setup-go:go-version', 'github-actions:actions/setup-go'],
  ['actions/setup-node:node-version', 'github-actions:actions/setup-node'],
  ['actions/setup-python:python-version', 'github-actions:actions/setup-python'],
  ['astral-sh/setup-uv:version', 'github-actions:astral-sh/setup-uv'],
]);

function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      out += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

function filePatternToRegExp(pattern) {
  const literal = pattern.match(/^\/(.*)\/([a-z]*)$/s);
  return literal ? new RegExp(literal[1], literal[2]) : globToRegExp(pattern);
}

export function managedOccurrences(tree, renovateConfig) {
  const coverage = new Map();
  for (const manager of renovateConfig.customManagers ?? []) {
    const label = manager.depNameTemplate ?? manager.packageNameTemplate ?? JSON.stringify(manager.managerFilePatterns);
    if (manager.customType !== 'regex') throw new InstrumentError(`customManager ${label}: customType ${manager.customType} is not supported`);
    const strategy = manager.matchStringsStrategy ?? 'any';
    if (strategy !== 'any') throw new InstrumentError(`customManager ${label}: matchStringsStrategy ${strategy} is not supported`);
    const filePatterns = (manager.managerFilePatterns ?? []).map(filePatternToRegExp);
    const matchers = (manager.matchStrings ?? []).map((s) => new RegExp(s, 'gd'));
    for (const [file, text] of Object.entries(tree)) {
      if (!filePatterns.some((p) => p.test(file))) continue;
      for (const matcher of matchers) {
        for (const m of text.matchAll(matcher)) {
          const span = m.indices.groups?.currentValue;
          if (!span) continue;
          const line = text.slice(0, span[0]).split('\n').length;
          const name = m.groups.depName ?? manager.depNameTemplate ?? manager.packageNameTemplate ?? label;
          if (!coverage.has(file)) coverage.set(file, new Map());
          if (!coverage.get(file).has(line)) coverage.get(file).set(line, name);
        }
      }
    }
  }
  return coverage;
}

// ── exclusions (FR-005, contracts/exclusions-file.md, data-model.md Exclusion) ────────────────

export function loadExclusions(text) {
  if (text == null) return { valid: [], invalid: [] };
  let entries;
  try {
    entries = JSON.parse(text);
  } catch (err) {
    throw new InstrumentError(`${EXCLUSIONS_FILE} is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(entries)) throw new InstrumentError(`${EXCLUSIONS_FILE} must be a JSON array`);
  const valid = [];
  const invalid = [];
  const seen = new Set();
  entries.forEach((entry, index) => {
    const exact = (v) => typeof v === 'string' && v.trim() !== '' && !/[*?]/.test(v);
    const problem = !exact(entry?.file) ? 'file must be an exact path, with no * or ?'
      : !exact(entry?.name) ? 'name must be an exact pin name, with no * or ?'
      : typeof entry.reason !== 'string' || entry.reason.trim().length < MIN_REASON ? `reason must say why, in at least ${MIN_REASON} characters`
      : seen.has(`${entry.file}\0${entry.name}`) ? 'duplicates an earlier entry'
      : null;
    if (problem) invalid.push({ index, file: entry?.file, name: entry?.name, problem });
    else {
      seen.add(`${entry.file}\0${entry.name}`);
      valid.push({ file: entry.file, name: entry.name, reason: entry.reason.trim() });
    }
  });
  return { valid, invalid };
}

// ── verdict (FR-004/006/008, data-model.md Verdict) ───────────────────────────────────────────

export function classifyPins(pins, coverage, exclusions) {
  const excusedBy = (pin) => exclusions.valid.find((e) => e.file === pin.file && e.name === pin.name);
  const classified = pins.map((pin) => {
    const custom = coverage.get(pin.file)?.get(pin.line);
    if (custom) return { ...pin, status: 'managed', coverage: 'custom', manager: custom };
    const builtin = pin.shape === 'action-input' ? BUILTIN_ACTION_INPUTS.get(pin.name) : undefined;
    if (builtin) return { ...pin, status: 'managed', coverage: 'builtin', manager: builtin };
    const exclusion = excusedBy(pin);
    if (exclusion) return { ...pin, status: 'excluded', reason: exclusion.reason };
    return { ...pin, status: 'unmanaged' };
  });
  const staleExclusions = [];
  const redundantExclusions = [];
  for (const e of exclusions.valid) {
    const matched = classified.filter((p) => p.file === e.file && p.name === e.name);
    if (matched.length === 0) staleExclusions.push({ file: e.file, name: e.name });
    else if (matched.every((p) => p.status === 'managed')) {
      redundantExclusions.push({ file: e.file, name: e.name, managers: [...new Set(matched.map((p) => p.manager))] });
    }
  }
  const invalidExclusions = exclusions.invalid;
  const ok = !classified.some((p) => p.status === 'unmanaged')
    && staleExclusions.length === 0 && redundantExclusions.length === 0 && invalidExclusions.length === 0;
  return { pins: classified, staleExclusions, redundantExclusions, invalidExclusions, ok };
}

export function failureLines(verdict) {
  const lines = [];
  for (const p of verdict.pins.filter((x) => x.status === 'unmanaged')) {
    lines.push(`UNMANAGED  ${p.file}:${p.line}  ${p.name} = ${p.value}`, REMEDY);
  }
  for (const e of verdict.staleExclusions) lines.push(`STALE      exclusion {file: ${e.file}, name: ${e.name}} matches no pin — delete it`);
  for (const e of verdict.redundantExclusions) {
    lines.push(`REDUNDANT  exclusion {file: ${e.file}, name: ${e.name}} — the pin is managed by ${e.managers.join(', ')}; delete the exclusion`);
  }
  for (const e of verdict.invalidExclusions) lines.push(`INVALID    exclusion #${e.index} {file: ${e.file}, name: ${e.name}} — ${e.problem}`);
  return lines;
}

export function formatReport(verdict) {
  const count = (status) => verdict.pins.filter((p) => p.status === status).length;
  const rows = verdict.pins.filter((p) => p.status !== 'unmanaged').map((p) => {
    const where = `${p.file}:${p.line}`.padEnd(48);
    const what = `${p.name} = ${p.value}`.padEnd(44);
    const why = p.status === 'managed' ? `← ${p.manager}` : `← "${p.reason}"`;
    return `${p.status.padEnd(10)} ${where} ${what} ${why}`;
  });
  return [
    '── version pins ──',
    ...rows,
    ...failureLines(verdict),
    `── ${verdict.pins.length} pins: ${count('managed')} managed, ${count('excluded')} excluded, ${count('unmanaged')} unmanaged · ` +
      `${verdict.staleExclusions.length} stale · ${verdict.redundantExclusions.length} redundant · ${verdict.invalidExclusions.length} invalid ──`,
  ].join('\n');
}

// ── the tree ──────────────────────────────────────────────────────────────────────────────────

function readRepository() {
  const ls = spawnSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8' });
  if (ls.status !== 0) throw new InstrumentError(`git ls-files failed: ${ls.stderr || ls.error?.message}`);
  const files = {};
  for (const path of ls.stdout.split('\0').filter(Boolean)) {
    if (isScanned(path) && existsSync(join(REPO, path))) files[path] = readFileSync(join(REPO, path), 'utf8');
  }
  const exclusionsPath = join(REPO, EXCLUSIONS_FILE);
  return {
    files,
    renovateText: readFileSync(join(REPO, 'renovate.json'), 'utf8'),
    exclusionsText: existsSync(exclusionsPath) ? readFileSync(exclusionsPath, 'utf8') : null,
  };
}

/** The whole check. `inputs` defaults to the working tree; tests inject an in-memory one. */
export function checkTree(inputs) {
  try {
    const { files, renovateText, exclusionsText } = inputs ?? readRepository();
    let renovateConfig;
    try {
      renovateConfig = JSON.parse(renovateText);
    } catch (err) {
      throw new InstrumentError(`renovate.json is not valid JSON: ${err.message}`);
    }
    const verdict = classifyPins(detectPins(files), managedOccurrences(files, renovateConfig), loadExclusions(exclusionsText));
    return { exitCode: verdict.ok ? 0 : 1, verdict };
  } catch (err) {
    return { exitCode: 3, error: err instanceof Error ? err.message : String(err) };
  }
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  let json = false;
  try {
    if (wantsHelp(args)) {
      console.log(USAGE);
      process.exit(0);
    }
    json = partitionArgs(args, { accepted: ['--json'], maxPositionals: 0, usage: USAGE }).flags.has('--json');
  } catch (err) {
    if (!(err instanceof ArgvError)) throw err;
    dieOnArgvError(err);
  }
  const result = checkTree();
  if (result.exitCode === 3) {
    console.error(`check-version-pins: the check could not run — ${result.error}`);
  } else if (json) {
    console.log(JSON.stringify(result.verdict, null, 2));
  } else {
    console.log(formatReport(result.verdict));
    if (!result.verdict.ok) console.error(failureLines(result.verdict).join('\n'));
  }
  process.exitCode = result.exitCode;
}
