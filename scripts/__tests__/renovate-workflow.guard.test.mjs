// Feature 057 — guards on the dependency bot's workflow that no other gate covers.
//
// Two faults in this pair of files were invisible because nothing checked them, and both were
// asserted correct by a COMMENT rather than by a test:
//
//   #160  The job had no `setup-node`. It is the only workflow in the repository without one, so it
//         silently inherited the runner container's bundled Node 22 while renovate@44.14.12+ declares
//         `engines.node ^24.11.0`. Every run since 2026-08-09 exited 1 on
//         "Unsupported node environment" (measured: run 1704, 2026-08-13).
//
//   #153  `renovate.yml`'s cron and `renovate.json`'s permitted branch-creation window never
//         intersected, so routine updates deferred forever. The cron carried the comment
//         "matches the renovate.json schedule window", which was the bug stated as a fact.
//
//   #194  The customManager that keeps nx.json's `installation.version` in step with package.json's
//         `nx` carried the comment "Both files therefore move in one PR". It was false as configured
//         and every nx bump arrived as a HALF bump (measured: PR #193, 2026-08-14, nx.json 22.7.8 /
//         package.json 22.7.7). Third time in this one pair of files that a COMMENT stood in for a
//         check, which is why the grouping is now asserted below rather than described.
//
// Correcting prose fixes today and prevents nothing, so the durable artifact is this test.
// Pure file parsing — no network, no bot, no runner.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = resolve(REPO_ROOT, '.forgejo/workflows/renovate.yml');
const CONFIG = resolve(REPO_ROOT, 'renovate.json');

const workflow = parseYaml(readFileSync(WORKFLOW, 'utf8'));
const steps = workflow?.jobs?.renovate?.steps ?? [];
const config = JSON.parse(readFileSync(CONFIG, 'utf8'));

/**
 * Standard and daylight offsets for the bot's declared timezone, as hours to ADD to local time to
 * reach UTC. Hard-coded rather than derived because the whole point is to check both halves of the
 * year at once, which a single `Intl` lookup at test time cannot do — it would silently only ever
 * exercise whichever offset is in force on the day the suite runs.
 */
const TIMEZONE_OFFSETS = { 'America/New_York': { EDT: 4, EST: 5 } };

/** Expand one cron field over `min..max`. Supports `*`, `N`, `A-B` and comma lists — and nothing else. */
function expandCronField(field, min, max) {
  const values = new Set();
  for (const part of field.split(',')) {
    if (part === '*') {
      for (let v = min; v <= max; v += 1) values.add(v);
    } else if (/^\d+$/.test(part)) {
      values.add(Number(part));
    } else if (/^\d+-\d+$/.test(part)) {
      const [lo, hi] = part.split('-').map(Number);
      for (let v = lo; v <= hi; v += 1) values.add(v);
    } else {
      // Loudly, rather than quietly treating an unhandled form as "matches nothing" — a guard that
      // silently skips the expression it cannot read is the fault this file exists to prevent.
      throw new Error(`unsupported cron field '${part}' — extend expandCronField before using it`);
    }
  }
  return values;
}

/** The set of `dayOfWeek:hour` slots a 5-field cron expression fires in. Day 0 = Sunday. */
function cronSlots(expression) {
  const fields = expression.trim().split(/\s+/);
  assert.equal(fields.length, 5, `expected a 5-field cron expression, got '${expression}'`);
  const [, hourField, , , dowField] = fields;
  const slots = new Set();
  for (const dow of expandCronField(dowField, 0, 6)) {
    for (const hour of expandCronField(hourField, 0, 23)) slots.add(`${dow}:${hour}`);
  }
  return slots;
}

/** The same slot set for a LOCAL-time window, shifted into UTC by `offsetHours` (with day rollover). */
function windowSlotsInUtc(expression, offsetHours) {
  const slots = new Set();
  for (const slot of cronSlots(expression)) {
    const [dow, hour] = slot.split(':').map(Number);
    const shifted = hour + offsetHours;
    slots.add(`${(dow + Math.floor(shifted / 24) + 7) % 7}:${((shifted % 24) + 24) % 24}`);
  }
  return slots;
}

test('the renovate job pins its own Node rather than inheriting the container runtime', () => {
  const nodeIndex = steps.findIndex((s) => typeof s?.uses === 'string' && s.uses.includes('actions/setup-node'));
  assert.notEqual(
    nodeIndex,
    -1,
    'renovate.yml has no actions/setup-node step, so the job runs on whatever Node the runner container bundles',
  );

  const nodeStep = steps[nodeIndex];
  const pinned = nodeStep.with?.['node-version'];
  assert.ok(
    pinned !== undefined && String(pinned).trim() !== '',
    'the setup-node step declares no explicit node-version, which reintroduces the inherited-runtime fault it exists to fix',
  );

  // Corepack is provisioned from whichever Node is on PATH, so ordering is the requirement rather
  // than a preference: installing Node after `corepack enable` leaves corepack bound to Node 22.
  const corepackIndex = steps.findIndex((s) => typeof s?.run === 'string' && s.run.includes('corepack enable'));
  assert.notEqual(corepackIndex, -1, 'expected a corepack enable step to order the Node install against');
  assert.ok(
    nodeIndex < corepackIndex,
    `setup-node must precede corepack enable (found setup-node at step ${nodeIndex}, corepack at ${corepackIndex})`,
  );
});

test('scheduled lock file maintenance is enabled and carries its OWN explicit window', () => {
  // Feature 058 / item #184. THE MEASURED FAULT: Renovate proposes only when the current RANGE does
  // not satisfy the newest version, and it reasons about the MANIFEST range rather than the lockfile
  // resolution. So an override whose range already permits a published fix looks already-fixed to it
  // while the lockfile stays pinned below — and nothing is proposed at all.
  //
  //   fast-uri  override >=3.1.4 <4 permitted 3.1.5, lockfile pinned 3.1.4.
  //             fix published 2026-07-31, advisory 2026-08-03, gate red TEN DAYS,
  //             and a four-week acceptance written — for what a lockfile refresh would have cleared.
  //   nanoid    the same shape, eight days later, reddening main.
  //
  // `lockFileMaintenance` is the direct remedy: it refreshes WITHIN existing ranges, so a transitive
  // fix an override already permits gets picked up with no config change and no human in the loop.
  //
  // AND THE OBVIOUS WAY TO ENABLE IT SILENTLY DOES NOTHING. Verified against renovate@44.29.3's own
  // config resolver, not from documentation: the option's DEFAULT object already carries
  // `schedule: ["before 4am on monday"]`, and a child config's value beats the inherited top-level
  // `schedule`. Measured:
  //
  //   defaults only                                        -> ["before 4am on monday"]
  //   top-level schedule + lockFileMaintenance{enabled}     -> ["before 4am on monday"]   <-- THE TRAP
  //   ... + lockFileMaintenance{schedule}                   -> ["* 2-4 * * 5"]
  //
  // "before 4am on monday" in America/New_York is Monday 04:00-08:00 UTC (EDT) / 05:00-09:00 (EST).
  // The crons are `0 3 * * *` and `0 7 * * 5`. NEITHER intersects under EITHER offset — so enabling
  // it without its own key yields a feature that is ON and can NEVER FIRE, reporting nothing. That
  // is #153 exactly: the fault feature 057 existed to fix, in a new place.
  const lfm = config.lockFileMaintenance;
  assert.ok(
    lfm && lfm.enabled === true,
    'renovate.json does not enable lockFileMaintenance, so nothing refreshes the lockfile on a ' +
      'schedule. A transitive fix already permitted by an override range will be proposed by ' +
      'NOTHING — which is the fast-uri/nanoid failure, not a hypothetical one.',
  );
  assert.ok(
    Array.isArray(lfm.schedule) && lfm.schedule.length > 0,
    'lockFileMaintenance is enabled but declares NO schedule of its own, so it inherits the option ' +
      "default [\"before 4am on monday\"] — NOT the top-level `schedule` key, which does not " +
      'propagate here. That window intersects neither workflow cron under either DST offset, so the ' +
      'refresh is enabled and can never run, and nothing reports it. Declare the window explicitly.',
  );
});

test('the lock file maintenance window intersects a workflow cron under BOTH DST offsets', () => {
  // Same arithmetic as the branch-creation window below, applied to the second schedule. Split into
  // its own test so a failure names WHICH window drifted — the two are independent and either can
  // rot alone.
  const crons = (workflow?.on?.schedule ?? []).map((entry) => entry.cron);
  const offsets = TIMEZONE_OFFSETS[config.timezone];
  assert.ok(offsets, `unknown timezone '${config.timezone}' — add it to TIMEZONE_OFFSETS`);

  const windows = config.lockFileMaintenance?.schedule ?? [];
  assert.ok(windows.length > 0, 'lockFileMaintenance declares no schedule (see the test above)');

  for (const [label, offsetHours] of Object.entries(offsets)) {
    const permitted = new Set();
    for (const window of windows) {
      for (const slot of windowSlotsInUtc(window, offsetHours)) permitted.add(slot);
    }
    const intersecting = crons.filter((cron) => [...cronSlots(cron)].some((slot) => permitted.has(slot)));
    assert.ok(
      intersecting.length > 0,
      `under ${label} (UTC+${offsetHours} from ${config.timezone}) no workflow cron fires inside the ` +
        'lockFileMaintenance window.\n' +
        `  workflow crons (UTC):        ${crons.join(' , ')}\n` +
        `  lockFileMaintenance window:  ${windows.join(' , ')} @ ${config.timezone}\n` +
        `  permitted UTC dow:hour:      ${[...permitted].sort().join(' ')}\n` +
        '  The refresh is enabled and the bot is never awake inside its window, so the lockfile is ' +
        'never refreshed and nothing says so.',
    );
  }
});

