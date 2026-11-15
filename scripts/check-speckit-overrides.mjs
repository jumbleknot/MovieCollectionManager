#!/usr/bin/env node
// Spec Kit override gate (feature 101, item #1021; docs/proposals/PRD-DocDriftPrevention.md §4).
//
// WHY THIS EXISTS. The doc-impact sweep lives in a PROJECT OVERRIDE of Spec Kit's tasks template
// (.specify/templates/overrides/tasks-template.md), because Spec Kit owns the core template and an
// upgrade rewrites it with nothing to say a local edit was lost. But an override is a FORK: after an
// upgrade, /speckit-tasks keeps using the old structure and upstream improvements never arrive —
// silently. The same failure as editing core, in reverse. This gate makes both directions loud.
//
// It fails when:
//   - the core template no longer matches the fork point recorded on the override's first line
//     (Spec Kit changed it — re-merge, then --record);
//   - the override is missing, its header is malformed, or it no longer carries the sweep task;
//   - setup-tasks.ps1 stops resolving through Resolve-Template, or Resolve-Template stops checking
//     overrides/ first — an upgrade that drops override support must fail, not fall back to core.
//
// The fork point is written ONLY by --record, from the core template's bytes. Never hand-type it
// (the V17 rule). The scripts are read as text and never executed: the runner need not have pwsh.
//
// Usage:
//   node scripts/check-speckit-overrides.mjs             # scan; exit 0 clean / 1 drift / 2 bad args
//   node scripts/check-speckit-overrides.mjs --record    # rewrite the fork point after a re-merge
//   node scripts/check-speckit-overrides.mjs --selftest  # prove each failure is detected
// Procedure: docs/runbooks/doc-drift.md#upgrading-spec-kit
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dieOnArgvError, partitionArgs, wantsHelp } from './lib/argv-contract.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const CORE_TEMPLATE = '.specify/templates/tasks-template.md';
export const OVERRIDE_TEMPLATE = '.specify/templates/overrides/tasks-template.md';
const COMMON_PS1 = '.specify/scripts/powershell/common.ps1';
const SETUP_TASKS_PS1 = '.specify/scripts/powershell/setup-tasks.ps1';
const INIT_OPTIONS = '.specify/init-options.json';
export const SWEEP_MARKER = '**Doc-impact sweep**';
const RUNBOOK = 'docs/runbooks/doc-drift.md#upgrading-spec-kit';
// How far back to look for the fork base. Spec Kit upgrades are rare; the core template has had a
// handful of revisions in this repository's whole history.
const HISTORY_DEPTH = 200;

const USAGE = `usage: node scripts/check-speckit-overrides.mjs [--record | --selftest | --help]
  (no flag)   scan: fail if the tasks-template override has drifted from Spec Kit's core template
  --record    rewrite the override's fork point from the core template (after merging its changes)
  --selftest  prove every failure condition is detected`;

const FORK_POINT = /^<!-- forked-from: (\S+) sha256=([0-9a-f]{64}) spec-kit=(\S+) -->$/;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const forkPointLine = (hash, specKit) => `<!-- forked-from: ${CORE_TEMPLATE} sha256=${hash} spec-kit=${specKit} -->`;

/** @returns {{corePath: string, sha256: string, specKit: string} | null} */
export function parseForkPoint(line) {
  const m = FORK_POINT.exec(String(line ?? '').trimEnd());
  if (!m || m[1] !== CORE_TEMPLATE) return null;
  return { corePath: m[1], sha256: m[2], specKit: m[3] };
}

const hasSweepTask = (text) => text.split('\n').some((l) => /^\s*- \[[ xX]\] /.test(l) && l.includes(SWEEP_MARKER));

/**
 * Does Resolve-Template still check overrides/ before anything else? Read as text: the body runs
 * from `function Resolve-Template` to the next top-level `function`, and the first `overrides/`
 * reference must precede every presets/extensions reference and the first `return`. A harmless
 * upstream refactor can trip this; the fix is a reviewed edit HERE, never deleting the gate.
 */
