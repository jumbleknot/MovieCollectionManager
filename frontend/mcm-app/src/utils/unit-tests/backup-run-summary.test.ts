// Surfacing a run, and when the next one is due (feature 073, T065 — FR-036/FR-037; US6-AC1..AC4).
//
// PURE. Every value is an argument, including `now` and the zone, so "what does the user see"
// is reachable from a test without a clock, a device locale or a rendered tree.
//
// THE TWO RULES WORTH THE FILE:
//
//   FR-037 — a failure stays visible until a LATER RUN SUCCEEDS. Not until the page is
//   reloaded, not until the user dismisses it, and not until a later run merely happens. A
//   backup that silently stopped is the failure this whole feature exists to prevent, and a
//   banner that clears itself re-creates it.
//
//   FR-036 — the next run is shown in the JOB's timezone. The device's zone is not the answer:
//   a user who set 03:00 in Europe/London and then opens the app in New York must still be told
//   03:00, or they will think the schedule moved.
//
// FEATURE 077: the device zone is simulated with `process.env.TZ`, not Luxon's
// `Settings.defaultZone`. The module no longer uses Luxon (it left the client bundle with 70 KB
// attached), and a test that moves a setting the subject does not read is a test that cannot
// fail. `process.env.TZ` moves the PLATFORM zone that `Intl` actually resolves against — verified
// to shift a zone-less format from 02:00 to 22:00 to 07:30 — so these assertions got stronger in
// the move, not weaker.

import {
  formatArtifactSize,
  formatRunDuration,
  formatNextRun,
  shouldShowFailureBanner,
  describeCollectionCounts,
} from '@/utils/backup-run-summary';
import type { RunSummary } from '@/types/backups';

const run = (over: Partial<RunSummary> = {}): RunSummary => ({
  runId: 'r1',
  status: 'success',
  startedAt: '2026-06-15T03:00:00.000Z',
  finishedAt: '2026-06-15T03:00:12.000Z',
  collectionCount: 3,
  movieCount: 10,
  artifactBytes: 885,
  ...over,
});

describe('how long a run took', () => {
  it('reports seconds for a short run', () => {
    expect(formatRunDuration(run())).toBe('12s');
  });

  it('reports minutes and seconds for a longer one', () => {
    expect(
      formatRunDuration(run({ finishedAt: '2026-06-15T03:01:04.000Z' })),
    ).toBe('1m 04s');
  });

  it('says nothing rather than guessing while a run is still going', () => {
    // A run with no finish time has no duration. Substituting `now` would show a number that
    // grows every render and reads as a stuck backup.
    expect(formatRunDuration(run({ status: 'running', finishedAt: undefined }))).toBeNull();
  });

  it('says nothing when the timestamps are the wrong way round', () => {
    // Clock adjustments happen. A negative duration is worse than an absent one.
    expect(
      formatRunDuration(run({ startedAt: '2026-06-15T03:00:12.000Z', finishedAt: '2026-06-15T03:00:00.000Z' })),
    ).toBeNull();
  });
});

describe('how big the artifact was', () => {
  it.each([
    [0, '0 B'],
    [885, '885 B'],
    [2048, '2.0 KB'],
    [5_242_880, '5.0 MB'],
  ])('renders %s bytes as %s', (bytes, expected) => {
    expect(formatArtifactSize(bytes)).toBe(expected);
  });

  it('says nothing for a run that wrote nothing', () => {
    // A failed run has no artifact. "0 B" would claim an empty backup exists.
    expect(formatArtifactSize(undefined)).toBeNull();
  });
});