test('a workflow cron falls inside the permitted branch-creation window under BOTH DST offsets', () => {
  const crons = (workflow?.on?.schedule ?? []).map((entry) => entry.cron);
  assert.ok(crons.length > 0, 'renovate.yml declares no scheduled trigger at all');

  const offsets = TIMEZONE_OFFSETS[config.timezone];
  assert.ok(
    offsets,
    `renovate.json declares timezone '${config.timezone}', whose offsets this guard does not know — add them to TIMEZONE_OFFSETS`,
  );

  const windows = config.schedule ?? [];
  assert.ok(windows.length > 0, 'renovate.json declares no schedule window');

  // Forgejo/GitHub Actions cron is UTC-only and does NOT observe daylight saving, so a trigger that
  // lands inside the window in summer can fall outside it in winter. Both halves must hold, or the
  // bot goes quiet for half the year in a way nothing reports.
  for (const [label, offsetHours] of Object.entries(offsets)) {
    const permitted = new Set();
    for (const window of windows) {
      for (const slot of windowSlotsInUtc(window, offsetHours)) permitted.add(slot);
    }

    const intersecting = crons.filter((cron) => [...cronSlots(cron)].some((slot) => permitted.has(slot)));
    assert.ok(
      intersecting.length > 0,
      `under ${label} (UTC+${offsetHours} from ${config.timezone}) no workflow cron fires inside the permitted window.\n` +
        `  workflow crons (UTC):   ${crons.join(' , ')}\n` +
        `  renovate.json schedule: ${windows.join(' , ')} @ ${config.timezone}\n` +
        `  permitted UTC dow:hour: ${[...permitted].sort().join(' ')}\n` +
        '  The bot is never awake inside its own window, so every non-security update defers forever.',
    );
  }
});

// ---------------------------------------------------------------------------------------------
// Item #194 — nx must be proposed as ONE unit, across BOTH managers and BOTH update tracks.
// ---------------------------------------------------------------------------------------------
//
// nx lives in two files and Renovate reads them with two DIFFERENT managers:
//
//   nx.json      installation.version   <- the `customManagers` regex entry, manager `custom.regex`
//   package.json devDependencies.nx     <- the built-in `npm` manager
//
// The Nx WRAPPER wins at runtime, so a bump that moves only one of them makes the manifest fiction:
// PR #141 moved package.json and not nx.json; PR #193 moved nx.json and not package.json.
//
// THE MECHANISM, measured against renovate@44.30.0's own `applyPackageRules` rather than reasoned
// about (`config:recommended` -> `group:monorepos` puts BOTH halves in `nx monorepo` by sourceUrl):
//
//   before the fix   nx.json half   -> "nx monorepo"        package.json half -> "js patch/minor"
//                    ... and on the major track            package.json half -> "js majors (review individually)"
//
// The `js patch/minor` and `js majors` rules match `matchManagers: ["npm"]`. A customManager's
// manager is `custom.regex`, NOT `npm` — renovate@44's ManagersMatcher matches custom managers as
// `custom.${manager}`. Because LATER packageRules override earlier ones, those two rules pulled only
// the package.json half back out of the shared group, onto its own branch. Two groups, two branches,
// one half-bump — from the manager that existed to prevent exactly that.
//
// This guard models the one semantic that matters, "later rules win", over the repository's OWN
// packageRules. It deliberately does NOT credit the upstream `group:monorepos` preset: relying on an
// external preset to hold this pair together is what the fix replaced, and a preset can change under
// us without a commit here. So the requirement asserted is stronger than Renovate's resolved answer —
// this repository's config must state the grouping itself.

/** The repo's own packageRules only — presets are deliberately excluded (see above). */
const packageRules = config.packageRules ?? [];

/**
 * Does one packageRule match a dependency? Models only the `match*` forms this config actually uses,
 * and THROWS on any it does not know — a guard that silently treats an unrecognised matcher as
 * "no match" would quietly stop asserting the moment someone adds a rule form, which is the failure
 * mode this whole file exists to prevent.
 */
function ruleMatches(rule, dep) {
  const known = new Set([
    'description',
    'matchManagers',
    'matchPackageNames',
    'matchUpdateTypes',
    'matchDatasources',
    'matchFileNames',
    'groupName',
    'automerge',
    'enabled',
    'minimumReleaseAge',
    'prPriority',
    'matchCurrentVersion',
    'dependencyDashboardApproval',
    'allowedVersions',
    // Feature 063 / item #297. Added here FIRST and on its own, because this set is deliberately
    // fail-closed: the moment `versioning` appears in renovate.json, every one of the 43 assertions
    // in this file throws on the unknown key rather than on its own subject. Teaching the model the
    // key changes no behaviour and asserts nothing new — it is what lets the assertions below say
    // anything at all.
    'versioning',
  ]);
  for (const key of Object.keys(rule)) {
    if (!known.has(key)) {
      throw new Error(
        `packageRule uses '${key}', which this guard does not model — extend ruleMatches() before ` +
          'adding it, or the nx grouping assertion below silently stops meaning anything.',
      );
    }
  }

  const matchesName = (pattern, value) => {
    if (pattern === '*') return true;
    if (pattern.startsWith('!')) {
      throw new Error(
        `matchPackageNames negation '${pattern}' is not modelled — extend ruleMatches() before using it.`,
      );
    }
    if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
      return new RegExp(pattern.slice(1, pattern.lastIndexOf('/'))).test(value);
    }
    return pattern === value;
  };

  if (rule.matchManagers && !rule.matchManagers.includes(dep.manager)) return false;
  if (rule.matchDatasources && !rule.matchDatasources.includes(dep.datasource)) return false;
  if (rule.matchUpdateTypes && !rule.matchUpdateTypes.includes(dep.updateType)) return false;
  if (rule.matchCurrentVersion) {
    // Only the one form this config uses. Anything else must be modelled before it is used, or the
    // rule silently matches everything — the same fail-open shape as an unknown label name.
    if (rule.matchCurrentVersion !== '<1.0.0') {
      throw new Error(`matchCurrentVersion '${rule.matchCurrentVersion}' is not modelled — extend ruleMatches().`);
    }
    if (dep.currentVersion === undefined) return false;
    if (!/^0\./.test(dep.currentVersion)) return false;
  }
  if (rule.matchFileNames && !rule.matchFileNames.includes(dep.packageFile)) return false;
  if (rule.matchPackageNames && !rule.matchPackageNames.some((p) => matchesName(p, dep.depName))) return false;
  return true;
}

/** The group a dep ends up in: the LAST matching rule that names one wins, as Renovate resolves it. */
function resolvedGroupName(dep) {
  let groupName = null;
  for (const rule of packageRules) {
    if (!ruleMatches(rule, dep)) continue;
    if (rule.groupName !== undefined) groupName = rule.groupName;
  }
  return groupName;
}

// The nx family as the pipeline presents it. The two HALVES are the pair item #194 is about; the
// @nx/* PLUGINS are here because grouping only `nx` would have fixed the half-bump by splitting the
// Nx core from its own plugins instead — core in `nx monorepo`, plugins left in `js patch/minor` —
// which is the same defect wearing a different pair.
//
// `manager: 'custom.regex'` is how renovate@44's ManagersMatcher sees a customManager (it matches
// `custom.${manager}`), and matching on the dep NAME is faithful because fetch.js normalises
// `dep.packageName ??= dep.depName` BEFORE applying package rules — verified, because
// `matchPackageNames` reads packageName and matches NOTHING when it is absent, so a rule that looked
// correct would silently never fire.
const NX_FAMILY = [
  { label: 'nx.json installation.version', manager: 'custom.regex', packageFile: 'nx.json', depName: 'nx' },
  { label: 'package.json nx', manager: 'npm', packageFile: 'package.json', depName: 'nx' },
  { label: 'package.json @nx/expo', manager: 'npm', packageFile: 'package.json', depName: '@nx/expo' },
  { label: 'package.json @nx/playwright', manager: 'npm', packageFile: 'package.json', depName: '@nx/playwright' },
];

for (const updateType of ['patch', 'minor', 'major']) {
  test(`the whole nx family is proposed in ONE group on the ${updateType} track`, () => {
    const groups = NX_FAMILY.map((member) => ({
      ...member,
      groupName: resolvedGroupName({ ...member, datasource: 'npm', updateType }),
    }));

    const shown = groups
      .map((g) => `    ${g.label.padEnd(30)} manager=${g.manager.padEnd(13)} group=${JSON.stringify(g.groupName)}`)
      .join('\n');

    for (const g of groups) {
      assert.notEqual(
        g.groupName,
        null,
        `on the ${updateType} track, no packageRule in renovate.json groups ${g.label}:\n${shown}\n` +
          '  An ungrouped member gets its OWN branch, so nx arrives as a half-bump and ' +
          'check-toolchain-consistency.mjs reds the `naming` job. Item #194.',
      );
    }

    const distinct = [...new Set(groups.map((g) => g.groupName))];
    assert.equal(
      distinct.length,
      1,
      `on the ${updateType} track the nx family resolves to ${distinct.length} DIFFERENT groups:\n${shown}\n` +
        '  Different groups means different branches. For the nx.json/package.json pair that is a HALF\n' +
        '  BUMP — the two disagreeing makes the manifest fiction, because the Nx WRAPPER is what\n' +
        '  actually runs (PR #193 moved nx.json alone; PR #141 moved package.json alone). For the\n' +
        '  @nx/* plugins it splits the Nx core from its plugins across two PRs.\n' +
        "  The usual cause is a rule matching only `npm`: a customManager's manager is `custom.regex`,\n" +
        '  and LATER rules win, so a broad npm rule placed after the nx rule pulls those halves back\n' +
        '  out. Item #194.',
    );
  });
}