function resolutionProblems(common, setup) {
  const problems = [];
  if (setup === null || !/Resolve-Template\s+-TemplateName\s+['"]tasks-template['"]/.test(setup)) {
    problems.push(`${SETUP_TASKS_PS1} no longer resolves tasks-template through Resolve-Template`);
  }
  const fn = common === null ? -1 : common.search(/^function\s+Resolve-Template\b/m);
  if (fn === -1) {
    problems.push(`${COMMON_PS1} no longer defines Resolve-Template`);
  } else {
    const rest = common.slice(fn + 1);
    const next = rest.search(/^function\s+/m);
    const body = common.slice(fn, next === -1 ? undefined : fn + 1 + next);
    const at = (re) => {
      const i = body.search(re);
      return i === -1 ? Infinity : i;
    };
    const overrides = at(/overrides\//);
    const firstOther = Math.min(at(/presets/), at(/extensions/), at(/\breturn\b/));
    if (overrides === Infinity || overrides > firstOther) {
      problems.push(`${COMMON_PS1} Resolve-Template no longer checks overrides/ first`);
    }
  }
  return problems;
}

function git(root, args, encoding = 'utf8') {
  return execFileSync('git', args, { cwd: root, encoding, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 });
}

/** The core template's diff since the revision whose bytes hash to `forkHash`, or null. */
function diffSinceForkBase(root, forkHash) {
  try {
    const revs = git(root, ['log', `-${HISTORY_DEPTH}`, '--format=%H', '--', CORE_TEMPLATE]).split('\n').filter(Boolean);
    for (const rev of revs) {
      if (sha256(git(root, ['show', `${rev}:${CORE_TEMPLATE}`], 'buffer')) === forkHash) {
        return { rev, diff: git(root, ['diff', rev, '--', CORE_TEMPLATE]) };
      }
    }
  } catch {
    // Not a git checkout, or git absent — reported as "history unavailable" by the caller.
  }
  return null;
}

/** @returns {{ok: boolean, failures: Array<{code: string, message: string}>}} */
export function checkSpeckitOverrides({ root = REPO_ROOT } = {}) {
  const read = (rel, enc = 'utf8') => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), enc) : null);
  const failures = [];
  const fail = (code, message) => failures.push({ code, message });

  const override = read(OVERRIDE_TEMPLATE);
  const core = read(CORE_TEMPLATE, null);
  if (override === null) {
    fail('override-missing', `${OVERRIDE_TEMPLATE} is missing — task generation falls back to Spec Kit's core template, which has no doc-impact sweep`);
  } else {
    const fork = parseForkPoint(override.split('\n')[0]);
    if (!fork) {
      fail('header-invalid', `${OVERRIDE_TEMPLATE} line 1 is not a fork point (expected "${forkPointLine('<sha256>', '<version>')}")`);
    }
    if (!hasSweepTask(override)) {
      fail('sweep-missing', `${OVERRIDE_TEMPLATE} has no task line carrying ${SWEEP_MARKER}`);
    }
    if (fork && core === null) {
      fail('core-changed', `${CORE_TEMPLATE} is missing — Spec Kit moved or removed its core tasks template`);
    } else if (fork && sha256(core) !== fork.sha256) {
      const base = diffSinceForkBase(root, fork.sha256);
      const detail = base
        ? `upstream change since the fork base (${base.rev.slice(0, 12)}):\n${base.diff || '(no textual diff)'}`
        : `fork base sha256=${fork.sha256.slice(0, 12)}… not found in git history (history unavailable — a shallow clone, or not a git checkout); compare the two files by hand`;
      fail('core-changed', `${CORE_TEMPLATE} no longer matches the fork point recorded in ${OVERRIDE_TEMPLATE} (Spec Kit changed it; recorded ${fork.sha256.slice(0, 12)}, now ${sha256(core).slice(0, 12)}).\n${detail}`);
    }
  }
  for (const p of resolutionProblems(read(COMMON_PS1), read(SETUP_TASKS_PS1))) {
    fail('resolution-broken', `${p} — the override would be silently ignored`);
  }
  return { ok: failures.length === 0, failures };
}

/** Rewrite the override's fork point from the core template. Refuses a fork that lost the sweep. */
export function recordForkPoint({ root = REPO_ROOT } = {}) {
  const overridePath = join(root, OVERRIDE_TEMPLATE);
  if (!existsSync(overridePath)) throw new Error(`${OVERRIDE_TEMPLATE} is missing — nothing to record`);
  const text = readFileSync(overridePath, 'utf8');
  if (!hasSweepTask(text)) {
    throw new Error(`refusing to record: ${OVERRIDE_TEMPLATE} has no task line carrying ${SWEEP_MARKER} — restore it first`);
  }
  const current = sha256(readFileSync(join(root, CORE_TEMPLATE)));
  let specKit = 'unknown';
  try {
    specKit = JSON.parse(readFileSync(join(root, INIT_OPTIONS), 'utf8')).speckit_version ?? specKit;
  } catch {
    // init-options.json is informational here; the hash is what the gate compares.
  }
  const lines = text.split('\n');
  const firstIsHeader = /^<!-- forked-from: /.test(lines[0]);
  const previous = firstIsHeader ? (/sha256=(\S+)/.exec(lines[0])?.[1] ?? null) : null;
  const body = firstIsHeader ? lines.slice(1).join('\n') : text;
  writeFileSync(overridePath, `${forkPointLine(current, specKit)}\n${body}`);
  return { previous, current };
}

