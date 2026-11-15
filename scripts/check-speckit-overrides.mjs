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
//   - the override is missing, its header is malformed, or it no longer carries the sweep task or
//     the TDD checkpoint sample (Verify RED / Verify GREEN, constitution "TDD Checkpoint Format");
//   - setup-tasks.ps1 stops resolving through Resolve-Template and Resolve-TemplateContent, or
//     either stops checking overrides/ first — an upgrade that drops override support must fail,
//     not fall back to core;
//   - a file Spec Kit manages (listed in .specify/integrations/*.manifest.json) carries an edit
//     that is not in LOCAL_EDITS below, or a registered edit has been reverted to upstream — the
//     `--force` upgrade overwrites every managed file, and feature 049's taskstoissues edit was
//     lost that way once, found only because someone looked;
//   - the inventory runbook (docs/runbooks/spec-kit.md) no longer names every customisation guarded
//     here, so the one list of what this repository changed in Spec Kit cannot fall behind.
//
// The fork point is written ONLY by --record, from the core template's bytes. Never hand-type it
// (the V17 rule). The scripts are read as text and never executed: the runner need not have pwsh.
//
// Usage:
//   node scripts/check-speckit-overrides.mjs             # scan; exit 0 clean / 1 drift / 2 bad args
//   node scripts/check-speckit-overrides.mjs --record    # rewrite the fork point after a re-merge
//   node scripts/check-speckit-overrides.mjs --selftest  # prove each failure is detected
// Procedure: docs/runbooks/spec-kit.md#upgrading-spec-kit
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dieOnArgvError, partitionArgs, wantsHelp } from './lib/argv-contract.mjs';
import { isMain } from './lib/is-main.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const CORE_TEMPLATE = '.specify/templates/tasks-template.md';
export const OVERRIDE_TEMPLATE = '.specify/templates/overrides/tasks-template.md';
const COMMON_PS1 = '.specify/scripts/powershell/common.ps1';
const SETUP_TASKS_PS1 = '.specify/scripts/powershell/setup-tasks.ps1';
const INIT_OPTIONS = '.specify/init-options.json';
export const SWEEP_MARKER = '**Doc-impact sweep**';
export const TDD_TEMPLATE = 'docs/templates/feature-test-tasks-template.md';
const TDD_MARKERS = ['**Verify RED**', '**Verify GREEN**'];
const INTEGRATIONS_DIR = '.specify/integrations';
export const INVENTORY = 'docs/runbooks/spec-kit.md';
const RUNBOOK = `${INVENTORY}#upgrading-spec-kit`;

/**
 * Deliberate edits to files Spec Kit owns. Every entry must also appear in the inventory runbook.
 * `marker` is a string the local version carries and upstream does not: a file that lost it, or
 * that matches its manifest hash again, has been reverted by an upgrade. Add an entry in the same
 * PR as the edit; an unregistered edit fails the gate (unregistered-edit).
 */
export const LOCAL_EDITS = [
  {
    file: '.claude/skills/speckit-taskstoissues/SKILL.md',
    marker: 'scripts/backlog.mjs',
    why: 'fans tasks out to the Forgejo backlog through scripts/backlog.mjs, not GitHub issues (feature 049)',
  },
  {
    file: '.claude/skills/speckit-tasks/SKILL.md',
    marker: '**Tests are REQUIRED**',
    why: 'makes test tasks required in the TDD checkpoint format; upstream says tests are optional, which would cancel the override',
  },
];
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

/** The override's sample test pair must show both checkpoints and point at the format's source. */
const tddProblems = (text) => [
  ...TDD_MARKERS.filter((m) => !text.includes(m)).map((m) => `no ${m} checkpoint`),
  ...(text.includes(TDD_TEMPLATE) ? [] : [`no pointer to ${TDD_TEMPLATE}`]),
];

