// Schedule arithmetic: the next run instant for a job (feature 073, T048 — FR-016/FR-019; US4-AC5).
//
// PURE. No clock, no network, no database — `now` is an argument. A scheduling test that reads
// the wall clock only fails on the days the bug matters, which is the one property a scheduling
// test must not have.
//
// THE EXPECTED INSTANTS BELOW COME FROM `zdump`, NOT FROM LUXON. Deriving them from the same
// library the implementation uses would assert only that the code agrees with itself. The
// transitions were read from the system zoneinfo database:
//
//   Europe/London     2026-03-29T01:00:00Z  local 01:00 GMT  → 02:00 BST   (gap  = local [01:00, 02:00))
//   Europe/London     2026-10-25T01:00:00Z  local 02:00 BST  → 01:00 GMT   (twice = local [01:00, 02:00))
//   Australia/Sydney  2026-10-03T16:00:00Z  local 02:00 AEST → 03:00 AEDT  (gap  = local [02:00, 03:00))
//   Australia/Sydney  2026-04-04T16:00:00Z  local 03:00 AEDT → 02:00 AEST  (twice = local [02:00, 03:00))
//
// NOTE ON THE TASK TABLE: tasks.md names 02:30 as London's nonexistent time. It is not — London's
// gap is 01:00–02:00, so 02:30 exists there every year and a test built on it would pass without
// ever exercising a gap. 01:30 is London's nonexistent time; 02:30 is SYDNEY's. The intent of the
// row is preserved, the hour corrected to what the tz database actually says.

import { Settings } from 'luxon';

import {
  InvalidScheduleError,
  computeNextRun,
  assertValidSchedule,
} from '@/bff-server/backup-schedule';
import type { Schedule } from '@/types/backups';

const at = (iso: string) => new Date(iso);

const daily = (hour: number, minute: number, timeZone: string): Schedule => ({
  frequency: 'daily',
  hour,
  minute,
  timeZone,
});

describe('computeNextRun — spring forward (the local time does not exist)', () => {
  // The run must NOT be skipped. A skipped occurrence is a silent backup gap, which is the
  // failure mode this whole feature exists to prevent.
  it('runs at the end of the gap when the London local time is skipped over', () => {
    // now: Sat 2026-03-28 12:00 GMT. Today's 01:30 has passed, so the next is Sunday's —
    // and Sunday's 01:30 London never happens.
    const next = computeNextRun(daily(1, 30, 'Europe/London'), at('2026-03-28T12:00:00.000Z'));
    // The first valid instant at or after 01:30 local is the transition itself: 02:00 BST.
    expect(next).toBe('2026-03-29T01:00:00.000Z');
  });

  it('returns to the ordinary local time the day after a London gap', () => {
    const next = computeNextRun(daily(1, 30, 'Europe/London'), at('2026-03-29T01:00:00.000Z'));
    // Mon 2026-03-30 01:30 BST = 00:30Z — the schedule is back to its normal local time.
    expect(next).toBe('2026-03-30T00:30:00.000Z');
  });

  it('runs at the end of the gap when the Sydney local time is skipped over', () => {
    // Southern hemisphere: the transition runs the other way round in the calendar, which is
    // where a sign error hides. now: Fri 2026-10-02 12:00Z.
    const next = computeNextRun(daily(2, 30, 'Australia/Sydney'), at('2026-10-02T12:00:00.000Z'));
    // Sat 2026-10-03 02:30 AEST = 2026-10-02T16:30Z, which is after `now`, so that one is next.
    expect(next).toBe('2026-10-02T16:30:00.000Z');
  });

  it('runs at the end of the Sydney gap on the transition day itself', () => {
    const next = computeNextRun(daily(2, 30, 'Australia/Sydney'), at('2026-10-02T16:30:00.000Z'));
    // Sun 2026-10-04 02:30 AEST never happens; the first valid instant is 03:00 AEDT.
    expect(next).toBe('2026-10-03T16:00:00.000Z');
  });
});