const REMEDIATION = `Fix: merge the core change into the override, then run node scripts/check-speckit-overrides.mjs --record (never hand-type the hash). Procedure: ${RUNBOOK}`;

function scan(root) {
  const r = checkSpeckitOverrides({ root });
  if (r.ok) {
    const fork = parseForkPoint(readFileSync(join(root, OVERRIDE_TEMPLATE), 'utf8').split('\n')[0]);
    console.log(`✓ speckit-overrides gate passed (override present, sweep task present, core template matches fork point ${fork.sha256.slice(0, 12)}, override-first resolution intact)`);
    return 0;
  }
  for (const f of r.failures) console.error(`[speckit-overrides] ✗ ${f.code}: ${f.message}`);
  console.error(REMEDIATION);
  return 1;
}

function selftest() {
  const coreBody = '# Tasks\n\n- [ ] T001 Setup\n';
  const clean = {
    [CORE_TEMPLATE]: coreBody,
    [OVERRIDE_TEMPLATE]: `${forkPointLine(sha256(coreBody), '0.11.2')}\n${coreBody}- [ ] T002 ${SWEEP_MARKER} — search the docs\n`,
    [COMMON_PS1]: 'function Resolve-Template {\n  $o = Join-Path $b "overrides/$TemplateName.md"\n  if (Test-Path $o) { return $o }\n  $p = Join-Path $r ".specify/presets"\n}\n',
    [SETUP_TASKS_PS1]: "$t = Resolve-Template -TemplateName 'tasks-template' -RepoRoot $r\n",
  };
  const scenarios = [
    ['clean', {}, []],
    ['override-missing', { [OVERRIDE_TEMPLATE]: null }, ['override-missing']],
    ['header-invalid', { [OVERRIDE_TEMPLATE]: `${coreBody}- [ ] T002 ${SWEEP_MARKER}\n` }, ['header-invalid']],
    ['sweep-missing', { [OVERRIDE_TEMPLATE]: `${forkPointLine(sha256(coreBody), '0.11.2')}\n${coreBody}${SWEEP_MARKER} in prose only\n` }, ['sweep-missing']],
    ['core-changed', { [CORE_TEMPLATE]: `${coreBody}- [ ] T009 upstream\n` }, ['core-changed']],
    ['setup bypasses Resolve-Template', { [SETUP_TASKS_PS1]: "$t = '.specify/templates/tasks-template.md'\n" }, ['resolution-broken']],
    ['presets before overrides/', { [COMMON_PS1]: 'function Resolve-Template {\n  $p = ".specify/presets"\n  $o = "overrides/x.md"\n}\n' }, ['resolution-broken']],
  ];
  let broken = 0;
  for (const [name, patch, want] of scenarios) {
    const root = mkdtempSync(join(tmpdir(), 'speckit-overrides-selftest-'));
    try {
      for (const [rel, body] of Object.entries({ ...clean, ...patch })) {
        if (body === null) continue;
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        writeFileSync(join(root, rel), body);
      }
      const got = checkSpeckitOverrides({ root }).failures.map((f) => f.code).sort();
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        broken++;
        console.error(`✗ selftest "${name}": expected [${want}], got [${got}]`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  if (broken) return 1;
  console.log('✓ speckit-overrides gate --selftest passed (clean tree passes; override-missing, header-invalid, sweep-missing, core-changed and both resolution-broken shapes are each detected)');
  return 0;
}

export function main(argv, { root = REPO_ROOT } = {}) {
  if (wantsHelp(argv)) {
    console.log(USAGE);
    return 0;
  }
  let flags;
  try {
    ({ flags } = partitionArgs(argv, { accepted: ['--record', '--selftest'], usage: USAGE }));
  } catch (err) {
    dieOnArgvError(err, { hard: false });
    return 2;
  }
  if (flags.size > 1) {
    console.error(`--record and --selftest are mutually exclusive\n\n${USAGE}`);
    return 2;
  }
  if (flags.has('--selftest')) return selftest();
  if (flags.has('--record')) {
    try {
      const { previous, current } = recordForkPoint({ root });
      console.log(`recorded fork point: ${previous ? previous.slice(0, 12) : '(none)'} → ${current.slice(0, 12)} in ${OVERRIDE_TEMPLATE}`);
      return 0;
    } catch (err) {
      console.error(`[speckit-overrides] ✗ ${err.message}`);
      return 1;
    }
  }
  return scan(root);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