test('the nx grouping rule does NOT swallow unrelated npm packages', () => {
  // The control. Without this, widening the nx rule until everything landed in one group would pass
  // every assertion above while quietly collapsing `js patch/minor` into `nx monorepo` — a guard that
  // only checks "these are together" cannot tell grouping from a blanket override.
  for (const updateType of ['patch', 'minor', 'major']) {
    const group = resolvedGroupName({
      manager: 'npm',
      packageFile: 'package.json',
      depName: 'typescript',
      datasource: 'npm',
      updateType,
    });
    assert.notEqual(
      group,
      'nx monorepo',
      `typescript resolves to the nx group on the ${updateType} track, so the nx rule is matching far ` +
        'more than nx — every unrelated JS dep would ride along in the nx PR.',
    );
  }
});

test('the nx grouping rule covers both managers and is ordered LAST of the rules that group nx', () => {
  // The two failure modes the assertions above catch only implicitly, named here so a breakage says
  // which one happened rather than just "the groups differ".
  const nxRules = packageRules.filter((rule) =>
    ruleMatches(rule, { manager: 'npm', packageFile: 'package.json', depName: 'nx', datasource: 'npm', updateType: 'minor' }) &&
    rule.groupName !== undefined,
  );
  assert.ok(nxRules.length > 0, 'no packageRule assigns nx a groupName at all');

  const last = nxRules[nxRules.length - 1];
  assert.ok(
    Array.isArray(last.matchManagers) &&
      last.matchManagers.includes('npm') &&
      last.matchManagers.includes('custom.regex'),
    'the LAST rule to group nx is\n' +
      `  ${JSON.stringify({ matchManagers: last.matchManagers, matchPackageNames: last.matchPackageNames, groupName: last.groupName })}\n` +
      '  which does not match BOTH managers. It must match `npm` (package.json) and `custom.regex`\n' +
      '  (nx.json, via the customManagers entry) or it groups one half and strands the other.',
  );
  assert.equal(
    last.matchUpdateTypes,
    undefined,
    'the nx grouping rule restricts matchUpdateTypes, so at least one update track falls through to\n' +
      '  the broad npm rules and half-bumps. The major track splits identically (nx v23 showed as both\n' +
      '  `major-js-majors-(review-individually)` and `major-nx-monorepo` on the dashboard) — leave it\n' +
      '  unrestricted so it covers every track.',
  );

  // The rule is only meaningful while the customManager it re-joins still exists.
  const nxManager = (config.customManagers ?? []).find((m) => m.depNameTemplate === 'nx');
  assert.ok(
    nxManager,
    'renovate.json has no customManager with depNameTemplate "nx", so nx.json\'s installation.version\n' +
      '  is not read at all and only package.json moves — PR #141 exactly.',
  );
  assert.ok(
    (nxManager.managerFilePatterns ?? []).some((p) => p.includes('nx\\.json')),
    'the nx customManager no longer targets nx.json',
  );
});

// ---------------------------------------------------------------------------------------------
// Item #204 — the Playwright pair must be proposed as ONE unit, for the same reason nx must.
// ---------------------------------------------------------------------------------------------
//
// Playwright lives in two files that Renovate reads with two DIFFERENT managers:
//
//   pnpm-lock.yaml            @playwright/test          <- the built-in `npm` manager
//   .forgejo/workflows/       mcr.microsoft.com/        <- a `customManagers` regex entry,
//     app-ci.yml                playwright:v<x>-noble      manager `custom.regex`
//
// The image TAG selects the baked browser build. On PR #199 (2026-08-15) a lock-file-maintenance PR
// moved the lockfile 1.60.0 -> 1.62.1 and left both tags at v1.60.0-noble: the browser was not at
// the path the runner looked in, ZERO tests ran, and the suite reported no counts at all rather than
// failures. That is worse than a break — `failed=0 passed=0` is only distinguishable from success by
// a gate that knows to look.
//
// The SAME splitting mechanism as nx applies here, so the same assertions are needed: `js
// patch/minor` and `js majors` match `matchManagers: ["npm"]`, a customManager's manager is
// `custom.regex`, and LATER rules win — so a grouping rule placed before them has its npm half
// pulled straight back out onto its own branch.

const PLAYWRIGHT_PAIR = [
  { label: 'app-ci.yml image tag', manager: 'custom.regex', packageFile: '.forgejo/workflows/app-ci.yml', depName: '@playwright/test' },
  { label: 'pnpm-lock @playwright/test', manager: 'npm', packageFile: 'package.json', depName: '@playwright/test' },
];

for (const updateType of ['patch', 'minor', 'major']) {
  test(`both halves of the Playwright pin are proposed in ONE group on the ${updateType} track`, () => {
    const groups = PLAYWRIGHT_PAIR.map((member) => ({
      ...member,
      groupName: resolvedGroupName({ ...member, datasource: 'npm', updateType }),
    }));

    const shown = groups
      .map((g) => `    ${g.label.padEnd(28)} manager=${g.manager.padEnd(13)} group=${JSON.stringify(g.groupName)}`)
      .join('\n');

    for (const g of groups) {
      assert.notEqual(
        g.groupName,
        null,
        `on the ${updateType} track, no packageRule in renovate.json groups ${g.label}:\n${shown}\n` +
          '  An ungrouped member gets its OWN branch, so the image tag and the lockfile can land in\n' +
          '  separate PRs — and the drifted half runs ZERO tests rather than failing. Item #204.',
      );
    }

    const distinct = [...new Set(groups.map((g) => g.groupName))];
    assert.equal(
      distinct.length,
      1,
      `on the ${updateType} track the Playwright pair resolves to ${distinct.length} DIFFERENT groups:\n${shown}\n` +
        '  Different groups means different branches, which is a half-bump: the image tag selects the\n' +
        '  baked browser build, so a lockfile that moves without it produces `failed=0 passed=0` and\n' +
        "  a generic \"app-e2e failed\" 35 minutes later (PR #199).\n" +
        "  The usual cause is a rule matching only `npm`: a customManager's manager is `custom.regex`,\n" +
        '  and LATER rules win, so a broad npm rule placed after this one pulls the lockfile half back\n' +
        '  out. Item #204.',
    );
  });
}

test('the Playwright grouping rule covers both managers and is ordered LAST of the rules that group it', () => {
  const rules = packageRules.filter((rule) =>
    ruleMatches(rule, { manager: 'npm', packageFile: 'package.json', depName: '@playwright/test', datasource: 'npm', updateType: 'minor' }) &&
    rule.groupName !== undefined,
  );
  assert.ok(rules.length > 0, 'no packageRule assigns @playwright/test a groupName at all');

  const last = rules[rules.length - 1];
  assert.ok(
    Array.isArray(last.matchManagers) &&
      last.matchManagers.includes('npm') &&
      last.matchManagers.includes('custom.regex'),
    'the LAST rule to group @playwright/test is\n' +
      `  ${JSON.stringify({ matchManagers: last.matchManagers, matchPackageNames: last.matchPackageNames, groupName: last.groupName })}\n` +
      '  which does not match BOTH managers. It must match `npm` (pnpm-lock.yaml) and `custom.regex`\n' +
      '  (app-ci.yml, via the customManagers entry) or it groups one half and strands the other.',
  );
  assert.equal(
    last.matchUpdateTypes,
    undefined,
    'the Playwright grouping rule restricts matchUpdateTypes, so at least one update track falls\n' +
      '  through to the broad npm rules and half-bumps. Leave it unrestricted so it covers every track,\n' +
      '  exactly as the nx rule does.',
  );

  // The rule is only meaningful while the customManager it re-joins still exists.
  const manager = (config.customManagers ?? []).find((m) => m.depNameTemplate === '@playwright/test');
  assert.ok(
    manager,
    'renovate.json has no customManager with depNameTemplate "@playwright/test", so the image tag in\n' +
      '  app-ci.yml is extracted by NOTHING — the github-actions manager reads `uses:` and container\n' +
      '  images, not an image inside a `run:` shell block. Only the lockfile half would move.',
  );
  assert.ok(
    (manager.managerFilePatterns ?? []).some((p) => p.includes('app-ci')),
    'the Playwright customManager no longer targets .forgejo/workflows/app-ci.yml',
  );
  assert.equal(
    manager.datasourceTemplate,
    'npm',
    'the Playwright customManager must use the npm datasource so both halves carry ONE depName and a\n' +
      '  single matchPackageNames re-joins them. A docker datasource splits the pair\'s name and drags\n' +
      '  the tag into the `docker base images` group and `docker:pinDigests`.',
  );
});

