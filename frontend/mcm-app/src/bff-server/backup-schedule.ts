// Next-run arithmetic for a backup job's schedule (feature 073, T049 — FR-016/FR-019; US4-AC5).
//
// PURE, AND `now` IS AN ARGUMENT. Nothing here reads a clock, a database or the network, so the
// awkward days — the two DST transitions, the 31st of a 30-day month — are reachable from a test
// on any day of the year instead of twice annually.
//
// THE JOB'S ZONE DECIDES. Every Luxon call below passes `{ zone: schedule.timeZone }` explicitly.
// Omitting it on even one call is the characteristic bug in this kind of code: Luxon silently
// falls back to `Settings.defaultZone`, which is UTC on a developer's machine and in CI, so the
// answer is right everywhere it is tested and wrong for every user who is not in UTC.
//
// THE ADVANCE IS BY LOCAL CALENDAR UNIT, NOT BY ELAPSED TIME. "Tomorrow at 01:30 local" is not
// "24 hours from now", and on the two transition days it is 23 or 25. Building candidates as
// local dates and only then resolving each to an instant is what makes both directions fall out
// of the same code, rather than needing a correction term whose sign is easy to get backwards.

import { DateTime } from 'luxon';

import type { Schedule } from '@/types/backups';

export class InvalidScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidScheduleError';
  }
}

const FREQUENCIES = new Set(['daily', 'weekly', 'monthly']);

/**
 * Is this a zone the RUNTIME knows?
 *
 * Checked against the runtime's own zone list rather than a hard-coded table. A zone accepted
 * here but unknown to Node becomes a job that throws on every schedule computation for ever,
 * and the error surfaces in the tick, nowhere near the form that accepted it.
 */
export function isValidTimeZone(zone: string): boolean {
  if (typeof zone !== 'string' || zone.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Reject anything the arithmetic below cannot honour, at SAVE time.
 *
 * This is a second line behind the route's `zod` schema, not a duplicate of it. The schema
 * guards the HTTP boundary; this guards the MODULE, so a schedule reaching the arithmetic from
 * anywhere — a migration, a future internal caller, a test — is still one that can be computed.
 * A schedule that cannot be computed does not fail loudly at the boundary; it means "never",
 * silently, which is the worst outcome a backup schedule has.
 */
export function assertValidSchedule(schedule: Schedule): void {
  if (!schedule || typeof schedule !== 'object') {
    throw new InvalidScheduleError('A schedule is required');
  }
  // FR-016: daily, weekly or monthly, and nothing else. A raw cron expression arrives here as a
  // `frequency` that is not one of the three, and is refused for that reason — there is no
  // free-text recurrence anywhere in this feature, because a malformed expression silently
  // means "never" while still looking configured.
  if (!FREQUENCIES.has(schedule.frequency)) {
    throw new InvalidScheduleError(
      'A backup schedule must be daily, weekly or monthly. Free-text or cron recurrence is not supported.',
    );
  }
  if (!isValidTimeZone(schedule.timeZone)) {
    throw new InvalidScheduleError(`Unknown time zone: ${String(schedule.timeZone)}`);
  }
  assertWholeNumberInRange(schedule.hour, 0, 23, 'hour');
  assertWholeNumberInRange(schedule.minute, 0, 59, 'minute');
  if (schedule.frequency === 'weekly') {
    if (schedule.weekday === undefined) {
      throw new InvalidScheduleError('A weekly schedule needs a day of the week');
    }
    assertWholeNumberInRange(schedule.weekday, 1, 7, 'day of the week');
  }
  if (schedule.frequency === 'monthly') {
    if (schedule.dayOfMonth === undefined) {
      throw new InvalidScheduleError('A monthly schedule needs a day of the month');
    }
    assertWholeNumberInRange(schedule.dayOfMonth, 1, 31, 'day of the month');
  }
}

function assertWholeNumberInRange(value: unknown, min: number, max: number, field: string): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new InvalidScheduleError(`The ${field} must be a whole number between ${min} and ${max}`);
  }
}

/**
 * The instant a local wall time actually happens, for the two days a year it is not obvious.
 *
 * RESOLVED EXPLICITLY, NOT BY ASKING LUXON. `DateTime.fromObject` does return *an* instant for
 * an ambiguous wall time, but WHICH of the two it picks is not a rule you can rely on. Measured
 * on Luxon 3.7 with real 2026 data: `Europe/London` 2026-10-25 01:30 resolves to the FIRST
 * occurrence (00:30Z, BST) while `Australia/Sydney` 2026-04-05 02:30 resolves to the SECOND
 * (16:30Z, AEST) — same kind of transition, opposite answers. An implementation that trusted
 * "Luxon returns the first" would pass a London test and silently double-fire in Sydney.
 *
 * So both candidate instants are constructed here and checked, and the EARLIER valid one wins:
 *
 *   AMBIGUOUS (clocks back, the wall time happens twice) → two valid candidates → take the
 *   first. One occurrence must yield one run, and `computeNextRun`'s strict `>` is what then
 *   carries the schedule past the second occurrence rather than back onto it.
 *
 *   NONEXISTENT (clocks forward, the wall time is skipped) → no valid candidate → the run
 *   happens as soon as it legally can, which is the transition instant itself. Skipping is
 *   never an option: a silently missing occurrence is a backup gap with nothing to explain it.
 */