/** A managed file matches upstream if its bytes, LF- or CRLF-normalised, hash to the manifest. */
function matchesManifest(text, want) {
  const lf = text.replace(/\r\n/g, '\n');
  return sha256(lf) === want || sha256(lf.replace(/\n/g, '\r\n')) === want;
}

function readManifests(root) {
  const dir = join(root, INTEGRATIONS_DIR);
  if (!existsSync(dir)) return null;
  const files = new Map();
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.manifest.json')).sort()) {
    try {
      for (const [file, hash] of Object.entries(JSON.parse(readFileSync(join(dir, name), 'utf8')).files ?? {})) {
        files.set(file, hash);
      }
    } catch {
      // An unreadable manifest is Spec Kit's problem; the files it would list are simply unchecked.
    }
  }
  return files;
}

/** Managed-file edits: unregistered, reverted, or registered for a file no manifest lists. */
function localEditFailures(root, localEdits) {
  const manifest = readManifests(root);
  if (manifest === null) return [];
  const failures = [];
  const registered = new Map(localEdits.map((e) => [e.file, e]));
  for (const [file, want] of manifest) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8');
    const pristine = matchesManifest(text, want);
    const edit = registered.get(file);
    if (edit && (pristine || !text.includes(edit.marker))) {
      failures.push({
        code: 'local-edit-reverted',
        message: `${file} has lost its local edit (${edit.why}): ${pristine ? 'it matches the upstream manifest hash again' : `it no longer contains "${edit.marker}"`} — re-apply the edit from git history`,
      });
    } else if (!edit && !pristine) {
      failures.push({
        code: 'unregistered-edit',
        message: `${file} differs from its Spec Kit manifest hash but is not a registered local edit — the next \`specify integration upgrade --force\` will silently overwrite it. Register it in LOCAL_EDITS (scripts/check-speckit-overrides.mjs) and in ${INVENTORY}, or restore the upstream file`,
      });
    }
  }
  for (const { file } of localEdits) {
    if (!manifest.has(file)) {
      failures.push({
        code: 'registry-stale',
        message: `${file} is registered as a local edit but no ${INTEGRATIONS_DIR}/*.manifest.json lists it — Spec Kit no longer manages it; drop the entry from LOCAL_EDITS and ${INVENTORY}`,
      });
    }
  }
  return failures;
}

/** The inventory runbook must name every customisation this gate guards. */
function inventoryFailure(root, localEdits) {
  const path = join(root, INVENTORY);
  const required = [OVERRIDE_TEMPLATE, TDD_TEMPLATE, ...localEdits.map((e) => e.file)];
  const text = existsSync(path) ? readFileSync(path, 'utf8') : null;
  const missing = text === null ? required : required.filter((f) => !text.includes(f));
  if (!missing.length) return null;
  return {
    code: 'inventory-stale',
    message: text === null
      ? `${INVENTORY} is missing — it is the one list of this repository's Spec Kit customisations`
      : `${INVENTORY} does not name ${missing.join(', ')} — add each to its customisation table`,
  };
}

/**
 * setup-tasks.ps1 hands /speckit-tasks the template twice: as a path (Resolve-Template →
 * TASKS_TEMPLATE) and, since Spec Kit 0.16, as composed content (Resolve-TemplateContent →
 * TASKS_TEMPLATE_CONTENT), which the skill prefers. Both resolvers must be called for
 * tasks-template, and both must check overrides/ first.
 */
const RESOLVERS = ['Resolve-Template', 'Resolve-TemplateContent'];

/**
 * Does each resolver still check overrides/ before anything else? Read as text: the body runs from
 * `function <name>` to the next top-level `function`, and the first `overrides/` reference must
 * precede every presets/extensions reference and the first `return` that yields something. A bare
 * `return $null` (Spec Kit 0.16's template-name validation) resolves nothing, so it cannot fall
 * back to core and is not counted. A harmless upstream refactor can still trip this; the fix is a
 * reviewed edit HERE, never deleting the gate.
 */