test('the Playwright grouping rule does NOT swallow @nx/playwright or unrelated npm packages', () => {
  // The control. Without it, widening the rule until everything shared one group would satisfy every
  // assertion above while collapsing the config. @nx/playwright is the specific hazard: it belongs to
  // the nx family, and a `/playwright/` pattern would steal it and split the Nx core from its plugins.
  for (const updateType of ['patch', 'minor', 'major']) {
    const nxPlaywright = resolvedGroupName({
      manager: 'npm', packageFile: 'package.json', depName: '@nx/playwright', datasource: 'npm', updateType,
    });
    assert.equal(
      nxPlaywright,
      'nx monorepo',
      `@nx/playwright resolves to ${JSON.stringify(nxPlaywright)} on the ${updateType} track, not the nx ` +
        'group — the Playwright rule is matching by substring and has stolen an nx plugin.',
    );

    const unrelated = resolvedGroupName({
      manager: 'npm', packageFile: 'package.json', depName: 'typescript', datasource: 'npm', updateType,
    });
    assert.notEqual(
      unrelated,
      resolvedGroupName({ manager: 'npm', packageFile: 'package.json', depName: '@playwright/test', datasource: 'npm', updateType }),
      `typescript shares the Playwright group on the ${updateType} track, so the rule matches far more ` +
        'than Playwright and every unrelated JS dep would ride along in its PR.',
    );
  }
});

// ---------------------------------------------------------------------------------------------
// Item #218 — the queue must DRAIN, not merely be permitted to move.
//
// Both assertions below exist because the config can be entirely valid, land inside its window, and
// still propose nothing for the tail of the queue. That is not hypothetical: between 2026-08-13 and
// 2026-08-22 the bot ran inside its window twice and `lockFileMaintenance` — the channel that clears
// a CVE finding the manifest range ALREADY permits — never once produced a branch. The single PR it
// ever produced (#199) came from a human ticking `unlimit-branch` on the Dependency Dashboard.
//
// Measured against renovate@44's own dist, byte-identical 44.30.3 (which created #199) → 44.39.2:
//
//   workers/repository/process/sort.js
//     sortOrder = ["pin","digest","patch","minor","major","lockFileMaintenance"]
//     `lockFileMaintenance` is LAST — behind even majors. Only isVulnerabilityAlert or a positive
//     prPriority moves it.
//
//   workers/global/limits.js → handleConcurrentLimits()
//     the hourly PR limit is checked FIRST, for EVERY key, so spending prHourlyLimit also makes
//     isLimitReached("Branches") true.
//
//   workers/repository/update/branch/index.js:148
//     !branchExists && isLimitReached("Branches") → returns "branch-limit-reached" BEFORE the branch
//     is created. A crowded-out update therefore leaves NOTHING behind, and the six nightly runs that
//     follow cannot resume it — they return "not-scheduled" (:244) before branch creation too.

test('lockFileMaintenance carries a positive prPriority, or Renovate sorts it dead last', () => {
  const rules = packageRules.filter(
    (rule) =>
      rule.prPriority !== undefined &&
      Array.isArray(rule.matchUpdateTypes) &&
      rule.matchUpdateTypes.includes('lockFileMaintenance'),
  );

  assert.equal(
    rules.length,
    1,
    `expected exactly ONE packageRule setting prPriority for lockFileMaintenance, found ${rules.length}.\n` +
      "  Renovate's sortOrder hard-codes lockFileMaintenance LAST, behind even majors, so without a\n" +
      '  positive prPriority it is reached only in a week when nothing else is pending — which has\n' +
      '  never happened here. Two rolling groups (cargo-deps, js-patchminor) regenerate weekly and\n' +
      '  sort ahead of it.\n' +
      '  NOTE: prPriority is `parents: ["packageRules"]` — setting it inside the lockFileMaintenance\n' +
      '  block instead looks right and is SILENTLY INERT.',
  );

  const [rule] = rules;
  assert.ok(
    Number.isInteger(rule.prPriority) && rule.prPriority > 0,
    `the lockFileMaintenance rule sets prPriority=${JSON.stringify(rule.prPriority)}, which does not ` +
      'outrank the default 0 that every routine update carries.',
  );

  assert.equal(
    config.lockFileMaintenance?.prPriority,
    undefined,
    'lockFileMaintenance.prPriority is set. That is the plausible-looking placement and it does NOT\n' +
      '  work: prPriority is parents:["packageRules"], so Renovate ignores it there. It IS reported by\n' +
      '  renovate-config-validator (WARN, exit 1) — but NOTHING in CI runs that validator, so this\n' +
      '  assertion is what actually catches it. Move it to a packageRules entry with matchUpdateTypes.',
  );
  assert.equal(
    rule.matchPackageNames,
    undefined,
    'the lockFileMaintenance rule narrows by matchPackageNames. A lockFileMaintenance upgrade is\n' +
      '  built by updates/flatten.js with NO dep attached, so matchPackageNames matches nothing and\n' +
      '  the rule never fires — the failure this whole item is about, in a new place.',
  );
});

test('the weekly PR budget reaches past the rolling groups that sort ahead of the tail', () => {
  // The two rolling groups are proposed essentially every week and sort as patch/minor, i.e. ahead
  // of majors and of lockFileMaintenance. A budget of 2 is spent on exactly those two, every week,
  // for ever. The floor is 2 (them) + 1 (lockFileMaintenance) + 1 (any one of the standing tail),
  // which is what makes the queue drain rather than merely rotate.
  const ROLLING_GROUPS_PLUS_HEADROOM = 4;

  assert.ok(
    Number.isInteger(config.prHourlyLimit) && config.prHourlyLimit >= ROLLING_GROUPS_PLUS_HEADROOM,
    `prHourlyLimit is ${JSON.stringify(config.prHourlyLimit)}, below the floor of ` +
      `${ROLLING_GROUPS_PLUS_HEADROOM}.\n` +
      '  This limit does NOT only gate PR creation: handleConcurrentLimits() checks it first for\n' +
      '  every key, so spending it also blocks BRANCH creation, and a starved update leaves nothing\n' +
      '  behind for a later run to finish. With one in-window run per week, this number IS the\n' +
      "  weekly throughput, and it must exceed the arrival rate or the tail is invisible rather\n" +
      '  than deferred (item #218).',
  );

  assert.ok(
    Number.isInteger(config.prConcurrentLimit) && config.prConcurrentLimit > config.prHourlyLimit,
    `prConcurrentLimit (${JSON.stringify(config.prConcurrentLimit)}) must stay above prHourlyLimit ` +
      `(${JSON.stringify(config.prHourlyLimit)}), or it — not the hourly budget — becomes the binding\n` +
      '  constraint and one run can never spend its allowance. It is deliberately the backstop that\n' +
      '  bounds review debt; raising the hourly budget past it would silently do nothing.',
  );
});

// ---------------------------------------------------------------------------------------------
// Version-lock SCOPE. Both assertions below exist because a lock that is correct but scoped to one
// file is not a lock — and this repository has now paid for that twice.
//
// renovate.json already records the first: "React is version-locked to the Expo SDK across the WHOLE
// workspace, not just the app… the previous app-only ignore let Renovate bump those two, splitting
// React." That fix was applied to react/react-dom/react-test-renderer and `react-native` ITSELF was
// left behind in the app-scoped rule. Measured 2026-08-21, PR #217: react-native 0.85.3 -> 0.87.0 in
// packages/design-system/package.json, which the app-scoped rule does not reach. RN 0.87 narrowed the
// press-event type and produced 15 typecheck errors.
//
// The property being asserted is deliberately "what does this dep resolve to IN EACH package file",
// not "does a rule mentioning react-native exist" — the broken config would have passed the latter.

/** The `enabled` a dep resolves to: last matching rule that sets one wins, as Renovate resolves it. */
/**
 * The version ceiling a dep ends up under: the LAST matching rule that names one wins, as Renovate
 * resolves it. `null` means unconstrained — which is the correct answer for almost every dep, and is
 * what the control test asserts so a widened rule cannot pass unnoticed.
 */
function resolvedAllowedVersions(dep) {
  let allowed = null;
  for (const rule of packageRules) {
    if (!ruleMatches(rule, dep)) continue;
    if (rule.allowedVersions !== undefined) allowed = rule.allowedVersions;
  }
  return allowed;
}

function resolvedEnabled(dep) {
  let enabled = true;
  for (const rule of packageRules) {
    if (!ruleMatches(rule, dep)) continue;
    if (rule.enabled !== undefined) enabled = rule.enabled;
  }
  return enabled;
}

/**
 * The versioning scheme a dep ends up under: the LAST matching rule that names one wins, as Renovate
 * resolves it. `null` means "not overridden", which is the correct answer for every docker dep whose
 * tags are semver-shaped — Renovate's own `docker` default reads those, and stating a scheme for them
 * would be noise pretending to be rigour. Only the date-tagged family needs an override (feature 063).
 */
function resolvedVersioning(dep) {
  let versioning = null;
  for (const rule of packageRules) {
    if (!ruleMatches(rule, dep)) continue;
    if (rule.versioning !== undefined) versioning = rule.versioning;
  }
  return versioning;
}