describe('computeNextRun — fall back (the local time happens twice)', () => {
  // ONE OCCURRENCE MUST YIELD ONE RUN. Taking the first instant and then advancing past the
  // second is the whole rule: an implementation that merely scans forward for "the next instant
  // whose local time is 01:30" fires twice on this day, and the user gets two artifacts an hour
  // apart with no explanation.
  it('takes the FIRST of the two London occurrences', () => {
    const next = computeNextRun(daily(1, 30, 'Europe/London'), at('2026-10-24T12:00:00.000Z'));
    // 01:30 BST = 00:30Z, an hour before 01:30 GMT = 01:30Z.
    expect(next).toBe('2026-10-25T00:30:00.000Z');
  });

  it('advances PAST the second London occurrence, not onto it', () => {
    const next = computeNextRun(daily(1, 30, 'Europe/London'), at('2026-10-25T00:30:00.000Z'));
    // NOT 2026-10-25T01:30:00Z (the second occurrence of the same wall time). The next
    // occurrence is the next local DAY.
    expect(next).toBe('2026-10-26T01:30:00.000Z');
  });

  it('takes the FIRST of the two Sydney occurrences', () => {
    const next = computeNextRun(daily(2, 30, 'Australia/Sydney'), at('2026-04-04T00:00:00.000Z'));
    // 02:30 AEDT = 2026-04-04T15:30Z, an hour before 02:30 AEST = 16:30Z.
    expect(next).toBe('2026-04-04T15:30:00.000Z');
  });

  it('advances PAST the second Sydney occurrence, not onto it', () => {
    const next = computeNextRun(daily(2, 30, 'Australia/Sydney'), at('2026-04-04T15:30:00.000Z'));
    // NOT 2026-04-04T16:30:00Z. Next local day is Mon 2026-04-06 02:30 AEST.
    expect(next).toBe('2026-04-05T16:30:00.000Z');
  });
});

describe('computeNextRun — monthly dates that do not exist in every month', () => {
  // CLAMP, NEVER SKIP. A job set for the 31st that silently does nothing in April, June,
  // September and November is a backup that is absent for a third of the year, and nothing in
  // the UI would say so.
  const monthly = (dayOfMonth: number): Schedule => ({
    frequency: 'monthly',
    hour: 3,
    minute: 0,
    dayOfMonth,
    timeZone: 'UTC',
  });

  it('clamps the 31st to the last day of a 30-day month', () => {
    expect(computeNextRun(monthly(31), at('2026-04-01T00:00:00.000Z'))).toBe(
      '2026-04-30T03:00:00.000Z',
    );
  });

  it('clamps the 29th to the 28th in a non-leap February', () => {
    expect(computeNextRun(monthly(29), at('2026-02-01T00:00:00.000Z'))).toBe(
      '2026-02-28T03:00:00.000Z',
    );
  });

  it('uses the real 29th in a leap February', () => {
    expect(computeNextRun(monthly(29), at('2028-02-01T00:00:00.000Z'))).toBe(
      '2028-02-29T03:00:00.000Z',
    );
  });

  it("moves to the next month once this month's occurrence has passed", () => {
    expect(computeNextRun(monthly(31), at('2026-04-30T03:00:00.000Z'))).toBe(
      '2026-05-31T03:00:00.000Z',
    );
  });
});

describe('computeNextRun — weekly across a DST boundary', () => {
  // The LOCAL time is what the user set, so the local time is what must be preserved. The UTC
  // instant moving by an hour is the correct consequence, not a bug.
  const weeklySunday = (): Schedule => ({
    frequency: 'weekly',
    hour: 9,
    minute: 0,
    weekday: 7, // ISO: Monday = 1, Sunday = 7
    timeZone: 'Europe/London',
  });

  it('keeps the same local time either side of the spring transition', () => {
    // Before: Sun 2026-03-22 09:00 GMT = 09:00Z.
    expect(computeNextRun(weeklySunday(), at('2026-03-15T12:00:00.000Z'))).toBe(
      '2026-03-22T09:00:00.000Z',
    );
    // After: Sun 2026-03-29 09:00 BST = 08:00Z. Still 09:00 to the user.
    expect(computeNextRun(weeklySunday(), at('2026-03-22T12:00:00.000Z'))).toBe(
      '2026-03-29T08:00:00.000Z',
    );
  });

  it('picks the requested weekday, not seven days from now', () => {
    // Wed 2026-03-25 → the coming Sunday, four days later.
    expect(computeNextRun(weeklySunday(), at('2026-03-25T00:00:00.000Z'))).toBe(
      '2026-03-29T08:00:00.000Z',
    );
  });
});

