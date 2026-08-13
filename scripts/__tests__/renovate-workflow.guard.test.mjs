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