const RN_FAMILY = ['react-native', 'react-native-reanimated', 'react-native-worklets', '@react-native/babel-preset'];
// The Expo SDK companions. The three UNPREFIXED names are the point: `expo`, `/^expo-/` and
// `/^@expo//` — every pattern the app-scoped rule carries — miss all three, so they were locked in no
// manifest at all. @expo/dom-webview is here because it is declared in pnpm-workspace.yaml, which a
// matchFileNames rule scoped to the app cannot reach. Measured 2026-08-27 on item #29: all four were
// queued in `js majors` for 56 -> 57 while `expo` itself stayed pinned at ^56.0.8.
const EXPO_FAMILY = ['expo', 'expo-router', '@expo/dom-webview', 'babel-preset-expo', 'jest-expo', 'eslint-config-expo'];
// NOT SDK-pinned and must stay updatable — asserted so a future widening of the Expo lock cannot
// swallow them silently. `/^@expo//` needs a slash after `@expo`; these separate with a hyphen.
const EXPO_FALSE_FRIENDS = ['@expo-google-fonts/inter', '@expo-google-fonts/outfit'];
const WORKSPACE_MANIFESTS = [
  'package.json',
  'frontend/mcm-app/package.json',
  'packages/design-system/package.json',
  'pnpm-workspace.yaml',
];

for (const packageFile of WORKSPACE_MANIFESTS) {
  test(`the React Native family is version-locked in ${packageFile}, not just in the app`, () => {
    for (const depName of RN_FAMILY) {
      const enabled = resolvedEnabled({ manager: 'npm', packageFile, depName, datasource: 'npm', updateType: 'minor' });
      assert.equal(
        enabled,
        false,
        `${depName} is UPDATABLE in ${packageFile}.\n` +
          '  RN is version-locked to the Expo SDK across the WHOLE workspace — upgrades go through\n' +
          '  `expo install` / the expo upgrade skill, never a raw Renovate bump. A rule scoped with\n' +
          '  matchFileNames to the app leaves every other manifest open, which is how\n' +
          '  react-native 0.85.3 -> 0.87.0 reached PR #217 via packages/design-system.',
      );
    }
  });
}

for (const packageFile of WORKSPACE_MANIFESTS) {
  test(`the Expo SDK companion family is version-locked in ${packageFile}, not just in the app`, () => {
    for (const depName of EXPO_FAMILY) {
      const enabled = resolvedEnabled({ manager: 'npm', packageFile, depName, datasource: 'npm', updateType: 'major' });
      assert.equal(
        enabled,
        false,
        `${depName} is UPDATABLE in ${packageFile}.\n` +
          '  The Expo SDK companions are version-locked to the SDK across the WHOLE workspace —\n' +
          '  upgrades go through `expo install` / the expo upgrade skill together with `expo` and\n' +
          '  `react-native`, never a raw Renovate bump. babel-preset-expo, jest-expo and\n' +
          '  eslint-config-expo carry no expo prefix, so every pattern in the app-scoped rule misses\n' +
          '  them; @expo/dom-webview is declared in pnpm-workspace.yaml, which that rule cannot reach.\n' +
          '  Measured 2026-08-27 (item #29): all four were queued 56 -> 57 while expo stayed on ^56.',
      );
    }
  });
}

test('the Expo lock does NOT swallow @expo-google-fonts, which is not SDK-pinned', () => {
  for (const depName of EXPO_FALSE_FRIENDS) {
    const enabled = resolvedEnabled({
      manager: 'npm',
      packageFile: 'frontend/mcm-app/package.json',
      depName,
      datasource: 'npm',
      updateType: 'major',
    });
    assert.equal(
      enabled,
      true,
      `${depName} is DISABLED, but it is a font package with no tie to the Expo SDK matrix.\n` +
        '  A lock wide enough to catch it is wider than the defect it was written for, and it will\n' +
        '  silently stop proposing updates for it — the failure mode of an over-broad ignore.',
    );
  }
});

// ---------------------------------------------------------------------------------------------
// pnpm MOVES AS ONE UNIT — item #225. Third instance of the shape nx (#194) and Playwright (#204)
// already record: the version lives in package.json's `packageManager` (built-in `npm` manager) AND in
// frontend/mcm-app/Dockerfile's corepack pins (the customManagers entry, manager `custom.regex`).
//
// Measured twice. PR #217 (2026-08-21) moved packageManager to 11.22.0 and left both Dockerfile lines
// at 11.17.0. PR #263 (2026-08-28) moved it to 11.24.0 and left both at 11.22.0 — reddening
// `guardrails / naming` on a branch Renovate regenerates weekly.
//
// EXTRACTION IS NOT GROUPING. The customManager only extracts; the `pnpm pin` packageRule is what
// keeps the halves in one branch, and it only works while it stays ordered after the broad npm rules.

const pnpmDep = (manager, packageFile, updateType) => ({
  manager,
  packageFile,
  depName: 'pnpm',
  datasource: 'npm',
  updateType,
});
const PNPM_HALVES = [
  ['npm', 'package.json'],
  ['custom.regex', 'frontend/mcm-app/Dockerfile'],
];

for (const updateType of ['patch', 'minor', 'major']) {
  test(`both halves of the pnpm pin are proposed in ONE group on the ${updateType} track`, () => {
    const groups = PNPM_HALVES.map(([manager, packageFile]) => ({
      half: `${manager}:${packageFile}`,
      groupName: resolvedGroupName(pnpmDep(manager, packageFile, updateType)),
    }));
    const distinct = new Set(groups.map((g) => g.groupName));
    assert.equal(
      distinct.size,
      1,
      `the pnpm halves resolve to DIFFERENT groups on the ${updateType} track:\n` +
        groups.map((g) => `    ${g.half} -> ${JSON.stringify(g.groupName)}`).join('\n') +
        '\n  They must share one branch or the bump half-lands and check-toolchain-consistency.mjs\n' +
        '  reds `guardrails / naming` — measured on PR #217 and again on PR #263.',
    );
    assert.ok(groups[0].groupName, `pnpm resolves to NO group at all on the ${updateType} track`);
  });
}

test('the pnpm grouping rule covers both managers and is ordered LAST of the rules that group it', () => {
  const rules = packageRules.filter(
    (rule) => ruleMatches(rule, pnpmDep('npm', 'package.json', 'minor')) && rule.groupName !== undefined,
  );
  assert.ok(rules.length > 0, 'no packageRule assigns pnpm a groupName at all');

  const last = rules[rules.length - 1];
  assert.ok(
    Array.isArray(last.matchManagers) &&
      last.matchManagers.includes('npm') &&
      last.matchManagers.includes('custom.regex'),
    'the LAST rule to group pnpm is\n' +
      `  ${JSON.stringify({ matchManagers: last.matchManagers, groupName: last.groupName })}\n` +
      '  which does not match BOTH managers. It must match `npm` (package.json packageManager) and\n' +
      '  `custom.regex` (the Dockerfile corepack pins) or it groups one half and strands the other.',
  );
  assert.equal(
    last.matchUpdateTypes,
    undefined,
    'the pnpm grouping rule restricts matchUpdateTypes, so at least one update track falls through to\n' +
      '  the broad npm rules and half-bumps — the trap the Playwright rule is also asserted against.',
  );
});

test('the pnpm customManager exists and targets the Dockerfile that carries the pins', () => {
  const manager = (config.customManagers ?? []).find((m) => m.depNameTemplate === 'pnpm');
  assert.ok(
    manager,
    'renovate.json has no customManager with depNameTemplate "pnpm", so the Dockerfile corepack pins\n' +
      '  are extracted by NOTHING and only the package.json half can ever move.',
  );
  assert.ok(
    (manager.managerFilePatterns ?? []).some((p) => p.includes('mcm-app/Dockerfile')),
    'the pnpm customManager no longer targets frontend/mcm-app/Dockerfile',
  );
  assert.equal(
    manager.datasourceTemplate,
    'npm',
    'the pnpm customManager must use the npm datasource so both halves carry ONE depName and a single\n' +
      '  matchPackageNames re-joins them.',
  );
});

test('the pnpm customManager regex extracts EVERY corepack pin in the Dockerfile, not just the first', () => {
  // The file pins pnpm in TWO stages (builder and deps). A pattern that matched only one would look
  // correct in review and still half-bump — which is the entire defect being fixed.
  const manager = (config.customManagers ?? []).find((m) => m.depNameTemplate === 'pnpm');
  const dockerfile = readFileSync(resolve(REPO_ROOT, 'frontend/mcm-app/Dockerfile'), 'utf8');
  const expected = [...dockerfile.matchAll(/corepack\s+prepare\s+pnpm@/g)].length;
  assert.ok(expected >= 2, `expected the Dockerfile to carry >=2 corepack pins, found ${expected}`);

  const found = manager.matchStrings.flatMap((s) => [...dockerfile.matchAll(new RegExp(s, 'g'))]);
  assert.equal(
    found.length,
    expected,
    `the customManager regex matches ${found.length} of the ${expected} corepack pins in\n` +
      '  frontend/mcm-app/Dockerfile. Every stage that pins pnpm must be extracted, or the stages it\n' +
      '  misses stay behind and the toolchain gate reds anyway.',
  );
  for (const m of found) {
    assert.ok(
      m.groups?.currentValue,
      'a matched corepack pin captured no `currentValue` named group, so Renovate has no version to update',
    );
  }
});

