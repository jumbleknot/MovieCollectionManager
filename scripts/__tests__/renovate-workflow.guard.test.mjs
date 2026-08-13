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
