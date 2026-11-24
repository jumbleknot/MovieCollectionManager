// scripts/lib/renovate-window.mjs — the lockFileMaintenance window, derived from renovate.json.
//
// Moved from check-lockfile-refresh.test.mjs when item #1124 retired that check; the window logic is
// now shared by renovate-verdict.mjs (the run judges itself) and renovate-health.mjs (the weekly
// digest checks a window run happened). Pure functions over fixtures — no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWindow, inWindow } from '../lib/renovate-window.mjs';

const CONFIG = { timezone: 'America/New_York', schedule: ['* 2-4 * * 5'], lockFileMaintenance: { schedule: ['* 2-4 * * 5'] } };

test('the window is derived from renovate.json, not restated', () => {
  const w = parseWindow(CONFIG);
  assert.equal(w.timezone, 'America/New_York');
  assert.deepEqual([...w.hours].sort((a, b) => a - b), [2, 3, 4]);
  assert.deepEqual([...w.dow], [5]);
});

test('parseWindow prefers lockFileMaintenance own schedule over the inherited one', () => {
  const w = parseWindow({ timezone: 'America/New_York', schedule: ['* 9 * * 1'], lockFileMaintenance: { schedule: ['* 2-4 * * 5'] } });
  assert.deepEqual([...w.hours].sort((a, b) => a - b), [2, 3, 4], 'the child schedule beats the top-level one, as Renovate resolves it');
});

test('inWindow follows the DECLARED timezone across both DST offsets', () => {
  const w = parseWindow(CONFIG);
  // 2026-08-21 is a Friday in EDT (UTC-4): 07:00Z = 03:00 EDT — inside 02:00-04:59.
  assert.equal(inWindow('2026-08-21T07:00:14Z', w), true, 'the Friday 07:00Z cron is inside the window under EDT');
  // 2026-08-15T03:14:38Z is 2026-08-14 23:14 EDT — a Friday, but 23:14, not 02:00-04:59.
  assert.equal(inWindow('2026-08-15T03:14:38Z', w), false, "PR #199's real timestamp must read as OUTSIDE the window");
  // In January the offset is EST (UTC-5), so 07:00Z = 02:00 EST — still inside.
  assert.equal(inWindow('2027-01-15T07:00:00Z', w), true, 'the same cron is inside the window under EST too');
  // ...but 06:00Z in January is 01:00 EST — outside.
  assert.equal(inWindow('2027-01-15T06:00:00Z', w), false, 'an hour that is only inside under EDT must not read as inside under EST');
});

test('a cron shape the evaluator cannot read THROWS rather than guessing a window', () => {
  assert.throws(() => parseWindow({ schedule: ['*/5 2-4 * * 5'] }), /unsupported cron field|only minute/);
  assert.throws(() => parseWindow({ schedule: ['* 2-4 1 * 5'] }), /only minute\/day-of-month\/month/);
  assert.throws(() => parseWindow({ schedule: ['before 4am on monday'] }), /5-field cron/);
  assert.throws(() => parseWindow({}), /no schedule/);
});