describe('when the next run is due', () => {
  const savedTz = process.env.TZ;
  afterEach(() => {
    process.env.TZ = savedTz;
  });

  it("renders in the JOB's zone, whatever the device is set to", () => {
    // 2026-06-15T02:00:00Z is 03:00 BST. The user set 03:00 and must be told 03:00.
    const nextRunAt = '2026-06-15T02:00:00.000Z';

    process.env.TZ = 'America/New_York';
    const shown = formatNextRun(nextRunAt, 'Europe/London');

    expect(shown).toContain('03:00');
    // And it names the zone, because "03:00" alone is not a time.
    expect(shown).toContain('Europe/London');
    // The device's zone must not appear anywhere in it.
    expect(shown).not.toContain('New_York');
    // Nor may the device's wall clock (22:00 in New York) leak in.
    expect(shown).not.toContain('22:00');
  });

  it('gives the same answer from three different device zones', () => {
    const nextRunAt = '2026-06-15T02:00:00.000Z';
    const answers = ['UTC', 'America/New_York', 'Asia/Kolkata'].map((zone) => {
      process.env.TZ = zone;
      return formatNextRun(nextRunAt, 'Europe/London');
    });
    expect(new Set(answers).size).toBe(1);
  });

  it('says so plainly when a job has no schedule', () => {
    expect(formatNextRun(undefined, 'Europe/London')).toBe('Not scheduled');
  });

  // ── Feature 077 (T001): the two cases the Intl replacement can get wrong ──────────────────
  //
  // Luxon returned an INVALID DateTime for an unknown zone, which the existing
  // `if (!dt.isValid)` branch turned into 'Not scheduled'. `Intl.DateTimeFormat` THROWS
  // `RangeError` instead. Without a catch, a stored-but-unrecognised zone stops being a
  // formatted string and becomes an unhandled exception inside a settings screen.
  it('says "Not scheduled" rather than throwing when the zone is not a real zone', () => {
    expect(() => formatNextRun('2026-06-15T02:00:00.000Z', 'Not/AZone')).not.toThrow();
    expect(formatNextRun('2026-06-15T02:00:00.000Z', 'Not/AZone')).toBe('Not scheduled');
  });

  it('says "Not scheduled" rather than throwing when the instant is unparseable', () => {
    expect(() => formatNextRun('not-a-date', 'Europe/London')).not.toThrow();
    expect(formatNextRun('not-a-date', 'Europe/London')).toBe('Not scheduled');
  });

  // Pins the offset handling either side of a DST transition. A formatter built with a fixed
  // offset rather than a named zone passes the winter case and fails this one.
  it('uses the offset in force on the day, not a fixed one', () => {
    // Winter: London is UTC+0, so 03:00Z is 03:00 local.
    expect(formatNextRun('2026-01-03T03:00:00.000Z', 'Europe/London')).toContain('03:00');
    // Summer: London is UTC+1, so the same 03:00Z is 04:00 local.
    expect(formatNextRun('2026-07-03T03:00:00.000Z', 'Europe/London')).toContain('04:00');
  });

  // The exact shape the screen renders. This is the assertion that catches formatting drift
  // between Luxon's `d LLL yyyy, HH:mm` and the Intl option set that replaces it.
  it('renders the exact string the screen shows', () => {
    expect(formatNextRun('2026-01-03T03:00:00.000Z', 'Europe/London')).toBe(
      '3 Jan 2026, 03:00 (Europe/London)',
    );
  });
});

describe('the failure banner (FR-037)', () => {
  it('shows when the most recent run failed', () => {
    expect(shouldShowFailureBanner(run({ status: 'failed', failureReason: 'nope' }))).toBe(true);
  });

  it('keeps showing while the most recent run is still the failed one', () => {
    // The banner is derived from the LATEST run, so it persists across reloads by construction
    // — there is no dismissal state that could clear it early.
    const failed = run({ status: 'failed', failureReason: 'nope' });
    expect(shouldShowFailureBanner(failed)).toBe(true);
    expect(shouldShowFailureBanner(failed)).toBe(true);
  });

  it('clears once a LATER run succeeds', () => {
    expect(shouldShowFailureBanner(run({ status: 'success' }))).toBe(false);
  });

  it('does NOT clear because a later run is merely in progress', () => {
    // A running run has not succeeded. Clearing here would hide the failure at exactly the
    // moment the user is watching to see whether it recovered.
    expect(shouldShowFailureBanner(run({ status: 'running', finishedAt: undefined }))).toBe(true);
  });

  it('shows for a PARTIAL run', () => {
    // Part of the user's data did not make it in. That is not a success.
    expect(shouldShowFailureBanner(run({ status: 'partial' }))).toBe(true);
  });

  it('does NOT fire for a prune failure on an otherwise successful run', () => {
    // FR-027: a prune that failed has not cost the user the backup that was just written.
    // Raising the run-failed banner for it would tell them their backup did not happen.
    expect(
      shouldShowFailureBanner(run({ status: 'success', pruneFailureReason: 'could not remove 1' })),
    ).toBe(false);
  });

  it('shows nothing for a job that has never run', () => {
    expect(shouldShowFailureBanner(undefined)).toBe(false);
  });
});

describe('per-collection counts, and nothing else (US6-AC4)', () => {
  it('summarises the counts without naming any movie', () => {
    const line = describeCollectionCounts([
      { collectionId: 'c1', name: 'Sci-Fi', movieCount: 7 },
      { collectionId: 'c2', name: 'Noir', movieCount: 3 },
    ]);
    expect(line).toBe('Sci-Fi (7), Noir (3)');
  });

  it('is empty rather than misleading when nothing was counted', () => {
    expect(describeCollectionCounts([])).toBeNull();
  });

  it('carries no ids — a collection id is not something to render at the user', () => {
    const line = describeCollectionCounts([{ collectionId: 'c-secret-id', name: 'Sci-Fi', movieCount: 7 }]);
    expect(line).not.toContain('c-secret-id');
  });
});