test('the pnpm customManager does NOT claim the `pnpm@latest` prose in the docs', () => {
  // docs/runbooks/dev-environment-setup.md says `corepack prepare pnpm@latest --activate`. That is
  // instruction for a human, not a pin — the toolchain gate's PINNED_FILES excludes it for the same
  // reason. Matching it would file `latest` as a version and propose bumps against documentation.
  const manager = (config.customManagers ?? []).find((m) => m.depNameTemplate === 'pnpm');
  const docs = readFileSync(resolve(REPO_ROOT, 'docs/runbooks/dev-environment-setup.md'), 'utf8');
  for (const s of manager.matchStrings) {
    assert.equal(
      new RegExp(s).test(docs),
      false,
      `the pnpm customManager pattern ${JSON.stringify(s)} matches the docs prose. Even though\n` +
        '  managerFilePatterns scopes it out today, a pattern loose enough to match `pnpm@latest` will\n' +
        '  capture a non-version the moment the file list widens.',
    );
  }
});

test('the pnpm grouping rule does NOT swallow unrelated npm packages', () => {
  for (const depName of ['express', '@ai-sdk/openai']) {
    const group = resolvedGroupName({
      manager: 'npm',
      packageFile: 'frontend/mcm-app/package.json',
      depName,
      datasource: 'npm',
      updateType: 'minor',
    });
    assert.equal(
      group,
      'js patch/minor',
      `${depName} resolves to ${JSON.stringify(group)} — the pnpm rule has widened past its own pin.`,
    );
  }
});

// ---------------------------------------------------------------------------------------------
// @copilotkit/* ships BREAKING changes in MINOR bumps — item #266. Same defect as the cargo 0.x rule
// below, with a version number that does not advertise it: there the version string says "0.x" and
// warns you, here the package is past 1.0 and the minor looks routine.
//
// Measured 2026-08-28, PR #263 (item #265): @copilotkit/react-native 1.67.1 -> 1.69.0 removed the
// `useRenderToolRegistry` export and generative-UI `render({ args })` started passing PARTIAL args.
// The PR also carried @ai-sdk/openai and pnpm — both routine — and one breaking member made the whole
// thing unmergeable and unsplittable, weekly, for as long as the migration takes.
//
// As with the RN and Expo locks, the property asserted is what a dep RESOLVES to, not that a rule
// mentioning copilotkit exists: a rule placed before the broad `js patch/minor` rule would pass the
// latter and be silently overridden.

const COPILOTKIT_MEMBERS = ['@copilotkit/react-native', '@copilotkit/runtime'];
const copilotkitDep = (depName, updateType) => ({
  manager: 'npm',
  packageFile: 'frontend/mcm-app/package.json',
  depName,
  datasource: 'npm',
  updateType,
});

for (const updateType of ['minor', 'major']) {
  test(`a @copilotkit/* ${updateType} bump is reviewed individually, not batched as routine`, () => {
    const routine = resolvedGroupName(copilotkitDep('@ai-sdk/openai', updateType));
    for (const depName of COPILOTKIT_MEMBERS) {
      const group = resolvedGroupName(copilotkitDep(depName, updateType));
      assert.notEqual(
        group,
        routine,
        `${depName} resolves to ${JSON.stringify(group)} on the ${updateType} track — the same group as a\n` +
          `  routine npm package (${JSON.stringify(routine)}).\n` +
          '  CopilotKit ships BREAKING changes in minor bumps (PR #263: useRenderToolRegistry removed,\n' +
          '  render({args}) became partial), so one member arrives red and blocks every routine bump\n' +
          '  batched with it — every week, because Renovate regenerates the branch.',
      );
      assert.ok(group, `${depName} resolves to NO group at all on the ${updateType} track`);
    }
  });
}

test('the copilotkit rule requires dashboard approval, or it re-proposes a red PR every week', () => {
  const rule = packageRules.find((r) => (r.matchPackageNames ?? []).some((p) => p.includes('copilotkit')));
  assert.ok(rule, 'no packageRule mentions @copilotkit at all');
  assert.equal(
    rule.dependencyDashboardApproval,
    true,
    'the copilotkit rule does not require dashboard approval. A breaking upgrade cannot be made green\n' +
      '  by config, so without approval it arrives red every week and spends the weekly PR budget\n' +
      '  (item #218) on an upgrade known to need hand-holding — exactly what the cargo 0.x rule avoids.',
  );
});

test('the copilotkit rule is ordered LAST of the rules that group it', () => {
  const rules = packageRules.filter(
    (rule) => ruleMatches(rule, copilotkitDep('@copilotkit/runtime', 'minor')) && rule.groupName !== undefined,
  );
  assert.ok(rules.length > 0, 'no packageRule assigns @copilotkit/* a groupName at all');

  const last = rules[rules.length - 1];
  assert.ok(
    (last.matchPackageNames ?? []).some((p) => p.includes('copilotkit')),
    'the LAST rule to group @copilotkit/* is\n' +
      `  ${JSON.stringify({ matchManagers: last.matchManagers, groupName: last.groupName })}\n` +
      '  which is a BROAD npm rule, not the copilotkit rule. Later packageRules override earlier ones,\n' +
      '  so a copilotkit rule placed before `js patch/minor` / `js majors` is pulled straight back out —\n' +
      '  the trap that half-bumped the nx pair twice (PR #141, #193) and stranded the Playwright tag (#204).',
  );
});

test('the copilotkit gate leaves the PATCH track routine, so a security patch is not approval-gated', () => {
  // Deliberate, and the reason is not "patches are safe": vulnerabilityAlerts is schedule-exempt so a
  // known-vulnerable dep gets a PR within a day, and approval-gating every track would take that back.
  // The cargo 0.x rule gates `minor` only for the same shape of reason.
  const group = resolvedGroupName(copilotkitDep('@copilotkit/runtime', 'patch'));
  assert.equal(
    group,
    'js patch/minor',
    `a @copilotkit/* PATCH resolves to ${JSON.stringify(group)} rather than the routine group.\n` +
      '  Gating the patch track puts a SECURITY remediation behind a human dashboard tick, undoing the\n' +
      '  schedule-exemption vulnerabilityAlerts exists for. Gate the breaking tracks, not this one.',
  );
});

test('the copilotkit rule does NOT swallow unrelated npm packages', () => {
  for (const depName of ['@ai-sdk/openai', 'express', '@tamagui/core']) {
    const group = resolvedGroupName(copilotkitDep(depName, 'minor'));
    assert.equal(
      group,
      'js patch/minor',
      `${depName} resolves to ${JSON.stringify(group)} — the copilotkit rule has widened past its family.`,
    );
  }
});

test('a cargo 0.x minor bump is treated as breaking, not as routine', () => {
  // For a 0.x crate a MINOR bump is a semver-major in effect, but Renovate classifies it as `minor`
  // and it lands in the routine `cargo deps` group. Measured 2026-08-21, PR #216: base64 0.22 -> 0.23
  // and reqwest 0.12 -> 0.13 arrived as routine. reqwest 0.13 feature-gated RequestBuilder::form, so
  // the integration test targets stopped compiling, and it added a SECOND reqwest to the graph — which
  // backend/mc-service/Cargo.toml's own comment explicitly forbids.
  const zeroVer = { manager: 'cargo', packageFile: 'backend/mc-service/Cargo.toml', depName: 'reqwest', datasource: 'crate', updateType: 'minor', currentVersion: '0.12.28' };
  const oneVer = { ...zeroVer, depName: 'serde', currentVersion: '1.0.228' };

  const zeroGroup = resolvedGroupName(zeroVer);
  const oneGroup = resolvedGroupName(oneVer);

  assert.notEqual(
    zeroGroup,
    oneGroup,
    `a 0.x crate resolves to ${JSON.stringify(zeroGroup)}, the same group as a 1.x crate ` +
      `(${JSON.stringify(oneGroup)}).\n` +
      '  A 0.x minor is a BREAKING change and must not ride in the routine group, where it arrives red\n' +
      '  every week and blocks the genuinely-routine bumps batched with it.',
  );

  const rule = packageRules.find(
    (r) => r.matchManagers?.includes('cargo') && r.matchCurrentVersion !== undefined,
  );
  assert.ok(rule, 'no cargo rule discriminates on matchCurrentVersion, so 0.x cannot be told from 1.x');
  assert.equal(
    rule.dependencyDashboardApproval,
    true,
    'the 0.x cargo rule does not require dashboard approval. Without it these re-propose every week\n' +
      '  and spend the weekly PR budget (item #218) on upgrades known to need hand-holding.',
  );
});