function resolutionProblems(common, setup) {
  const problems = [];
  for (const name of RESOLVERS) {
    const call = new RegExp(`${name}\\s+-TemplateName\\s+['"]tasks-template['"]`);
    if (setup === null || !call.test(setup)) {
      problems.push(`${SETUP_TASKS_PS1} no longer resolves tasks-template through ${name}`);
    }
    const fn = common === null ? -1 : common.search(new RegExp(`^function\\s+${name}(?![\\w-])`, 'm'));
    if (fn === -1) {
      problems.push(`${COMMON_PS1} no longer defines ${name}`);
      continue;
    }
    const rest = common.slice(fn + 1);
    const next = rest.search(/^function\s+/m);
    const body = common.slice(fn, next === -1 ? undefined : fn + 1 + next);
    const at = (re) => {
      const i = body.search(re);
      return i === -1 ? Infinity : i;
    };
    const overrides = at(/overrides\//);
    const firstOther = Math.min(at(/presets/), at(/extensions/), at(/\breturn\b(?!\s+\$null\b)/));
    if (overrides === Infinity || overrides > firstOther) {
      problems.push(`${COMMON_PS1} ${name} no longer checks overrides/ first`);
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
export function checkSpeckitOverrides({ root = REPO_ROOT, localEdits = LOCAL_EDITS } = {}) {
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
    const tdd = tddProblems(override);
    if (tdd.length) {
      fail('tdd-format-missing', `${OVERRIDE_TEMPLATE} has lost its TDD checkpoint sample (${tdd.join('; ')}) — generated test tasks would no longer show the constitution's Verify RED / Verify GREEN format`);
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
  const resolution = resolutionProblems(read(COMMON_PS1), read(SETUP_TASKS_PS1));
  if (resolution.length) {
    fail('resolution-broken', `${resolution.join('; ')} — the override would be silently ignored`);
  }
  failures.push(...localEditFailures(root, localEdits));
  const inventory = inventoryFailure(root, localEdits);
  if (inventory) failures.push(inventory);
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
  const tdd = tddProblems(text);
  if (tdd.length) {
    throw new Error(`refusing to record: ${OVERRIDE_TEMPLATE} has lost its Verify RED / Verify GREEN sample (${tdd.join('; ')}) — restore it first`);
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

const REMEDIATION = `Fix: each line above names its own fix. For core-changed, merge the core change into the override, then run node scripts/check-speckit-overrides.mjs --record (never hand-type the hash). Procedure and every failure code: ${RUNBOOK}`;

function scan(root) {
  const r = checkSpeckitOverrides({ root });
  if (r.ok) {
    const fork = parseForkPoint(readFileSync(join(root, OVERRIDE_TEMPLATE), 'utf8').split('\n')[0]);
    console.log(`✓ speckit-overrides gate passed (override present with sweep task and TDD checkpoint sample, core template matches fork point ${fork.sha256.slice(0, 12)}, override-first resolution intact, ${LOCAL_EDITS.length} registered local edit(s) in place and no unregistered ones, inventory ${INVENTORY} complete)`);
    return 0;
  }
  for (const f of r.failures) console.error(`[speckit-overrides] ✗ ${f.code}: ${f.message}`);
  console.error(REMEDIATION);
  return 1;
}

function selftest() {
  const coreBody = '# Tasks\n\n- [ ] T001 Setup\n';
  const tddPair = `- [ ] T003 [US1] Test (${TDD_TEMPLATE})\n  - **Verify RED**: x\n- [ ] T004 [US1] Implement\n  - **Verify GREEN**: x\n`;
  const overrideBody = `${coreBody}- [ ] T002 ${SWEEP_MARKER} — search the docs\n${tddPair}`;
  const [edit] = LOCAL_EDITS;
  const upstream = '# upstream skill\n';
  const managed = (files) => JSON.stringify({ integration: 'claude', files });
  const registered = Object.fromEntries(LOCAL_EDITS.map((e) => [e.file, sha256(upstream)]));
  const clean = {
    [CORE_TEMPLATE]: coreBody,
    [OVERRIDE_TEMPLATE]: `${forkPointLine(sha256(coreBody), '0.11.2')}\n${overrideBody}`,
    [INVENTORY]: [OVERRIDE_TEMPLATE, TDD_TEMPLATE, ...LOCAL_EDITS.map((e) => e.file)].join('\n'),
    [`${INTEGRATIONS_DIR}/claude.manifest.json`]: managed(registered),
    ...Object.fromEntries(LOCAL_EDITS.map((e) => [e.file, `# local skill\n${e.marker}\n`])),
    [COMMON_PS1]: ['Resolve-Template', 'Resolve-TemplateContent']
      .map((n) => `function ${n} {\n  if ($bad) { return $null }\n  $o = Join-Path $b "overrides/$TemplateName.md"\n  if (Test-Path $o) { return $o }\n  $p = Join-Path $r ".specify/presets"\n}\n`)
      .join(''),
    [SETUP_TASKS_PS1]: "$t = Resolve-Template -TemplateName 'tasks-template' -RepoRoot $r\n$c = Resolve-TemplateContent -TemplateName 'tasks-template' -RepoRoot $r\n",
  };
  const scenarios = [
    ['clean', {}, []],
    ['override-missing', { [OVERRIDE_TEMPLATE]: null }, ['override-missing']],
    ['header-invalid', { [OVERRIDE_TEMPLATE]: overrideBody }, ['header-invalid']],
    ['sweep-missing', { [OVERRIDE_TEMPLATE]: `${forkPointLine(sha256(coreBody), '0.11.2')}\n${coreBody}${SWEEP_MARKER} in prose only\n${tddPair}` }, ['sweep-missing']],
    ['tdd-format-missing', { [OVERRIDE_TEMPLATE]: `${forkPointLine(sha256(coreBody), '0.11.2')}\n${coreBody}- [ ] T002 ${SWEEP_MARKER}\n` }, ['tdd-format-missing']],
    ['local-edit-reverted', { [edit.file]: upstream }, ['local-edit-reverted']],
    ['unregistered-edit', {
      [`${INTEGRATIONS_DIR}/claude.manifest.json`]: managed({ ...registered, '.claude/skills/x/SKILL.md': sha256('up\n') }),
      '.claude/skills/x/SKILL.md': 'edited\n',
    }, ['unregistered-edit']],
    ['registry-stale', { [`${INTEGRATIONS_DIR}/claude.manifest.json`]: managed({ ...registered, [edit.file]: undefined }) }, ['registry-stale']],
    ['inventory-stale', { [INVENTORY]: OVERRIDE_TEMPLATE }, ['inventory-stale']],
    ['core-changed', { [CORE_TEMPLATE]: `${coreBody}- [ ] T009 upstream\n` }, ['core-changed']],
    ['setup bypasses Resolve-Template', { [SETUP_TASKS_PS1]: "$t = '.specify/templates/tasks-template.md'\n" }, ['resolution-broken']],
    ['presets before overrides/', { [COMMON_PS1]: 'function Resolve-Template {\n  $p = ".specify/presets"\n  $o = "overrides/x.md"\n}\nfunction Resolve-TemplateContent {\n  $o = "overrides/x.md"\n}\n' }, ['resolution-broken']],
    ['setup bypasses Resolve-TemplateContent', { [SETUP_TASKS_PS1]: "$t = Resolve-Template -TemplateName 'tasks-template' -RepoRoot $r\n" }, ['resolution-broken']],
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
  console.log('✓ speckit-overrides gate --selftest passed (clean tree passes; override-missing, header-invalid, sweep-missing, tdd-format-missing, core-changed, every resolution-broken shape, local-edit-reverted, unregistered-edit, registry-stale and inventory-stale are each detected)');
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

if (isMain(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
