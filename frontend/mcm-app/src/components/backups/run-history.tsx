/**
 * RunHistory — what happened, when, and when it happens next (feature 073, T066 — FR-036/037;
 * US6-AC1..AC4).
 *
 * A FAILED run is shown as prominently as a successful one. A backup that silently stopped
 * working is the failure mode this whole feature exists to prevent, and a failure the user
 * never sees is a failure twice — once when the backup did not happen, and again when they
 * find out at restore.
 *
 * ALL DERIVATION LIVES IN `backup-run-summary`, not here. The rules that matter — a failure
 * persisting until a later run SUCCEEDS, the next run rendered in the JOB's zone rather than
 * the device's — are the ones that go wrong quietly, and they are testable there without a
 * rendered tree.
 *
 * NOTHING SENSITIVE IS RENDERED (US6-AC4). Every string below is built from counts, names,
 * sizes and timestamps. No destination credential and no collection content reaches this
 * component, because the run record never carries either.
 */
import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Text, useTheme } from '@tamagui/core';
import { Card, CardHeader, CardContent, Badge, Banner } from '@mcm/design-system';

import {
  describeCollectionCounts,
  formatArtifactSize,
  formatNextRun,
  formatRunDuration,
  shouldShowFailureBanner,
} from '@/bff-server/backup-run-summary';
import type { RunSummary } from '@/types/backups';

export interface RunHistoryProps {
  runs: RunSummary[];
  lastRun?: RunSummary;
  /** The job's next occurrence, and the zone it was scheduled in — not the device's. */
  nextRunAt?: string;
  timeZone?: string;
}

const TONE: Record<string, 'primary' | 'error' | 'tertiary'> = {
  success: 'primary',
  failed: 'error',
  partial: 'tertiary',
  running: 'tertiary',
};

/** "15 Jun 2026, 03:00" — a timestamp a person can read, in their own locale. */
function readableInstant(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function RunHistory({
  runs,
  lastRun,
  nextRunAt,
  timeZone,
}: RunHistoryProps): React.JSX.Element {
  const theme = useTheme();

  return (
    <View testID="backup-run-history">
      {shouldShowFailureBanner(lastRun) ? (
        // Top of the section, not buried in the list — this is the thing the user must act on.
        // It is derived from the newest run, so it persists across reloads and cannot be
        // dismissed into invisibility; only a later SUCCESSFUL run clears it (FR-037).
        <View style={styles.banner}>
          <Banner tone="error" testID="backup-failure-banner">
            {lastRun?.status === 'partial'
              ? `The last backup only partly completed: ${lastRun.failureReason ?? 'some collections were not included'}`
              : `The last backup failed: ${lastRun?.failureReason ?? 'reason unavailable'}`}
          </Banner>
        </View>
      ) : null}

      {/*
        ALWAYS RENDERED, including for a job with no schedule — "Not scheduled" is an answer and
        an absent line is not. Hiding it left a user unable to tell "this runs nightly" from
        "this only runs when I press the button", which is the distinction the line exists for.
      */}
      <View style={styles.nextRun}>
        <Text
          fontFamily="$body"
          fontSize={12}
          color={theme.onSurfaceVariant?.val}
          testID="backup-next-run"
        >
          {`Next run: ${formatNextRun(nextRunAt, timeZone ?? 'UTC')}`}
        </Text>
      </View>

      <Card>
        <CardHeader title="Recent runs" subtitle="The last few backups for this job" />
        <CardContent>
          {runs.length === 0 ? (
            <Text fontFamily="$body" fontSize={14} color={theme.onSurfaceVariant?.val}>
              This job has not run yet.
            </Text>
          ) : (
            runs.map((run) => {
              const duration = formatRunDuration(run);
              const size = formatArtifactSize(run.artifactBytes);
              const perCollection = describeCollectionCounts(run.collectionCounts ?? []);
              // Only the parts that exist. A running run has no duration and a failed one has
              // no size, and rendering an em-dash for each is noise rather than information.
              const facts = [
                readableInstant(run.startedAt),
                duration,
                `${run.movieCount} movies in ${run.collectionCount} collections`,
                size,
              ].filter(Boolean);

              return (
                <View key={run.runId} style={styles.row} testID={`backup-run-${run.runId}`}>
                  <Badge inline count={run.status} colorScheme={TONE[run.status] ?? 'tertiary'} />
                  <View style={styles.facts}>
                    <Text fontFamily="$body" fontSize={12} color={theme.onSurfaceVariant?.val}>
                      {facts.join(' · ')}
                    </Text>
                    {perCollection ? (
                      <Text
                        fontFamily="$body"
                        fontSize={12}
                        color={theme.onSurfaceVariant?.val}
                        testID={`backup-run-collections-${run.runId}`}
                      >
                        {perCollection}
                      </Text>
                    ) : null}
                    {run.failureReason ? (
                      <Text fontFamily="$body" fontSize={12} color={theme.error?.val}>
                        {run.failureReason}
                      </Text>
                    ) : null}
                    {run.pruneFailureReason ? (
                      // Reported SEPARATELY from the run's status and in a calmer tone: a
                      // prune that failed has not cost the user the backup that was just
                      // written, and colouring it as an error would say that it had.
                      <Text
                        fontFamily="$body"
                        fontSize={12}
                        color={theme.onSurfaceVariant?.val}
                        testID={`backup-run-prune-note-${run.runId}`}
                      >
                        {`Older versions were not removed: ${run.pruneFailureReason}`}
                      </Text>
                    ) : null}
                  </View>
                </View>
              );
            })
          )}
        </CardContent>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: { marginBottom: 16 },
  nextRun: { marginBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: 12 },
  facts: { flex: 1, gap: 2 },
});