// ---------------------------------------------------------------------------------------------
// hashicorp/vault is HELD BELOW 1.19 — PR #289 (2026-08-30), and this is a SECURITY decision, not a
// currency one. Renovate's `docker base images` group proposed 1.18 -> 1.21 and reddened
// `infra-image-scan / infra-image-scan`. Measured with the gate's own criteria
// (`trivy --severity CRITICAL --ignore-unfixed`) against the exact digest the PR pinned:
//
//   vault:1.18  4 findings / 3 unique advisories — ALL THREE allowlisted (seed entries)
//     CVE-2025-68121 (stdlib) · CVE-2026-31789 (libcrypto3, libssl3) · CVE-2026-33186 (grpc)
//   vault:1.21  5 findings / 4 unique advisories — NONE suppressed
//     CVE-2026-31789 (libcrypto3, libssl3) · CVE-2026-33186 (grpc)  ← carried over, still unfixed
//     CVE-2026-33815 · CVE-2026-33816 (github.com/jackc/pgx/v5)     ← NEW in 1.21
//     (CVE-2025-68121 IS cleared by 1.21 — the Go retoolchain — so the bump is net +1 advisory)
//
// TWO independent reasons it went red, and both matter. (1) The three allowlist entries are keyed to
// the regex `hashicorp/vault:1\.18`, which cannot match `hashicorp/vault:1.21@sha256:...` — the
// matcher is an UNANCHORED `new RegExp(e.image).test(f.image)`, which is also why appending a digest
// does NOT break the other entries (`minio/mc`, `grafana/otel-lgtm:latest`,
// `opensearchproject/opensearch:2` all still match). (2) The two pgx Criticals are genuinely new and
// allowlisted nowhere.
//
// This was ALREADY MEASURED AND WRITTEN DOWN by feature 036, in the allowlist justifications the
// seed entries carry: "Bump to 1.21.4 would clear THIS one (Go retoolchained) but NOT the sibling
// libcrypto3/grpc Crits, and 1.21.4 adds NEW pgx Criticals (Trivy-verified)". The bump walked into a
// documented trap. The standing decision there — "no fully-clean upstream tag yet; internal-only +
// dormant. Re-triage when a clean vault tag ships" — is what this rule now ENFORCES rather than
// merely records.
//
// `allowedVersions` rather than `enabled: false`, deliberately: digest refreshes WITHIN 1.18 are
// still wanted (docker:pinDigests keeps the pin honest), and only the version move is blocked.
// Widening the allowlist to bless 1.21 was rejected — that makes a red gate green by accepting a
// strictly worse image, which is the one thing an allowlist must never be used for.

const vaultDep = (updateType) => ({
  manager: 'docker-compose', datasource: 'docker', depName: 'hashicorp/vault', updateType,
});

test('hashicorp/vault is held below 1.19 on every update track', () => {
  for (const updateType of ['patch', 'minor', 'major']) {
    assert.equal(
      resolvedAllowedVersions(vaultDep(updateType)),
      '<1.19',
      `vault ${updateType} is not held — a 1.21 bump un-suppresses 3 allowlisted Criticals and adds 2 new pgx ones.`,
    );
  }
});

test('the vault hold does NOT leak onto other docker images — the control', () => {
  for (const depName of ['postgres', 'redis', 'quay.io/keycloak/keycloak', 'opensearchproject/opensearch']) {
    assert.equal(
      resolvedAllowedVersions({ manager: 'docker-compose', datasource: 'docker', depName, updateType: 'minor' }),
      null,
      `${depName} picked up vault's version hold — the rule has widened past its own image.`,
    );
  }
});

test('vault still rides the `docker base images` group, so a digest refresh is not stranded', () => {
  // The hold blocks a VERSION move, not the image. If this ever resolves to null, vault has fallen
  // out of the grouped PR and its digest pin would drift alone.
  assert.equal(resolvedGroupName(vaultDep('patch')), 'docker base images');
});

// ---------------------------------------------------------------------------------------------
// THE EIGHT FORMERLY-FLOATING INFRA IMAGES — feature 063 / item #297.
//
// THE DEFECT. `docker:pinDigests` gives reproducibility but not a VERSION. Eight third-party infra
// images were referenced as `:latest`, `:latest-debug`, or with no tag at all, so Renovate had
// nothing to order and filed every change as `updateType: digest`. Two consequences, both measured:
// a rebuild that crossed a major was indistinguishable from a security patch at review time, and an
// allowlist entry keyed to a floating ref could never be discharged by an upgrade, because the key
// matches for ever.
//
// WHAT IS ASSERTED, AND WHY IT IS NOT A FIXTURE. The `from` version of every row below is read out
// of the COMPOSE FILES THEMSELVES, not declared here. That is what makes this a test: today those
// files say `latest`, which parses to no version under any scheme, so `updateType()` returns
// `digest` and every row fails. It also means a future revert to a floating tag reddens this file
// rather than passing quietly against a stale constant.
//
// The `to` versions ARE synthetic, deliberately — asserting what Renovate would propose requires its
// network step, and a guard that pretended to know the next published tag would be asserting its own
// fixture. The property under test is the CLASSIFICATION of a move, which is pure.

const INFRA_COMPOSE_FILES = [
  'infrastructure-as-code/docker/keycloak/compose.yaml',
  'infrastructure-as-code/docker/observability/compose.yaml',
  'infrastructure-as-code/docker/observability/compose.prod.yaml',
];

/**
 * Every third-party `image:` reference in those files as { repository, tag, location }.
 *
 * The ref grammar is the same one scripts/infra-image-scan.mjs had to be corrected for (item #297's
 * first half): strip `@<digest>` FIRST, and treat a colon as a tag separator only when it falls
 * after the last `/`, or `host:5000/repo` parses its registry PORT as the tag. Reimplemented here
 * rather than imported so this guard does not start depending on the scanner it sits beside.
 */
function infraComposeRefs() {
  const refs = [];
  for (const file of INFRA_COMPOSE_FILES) {
    const lines = readFileSync(resolve(REPO_ROOT, file), 'utf8').split(/\r?\n/);
    lines.forEach((l, i) => {
      const m = /^\s*image:\s*["']?([^"'#\s]+)/.exec(l);
      if (!m || m[1].includes('${')) return;
      const withoutDigest = m[1].split('@')[0];
      const lastColon = withoutDigest.lastIndexOf(':');
      const lastSlash = withoutDigest.lastIndexOf('/');
      const hasTag = lastColon > lastSlash;
      refs.push({
        repository: hasTag ? withoutDigest.slice(0, lastColon) : withoutDigest,
        tag: hasTag ? withoutDigest.slice(lastColon + 1) : 'latest', // no tag IS `latest`
        location: `${file}:${i + 1}`,
      });
    });
  }
  return refs;
}

const composeRefs = infraComposeRefs();
const tagsFor = (repository) => composeRefs.filter((r) => r.repository === repository).map((r) => r.tag);

const dockerDep = (depName, updateType = 'minor') => ({
  manager: 'docker-compose', datasource: 'docker', depName, updateType,
});

/**
 * Parse a docker tag to { major, minor, patch } under a resolved versioning scheme, or `null` when
 * the tag carries no orderable version. **`null` is the whole defect**: `latest` parses to null
 * under every scheme, which is precisely why Renovate can only call the change a digest.
 */
function parseTag(tag, versioning) {
  if (versioning === null) {
    // Renovate's `docker` default. The optional `-<suffix>` is its compatibility stream — a
    // `1.20.1-debug` tag is version 1.20.1 within the `debug` stream, and only ever compares
    // against other `-debug` tags. Covers every semver-shaped tag this repository uses.
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-.+)?$/.exec(tag);
    return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null;
  }
  if (versioning.startsWith('regex:')) {
    const m = new RegExp(versioning.slice('regex:'.length)).exec(tag);
    if (!m?.groups) return null;
    // renovate@44's regex versioning requires at least one of major/minor/patch and treats an absent
    // group as zero. All three are present in the scheme this repository declares.
    return { major: +(m.groups.major ?? 0), minor: +(m.groups.minor ?? 0), patch: +(m.groups.patch ?? 0) };
  }
  throw new Error(`versioning scheme '${versioning}' is not modelled — extend parseTag() before using it.`);
}

/** The updateType Renovate reports for from -> to. `digest` when either side carries no version. */
function updateType(fromTag, toTag, versioning) {
  const a = parseTag(fromTag, versioning);
  const b = parseTag(toTag, versioning);
  if (!a || !b) return 'digest'; // nothing orderable — an opaque content change
  if (b.major !== a.major) return 'major';
  if (b.minor !== a.minor) return 'minor';
  if (b.patch !== a.patch) return 'patch';
  return 'digest';
}

/**
 * Does a resolved `allowedVersions` permit a tag? Models the `/regex/` form only, and throws on
 * anything else — a range like vault's `<1.19` is a different question, and silently answering
 * "permitted" for a form this helper cannot read is the fail-open shape the whole file avoids.
 */
function allowedVersionsPermits(allowed, tag) {
  if (allowed === null) return true; // unconstrained
  if (allowed.startsWith('/') && allowed.lastIndexOf('/') > 0) {
    return new RegExp(allowed.slice(1, allowed.lastIndexOf('/'))).test(tag);
  }
  throw new Error(`allowedVersions '${allowed}' is not a regex form — extend allowedVersionsPermits().`);
}

// Contract C1, row for row (specs/063-infra-image-version-pins/contracts/renovate-rules.md).
// `from` is asserted to be the tag REALLY in the compose files before it is used.
const C1_ROWS = [
  { repository: 'axllent/mailpit', from: 'v1.31.0', to: 'v2.0.0', expected: 'major' },
  { repository: 'axllent/mailpit', from: 'v1.31.0', to: 'v1.32.0', expected: 'minor' },
  { repository: 'curlimages/curl', from: '8.21.0', to: '8.21.1', expected: 'patch' },
  { repository: 'grafana/otel-lgtm', from: '0.32.0', to: '0.33.0', expected: 'minor' },
  { repository: 'openpolicyagent/opa', from: '1.20.1', to: '2.0.0', expected: 'major' },
  { repository: 'unleashorg/unleash-server', from: '8.1.0', to: '9.0.0', expected: 'major' },
];

