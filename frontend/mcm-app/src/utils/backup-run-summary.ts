// Turning a run record into what the user reads (feature 073, T065 — FR-036/FR-037; US6).
//
// PURE, and deliberately separate from the component that renders it. The two rules below are
// the ones that go wrong quietly, and neither is about layout:
//
//   FR-037 — a failure stays visible until a LATER RUN SUCCEEDS. Derived from the newest run
//   rather than held as dismissable state, so it survives a reload by construction and there is
//   nothing that could clear it early.
//
//   FR-036 — the next run is shown in the JOB's zone. A user who set 03:00 in Europe/London and
//   opens the app in New York must still be told 03:00, or they will think the schedule moved.
//
// NOTHING HERE READS A CLOCK, a device locale or a stored preference. Every input is an
// argument, which is what makes the awkward cases reachable from a test.
//
// WHY THIS IS IN THE UTILS-LAYER (feature 077). It used to live under `src/bff-server/`, and
// `run-history.tsx` — a client component — imported it. The constitution's BFF-Layer "must run
// server-side and never be included client-side", so that import shipped this module AND its
// `luxon` dependency to the browser: 70 KB on every route, for one formatted timestamp. The header
// above already described a pure function of its arguments, which is the Utils-Layer's definition;
// only the directory disagreed. `scripts/check-no-server-imports.mjs` now fails on a repeat.
//
// `Intl.DateTimeFormat` replaced `luxon` here for the same reason — it is a platform global, so it
// costs nothing to ship. Verified byte-identical to Luxon's `d LLL yyyy, HH:mm` across DST-on and
// DST-off London, a negative offset and a half-hour zone (specs/077-web-bundle-diet/research.md R4).
// `luxon` remains a dependency: `bff-server/backup-schedule.ts` still uses it, server-side, where
// its cost is nobody's download.

import type { BackupCollectionCount, RunSummary } from '@/types/backups';

/**
 * How long the run took, or `null` while it is still going.
 *
 * `null` rather than a number-so-far: substituting `now` for the missing finish time shows a
 * value that grows on every render, which reads as a stuck backup rather than a running one.
 * A negative span — clocks do get adjusted — is also `null`, because a wrong duration is worse
 * than an absent one.
 */
export function formatRunDuration(run: Pick<RunSummary, 'startedAt' | 'finishedAt'>): string | null {
  if (!run.finishedAt) return null;
  const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;

  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/**
 * The compressed size, or `null` when there is no artifact.
 *
 * A failed run wrote nothing, and "0 B" would claim an empty backup exists — which is exactly
 * the impression the user must not be given about a run that did not happen.
 */
export function formatArtifactSize(bytes: number | undefined): string | null {
  if (bytes === undefined || bytes === null || !Number.isFinite(bytes)) return null;
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/**
 * When the job next runs, in the JOB's zone, with the zone named.
 *
 * The zone is named because "03:00" on its own is not a time — and this is the one screen where
 * the difference between the job's zone and the reader's is the whole point.
 */
export function formatNextRun(nextRunAt: string | undefined, timeZone: string): string {
  if (!nextRunAt) return 'Not scheduled';
  const instant = new Date(nextRunAt);
  if (Number.isNaN(instant.getTime())) return 'Not scheduled';
  try {
    // `timeZone` explicitly on every call: omitting it falls back to the PLATFORM's zone — right on
    // a developer's machine and in CI, wrong for everyone else. `en-GB` rather than the device
    // locale for the same reason the zone is explicit: the string must not change with who is
    // reading it. `hour12: false` because a schedule set at 03:00 must not be shown as 3 AM.
    const shown = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(instant);
    return `${shown} (${timeZone})`;
  } catch {
    // An unrecognised zone. Luxon returned an invalid DateTime here, which the old `!dt.isValid`
    // branch turned into 'Not scheduled'; `Intl.DateTimeFormat` THROWS `RangeError` instead. Without
    // this catch a stored-but-unknown zone stops being a formatted string and becomes an unhandled
    // exception inside a settings screen — the one behavioural difference in the swap.
    return 'Not scheduled';
  }
}

/**
 * Should the failure banner be up? (FR-037)
 *
 * Read from the NEWEST run only. `success` clears it; everything else does not:
 *
 *   - `failed`  — the obvious case.
 *   - `partial` — some of the user's data did not make it in. That is not a success.
 *   - `running` — a later run being in progress has not succeeded yet, and clearing here would
 *     hide the failure at exactly the moment the user is watching to see if it recovered.
 *
 * A PRUNE failure never raises it. FR-027 keeps that separate on purpose: the backup the user
 * asked for did happen, and this banner says it did not.
 */
export function shouldShowFailureBanner(lastRun: RunSummary | undefined): boolean {
  if (!lastRun) return false;
  return lastRun.status !== 'success';
}

/**
 * "Sci-Fi (7), Noir (3)" — names and counts, and nothing else.
 *
 * No collection ids and no movie titles (US6-AC4). The counts are what the user is checking;
 * the contents are what must never be echoed back out of a backup record.
 */
export function describeCollectionCounts(counts: BackupCollectionCount[]): string | null {
  if (!counts || counts.length === 0) return null;
  return counts.map((c) => `${c.name} (${c.movieCount})`).join(', ');
}