describe('schedule validation at save time', () => {
  it('rejects an unknown IANA zone', () => {
    expect(() => assertValidSchedule(daily(3, 0, 'Not/AZone'))).toThrow(InvalidScheduleError);
  });

  it('accepts a real IANA zone', () => {
    expect(() => assertValidSchedule(daily(3, 0, 'Europe/London'))).not.toThrow();
  });

  it('rejects a raw cron expression in the frequency field', () => {
    // FR-016: there is no free-text recurrence anywhere in this feature. A malformed cron
    // expression silently means "never", which is the worst failure a backup can have — it
    // looks configured and produces nothing.
    const cronish = { ...daily(3, 0, 'UTC'), frequency: '0 3 * * *' } as unknown as Schedule;
    expect(() => assertValidSchedule(cronish)).toThrow(InvalidScheduleError);
  });

  it('rejects an out-of-range hour, minute, weekday or day of month', () => {
    expect(() => assertValidSchedule({ ...daily(24, 0, 'UTC') })).toThrow(InvalidScheduleError);
    expect(() => assertValidSchedule({ ...daily(3, 60, 'UTC') })).toThrow(InvalidScheduleError);
    expect(() =>
      assertValidSchedule({ frequency: 'weekly', hour: 3, minute: 0, weekday: 8, timeZone: 'UTC' }),
    ).toThrow(InvalidScheduleError);
    expect(() =>
      assertValidSchedule({
        frequency: 'monthly',
        hour: 3,
        minute: 0,
        dayOfMonth: 32,
        timeZone: 'UTC',
      }),
    ).toThrow(InvalidScheduleError);
  });

  it('requires a weekday for a weekly schedule and a day of month for a monthly one', () => {
    expect(() =>
      assertValidSchedule({ frequency: 'weekly', hour: 3, minute: 0, timeZone: 'UTC' }),
    ).toThrow(InvalidScheduleError);
    expect(() =>
      assertValidSchedule({ frequency: 'monthly', hour: 3, minute: 0, timeZone: 'UTC' }),
    ).toThrow(InvalidScheduleError);
  });

  it('refuses to compute a next run for an invalid schedule rather than guessing', () => {
    expect(() => computeNextRun(daily(3, 0, 'Not/AZone'), at('2026-01-01T00:00:00.000Z'))).toThrow(
      InvalidScheduleError,
    );
  });
});

describe("the JOB's timezone decides, never the device's", () => {
  // M2. The failure this catches is a real and easy one: omitting `{ zone }` on a single Luxon
  // call. Luxon then silently falls back to `Settings.defaultZone`, the answer is right on the
  // developer's machine and in CI (both UTC), and wrong for every user who is not.
  const savedZone = Settings.defaultZone;
  afterEach(() => {
    Settings.defaultZone = savedZone;
  });

  it('computes from the stored zone while the process default is somewhere else', () => {
    const schedule = daily(1, 30, 'Europe/London');
    const now = at('2026-10-24T12:00:00.000Z');

    Settings.defaultZone = 'UTC';
    const fromUtcHost = computeNextRun(schedule, now);

    Settings.defaultZone = 'America/New_York';
    const fromNewYorkHost = computeNextRun(schedule, now);

    Settings.defaultZone = 'Asia/Kolkata'; // a half-hour offset, which exposes minute-level slips
    const fromKolkataHost = computeNextRun(schedule, now);

    expect(fromNewYorkHost).toBe(fromUtcHost);
    expect(fromKolkataHost).toBe(fromUtcHost);
    expect(fromUtcHost).toBe('2026-10-25T00:30:00.000Z');
  });
});