for (const { repository, from, to, expected } of C1_ROWS) {
  test(`${repository} ${from} -> ${to} resolves to update type '${expected}', not an opaque digest`, () => {
    assert.ok(
      tagsFor(repository).includes(from),
      `contract C1 says ${repository} is on ${from}, but the compose files carry ` +
        `${JSON.stringify(tagsFor(repository))}.\n` +
        '  A floating tag has no version to classify, so every change to this image arrives as\n' +
        '  `updateType: digest` and a major rebuild is indistinguishable from a security patch.',
    );
    assert.equal(
      updateType(from, to, resolvedVersioning(dockerDep(repository, expected))),
      expected,
      `${repository} ${from} -> ${to} did not classify as ${expected}.`,
    );
  });
}

test('no formerly-floating infra image resolves to a digest-only update type', () => {
  // The C1 table's last row, applied to every reference rather than to the six it names — this is
  // the one that also covers minio, whose tags need the declared regex versioning to be orderable
  // at all. `-debug` is included: a variant left floating is still a reference nobody can classify.
  const FORMERLY_FLOATING = [
    'axllent/mailpit', 'curlimages/curl', 'grafana/otel-lgtm',
    'minio/mc', 'minio/minio', 'openpolicyagent/opa', 'unleashorg/unleash-server',
  ];
  for (const ref of composeRefs.filter((r) => FORMERLY_FLOATING.includes(r.repository))) {
    const versioning = resolvedVersioning(dockerDep(ref.repository));
    assert.notEqual(
      parseTag(ref.tag, versioning),
      null,
      `${ref.repository}:${ref.tag} (${ref.location}) carries no orderable version under ` +
        `${versioning === null ? 'the docker default' : versioning}, so Renovate can only report a\n` +
        '  digest change. This is the defect item #297 was filed for.',
    );
  }
});

test('the minio date-tagged family orders by calendar, and its update type says only that', () => {
  // Contract C4. The mapping is year->major, month->minor, day->patch, so a January release reports
  // `major` because the YEAR ADVANCED, not because anything broke (FR-004, research R2). Asserted
  // rather than merely commented, so the calendar semantics cannot quietly become semver ones.
  for (const repository of ['minio/minio', 'minio/mc']) {
    const versioning = resolvedVersioning(dockerDep(repository));
    assert.ok(
      versioning !== null && versioning.startsWith('regex:'),
      `${repository} has no regex versioning, so its RELEASE.<date> tags are unparseable — ` +
        'renovate@44\'s `loose` scheme returns null for them (measured against its own dist), ' +
        'which is invisible rather than unordered.',
    );
    assert.equal(updateType('RELEASE.2025-09-07T16-13-09Z', 'RELEASE.2026-01-15T10-00-00Z', versioning), 'major');
    assert.equal(updateType('RELEASE.2025-09-07T16-13-09Z', 'RELEASE.2025-10-01T10-00-00Z', versioning), 'minor');
    assert.equal(updateType('RELEASE.2025-09-07T16-13-09Z', 'RELEASE.2025-09-08T10-00-00Z', versioning), 'patch');

    // The trailing `Z$` anchor is load-bearing: the same namespace publishes `-cpuv1` builds, and
    // without the anchor Renovate could drift onto one — the same defect class as opa's `-dev`
    // and `-rootless` tags (FR-006).
    assert.equal(
      parseTag('RELEASE.2025-09-07T16-13-09Z-cpuv1', versioning),
      null,
      `${repository}'s versioning regex accepts a -cpuv1 variant — the trailing Z$ anchor is missing.`,
    );
  }
});

// ---------------------------------------------------------------------------------------------
// openpolicyagent/opa MOVES AS ONE UNIT — contract C2/C3, FR-005/FR-006.
//
// This is the ONLY genuine pairing risk in the eight. Two DIFFERENT tags (`1.20.1` and
// `1.20.1-debug`) in two different files under ONE dependency name, so nothing about the file
// layout forces them to move together. curl, otel-lgtm, minio, mc and unleash each carry an
// IDENTICAL ref in both observability files — Renovate sees one dependency with two locations and
// rewrites both by construction — so that shape is asserted ONCE below as a control, not five times
// as if it were five risks.
//
// The half-bump shape this repository has now paid for four times (#194 nx, #204 Playwright, #225
// pnpm, the vault allowlist key in PR #289) is why the assertion is on the RESOLVED value rather
// than on the presence of a rule: in every one of those four, a mechanism existed that looked
// sufficient and was silently overridden by a later, broader rule.

const OPA_TAGS = ['1.20.1', '1.20.1-debug'];

test('both openpolicyagent/opa refs resolve to the same group and the same version ceiling', () => {
  for (const updateTypeTrack of ['patch', 'minor', 'major']) {
    const dep = dockerDep('openpolicyagent/opa', updateTypeTrack);
    assert.equal(
      resolvedGroupName(dep),
      'docker base images',
      `opa (${updateTypeTrack}) fell out of the grouped PR — the plain and -debug refs would then ` +
        'be proposed on separate branches and could land half-bumped.',
    );
    assert.equal(
      resolvedEnabled(dep),
      true,
      `opa (${updateTypeTrack}) is DISABLED — an image excluded from updates cannot be patched at all.`,
    );
  }
  // One dependency name, so one resolved ceiling by construction — asserted because the ceiling is
  // what constrains WHICH tags may be proposed, and a per-variant ceiling would let them diverge.
  const ceilings = new Set(['patch', 'minor', 'major'].map((u) => resolvedAllowedVersions(dockerDep('openpolicyagent/opa', u))));
  assert.equal(ceilings.size, 1, `opa resolves to more than one version ceiling: ${JSON.stringify([...ceilings])}`);
});

test('openpolicyagent/opa may only be proposed the plain and -debug variants it actually uses', () => {
  const allowed = resolvedAllowedVersions(dockerDep('openpolicyagent/opa'));
  assert.notEqual(
    allowed,
    null,
    'openpolicyagent/opa is unconstrained. It publishes 3573 tags including -dev, -rootless and\n' +
      '  -static builds; this repository uses exactly two of them. An unconstrained ceiling lets\n' +
      '  Renovate propose a variant nothing here runs.',
  );

  // Permit-what-is-used rather than deny-what-is-known-bad: a denylist of `-dev`/`-rootless` goes
  // stale the moment upstream invents a third suffix, and C3's pre-release markers are open-ended.
  for (const tag of [...OPA_TAGS, '2.0.0', '2.0.0-debug']) {
    assert.ok(allowedVersionsPermits(allowed, tag), `opa ceiling rejects '${tag}', which is a variant in use (or its successor).`);
  }
  for (const tag of ['1.20.1-dev', '1.20.1-rootless', '1.20.1-static', '1.20.1-static-debug', '1.21.0-rc1', '1.21.0-alpha.1', '1.21.0-beta', 'nightly', 'edge', '1.20.1-debug-static']) {
    assert.ok(!allowedVersionsPermits(allowed, tag), `opa ceiling PERMITS '${tag}', which nothing here runs (FR-006 / contract C3).`);
  }

  // Both refs are really present, in the two files, with the two tags — the pairing this is about.
  assert.deepEqual(tagsFor('openpolicyagent/opa').sort(), [...OPA_TAGS].sort());
});

test('the opa ceiling does NOT leak onto other docker images — the control', () => {
  for (const depName of ['postgres', 'redis', 'grafana/otel-lgtm', 'curlimages/curl', 'hashicorp/vault']) {
    const allowed = resolvedAllowedVersions(dockerDep(depName));
    assert.notEqual(
      allowed,
      '/^\\d+\\.\\d+\\.\\d+(-debug)?$/',
      `${depName} picked up opa's variant restriction — the rule has widened past its own image.`,
    );
  }
});

test('the five identically-referenced images are one dependency with two locations — the control', () => {
  // Not five risks. Each of these carries the SAME ref string in compose.yaml and compose.prod.yaml,
  // so Renovate rewrites both locations in one go and no configuration is needed to pair them.
  // Asserted so that if someone ever makes local and prod diverge, the claim above stops being true
  // loudly rather than silently.
  for (const repository of ['curlimages/curl', 'grafana/otel-lgtm', 'minio/minio', 'minio/mc', 'unleashorg/unleash-server']) {
    const tags = new Set(tagsFor(repository));
    assert.equal(
      tags.size,
      1,
      `${repository} carries different tags across the observability files (${JSON.stringify([...tags])}).\n` +
        '  It is no longer structurally paired, and now needs the same explicit handling as opa.',
    );
    assert.equal(tagsFor(repository).length, 2, `${repository} is expected in both observability files`);
    assert.equal(resolvedGroupName(dockerDep(repository)), 'docker base images');
  }
});

test('all eight formerly-floating references stay in the `docker base images` group', () => {
  // C2's first row. They must not be stranded into per-image PRs on the single CI runner.
  for (const repository of ['axllent/mailpit', 'curlimages/curl', 'grafana/otel-lgtm', 'minio/minio', 'minio/mc', 'openpolicyagent/opa', 'unleashorg/unleash-server']) {
    for (const updateTypeTrack of ['patch', 'minor', 'major']) {
      assert.equal(resolvedGroupName(dockerDep(repository, updateTypeTrack)), 'docker base images', `${repository} (${updateTypeTrack}) is not grouped`);
    }
  }
});