function instantForLocalTime(
  zone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): DateTime {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const dayMs = 24 * 60 * 60 * 1000;
  // The offsets in play either side of this wall time. A day clear of the transition on each
  // side, which is wider than any gap or overlap the tz database contains.
  const offsetBefore = DateTime.fromMillis(naive - dayMs, { zone }).offset;
  const offsetAfter = DateTime.fromMillis(naive + dayMs, { zone }).offset;

  const valid: number[] = [];
  for (const offset of new Set([offsetBefore, offsetAfter])) {
    const candidate = naive - offset * 60 * 1000;
    const local = DateTime.fromMillis(candidate, { zone });
    // The whole wall time, not just hour and minute: a zone can skip an entire calendar day
    // (Pacific/Apia did in 2011), and a date-only mismatch would otherwise read as a match.
    if (
      local.year === year &&
      local.month === month &&
      local.day === day &&
      local.hour === hour &&
      local.minute === minute
    ) {
      valid.push(candidate);
    }
  }
  if (valid.length > 0) return DateTime.fromMillis(Math.min(...valid), { zone });

  return DateTime.fromMillis(findTransition(zone, naive - dayMs, naive + dayMs, offsetAfter), {
    zone,
  });
}

/**
 * The exact instant the offset became `targetOffset`, found by bisection.
 *
 * Bisection rather than arithmetic on the two offsets, because the transition instant is a fact
 * about the tz database and not derivable from the offsets either side — the rule placing it
 * there has changed repeatedly and differs by jurisdiction. Callers pass a window they have
 * already established straddles the change.
 */
function findTransition(zone: string, loMs: number, hiMs: number, targetOffset: number): number {
  let lo = loMs;
  let hi = hiMs;
  // Invariant: offset(lo) !== targetOffset, offset(hi) === targetOffset. Narrowing to a single
  // millisecond leaves `hi` as the first instant on the new offset.
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (DateTime.fromMillis(mid, { zone }).offset === targetOffset) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** The local dates this schedule could next fire on, in order, starting at `from`. */
function* candidateLocalDates(
  schedule: Schedule,
  from: DateTime,
): Generator<{ year: number; month: number; day: number }> {
  if (schedule.frequency === 'daily') {
    for (let i = 0; i < 4; i += 1) {
      const d = from.plus({ days: i });
      yield { year: d.year, month: d.month, day: d.day };
    }
    return;
  }
  if (schedule.frequency === 'weekly') {
    // `from.weekday` is ISO (Monday = 1), matching what the job stores, so no conversion.
    const daysAhead = (schedule.weekday! - from.weekday + 7) % 7;
    for (let i = 0; i < 3; i += 1) {
      const d = from.plus({ days: daysAhead + i * 7 });
      yield { year: d.year, month: d.month, day: d.day };
    }
    return;
  }
  // Monthly. CLAMP to the month's last day rather than skipping the month — a job set for the
  // 31st must still run in February, and a schedule that silently does nothing for a third of
  // the year is the exact failure this feature exists to prevent.
  for (let i = 0; i < 3; i += 1) {
    const monthStart = from.startOf('month').plus({ months: i });
    yield {
      year: monthStart.year,
      month: monthStart.month,
      day: Math.min(schedule.dayOfMonth!, monthStart.daysInMonth!),
    };
  }
}

/**
 * The first instant strictly after `now` at which this schedule fires, as an ISO-8601 UTC string.
 *
 * STRICTLY after, which is what carries a just-completed run past a repeated wall time rather
 * than straight back onto it.
 */
export function computeNextRun(schedule: Schedule, now: Date): string {
  assertValidSchedule(schedule);
  const zone = schedule.timeZone;
  const localNow = DateTime.fromJSDate(now, { zone });

  for (const { year, month, day } of candidateLocalDates(schedule, localNow)) {
    const candidate = instantForLocalTime(zone, year, month, day, schedule.hour, schedule.minute);
    if (candidate.toMillis() > now.getTime()) return candidate.toUTC().toISO()!;
  }
  // Unreachable for the three supported frequencies: each generator yields at least one date
  // strictly beyond `now`'s own period. Thrown rather than returned as a null the callers would
  // have to handle, because reaching it means the arithmetic above is wrong, not the input.
  throw new InvalidScheduleError('No next run could be computed for that schedule');
}
