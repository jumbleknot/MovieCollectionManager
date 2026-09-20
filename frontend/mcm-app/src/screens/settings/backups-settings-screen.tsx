/**
 * BackupsSettingsScreen — the Backups area of the settings destination.
 *
 * Feature 062 shipped this as a placeholder specifically so that backlog item #236 would
 * replace its BODY and touch nothing else. That is what this is: the route, its registry row,
 * its label and its reported `current_screen` (`settings-backups`) are all UNCHANGED. The
 * agent gateway's current_screen vocabulary is a contract covered by
 * test_current_screen_contract.py, and altering it here would break the assistant's context
 * resolution for a screen the assistant does not otherwise care about.
 *
 * Feature 073: configure destinations (US1), take a backup (US2), and restore from one (US3).
 * Scheduling and retention land on top of this, in this same screen.
 */

import React, { useState } from 'react';
import { ScrollView, View, StyleSheet } from 'react-native';
import { Text, useTheme } from '@tamagui/core';
import { Card, CardHeader, CardContent, CardActions, FilledButton, TextButton, Banner } from '@mcm/design-system';

import { DestinationForm } from '@/components/backups/destination-form';
import { DestinationList } from '@/components/backups/destination-list';
import { JobForm } from '@/components/backups/job-form';
import { RunHistory } from '@/components/backups/run-history';
import { VersionList } from '@/components/backups/version-list';
import { useBackupDestinations, type DestinationDraft } from '@/hooks/use-backup-destinations';
import { useBackupJobs, type JobDraft, type JobView } from '@/hooks/use-backup-jobs';
import { useCollections } from '@/hooks/use-collections';
import type { BackupDestinationView, BackupTestResult, BackupVersion, RunSummary } from '@/types/backups';

export function BackupsSettingsScreen(): React.JSX.Element {
  const theme = useTheme();
  const { destinations, loading, busy, error, create, update, remove, test } = useBackupDestinations();
  const jobs = useBackupJobs();
  const { collections } = useCollections();

  const [editing, setEditing] = useState<BackupDestinationView | null>(null);
  const [adding, setAdding] = useState(false);
  const [testResult, setTestResult] = useState<BackupTestResult | null>(null);

  const [addingJob, setAddingJob] = useState(false);
  const [editingJob, setEditingJob] = useState<JobView | null>(null);
  const [openJobId, setOpenJobId] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [versions, setVersions] = useState<BackupVersion[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const openJob = async (job: JobView) => {
    setOpenJobId(job.id);
    setRuns(await jobs.listRuns(job.id));
    setVersions(await jobs.listVersions(job.id));
  };

  const refreshOpenJob = async (jobId: string) => {
    setRuns(await jobs.listRuns(jobId));
    setVersions(await jobs.listVersions(jobId));
  };

  const submitJob = async (draft: JobDraft) => {
    const saved = editingJob ? await jobs.update(editingJob.id, draft) : await jobs.create(draft);
    if (saved) {
      setAddingJob(false);
      setEditingJob(null);
    }
  };

  const closeForm = () => {
    setAdding(false);
    setEditing(null);
    setTestResult(null);
  };

  const submit = async (draft: DestinationDraft) => {
    const saved = editing ? await update(editing.id, draft) : await create(draft);
    if (saved) closeForm();
  };

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: theme.background?.val }]}
      contentContainerStyle={styles.content}
      /* STABLE EXTERNAL-CONTRACT SELECTOR — the Backups area container. Unchanged from 062. */
      testID="settings-backups-screen"
    >
      <Card>
        <CardHeader title="Backups" subtitle="Back up and restore your collections" />
        <CardContent>
          <Text
            fontFamily="$body"
            fontSize={14}
            lineHeight={20}
            letterSpacing={0.25}
            color={theme.onSurfaceVariant?.val}
          >
            Back up your collections to storage you control. MCM writes the backup and keeps no
            copy of it, so you can read or restore it without depending on this system.
          </Text>
        </CardContent>
      </Card>

      {error ? (
        <View style={styles.section}>
          <Banner tone="error" testID="backup-error-banner">
            {error}
          </Banner>
        </View>
      ) : null}

      <View style={styles.section}>
        {adding || editing ? (
          <DestinationForm
            existing={editing}
            busy={busy}
            testResult={testResult}
            onSubmit={submit}
            onTest={async (draft) => setTestResult(await test(draft))}
            onCancel={closeForm}
          />
        ) : (
          <Card>
            <CardHeader title="Destinations" subtitle="Where your backups are written" />
            <CardContent>
              {loading ? (
                <Text fontFamily="$body" fontSize={14} color={theme.onSurfaceVariant?.val}>
                  Loading your destinations…
                </Text>
              ) : (
                <DestinationList
                  destinations={destinations}
                  busy={busy}
                  onEdit={(d) => {
                    setTestResult(null);
                    setEditing(d);
                  }}
                  onDelete={(d) => remove(d.id)}
                  onTest={async (d) => setTestResult(await test({ destinationId: d.id }))}
                />
              )}
            </CardContent>
            <CardActions>
              <FilledButton
                label="Add a destination"
                onPress={() => setAdding(true)}
                disabled={busy}
                testID="backup-destination-add"
              />
            </CardActions>
          </Card>
        )}
      </View>

      {/* The probe result when NO form is open — pressing Test on a SAVED destination in the
          list set this state and nothing rendered it, so the user got no feedback whatsoever.
          Found by the E2E; the integration tier asserts the HTTP response and structurally
          cannot see that the answer never reached the screen. The form renders its own copy
          under the same testID, and the two are mutually exclusive: this branch requires no
          form to be open. */}
      {testResult && !adding && !editing ? (
        <View style={styles.section}>
          <Banner
            tone={testResult.ok ? 'success' : 'error'}
            testID="backup-destination-test-result"
          >
            {testResult.ok
              ? 'Reached that destination and confirmed it can be written to.'
              : testResult.reason}
          </Banner>
        </View>
      ) : null}

      {notice ? (
        <View style={styles.section}>
          <Banner tone="success" testID="backup-notice-banner">
            {notice}
          </Banner>
        </View>
      ) : null}

      <View style={styles.section}>
        {addingJob || editingJob ? (
          <JobForm
            destinations={destinations}
            collections={collections.map((c) => ({ id: c.collectionId, name: c.name }))}
            existing={editingJob}
            busy={jobs.busy}
            onSubmit={submitJob}
            onCancel={() => {
              setAddingJob(false);
              setEditingJob(null);
            }}
          />
        ) : (
          <Card>
            <CardHeader title="Backup jobs" subtitle="What gets backed up, and where it goes" />
            <CardContent>
              {jobs.loading ? (
                <Text fontFamily="$body" fontSize={14} color={theme.onSurfaceVariant?.val}>
                  Loading your backups…
                </Text>
              ) : jobs.jobs.length === 0 ? (
                <Text fontFamily="$body" fontSize={14} lineHeight={20} color={theme.onSurfaceVariant?.val}>
                  No backups set up yet. Add a destination above, then create one here.
                </Text>
              ) : (
                <View testID="backup-job-list">
                  {jobs.jobs.map((job) => (
                    <View key={job.id} style={styles.jobRow}>
                      <Card testID={`backup-job-${job.id}`}>
                        <CardHeader
                          title={job.label}
                          subtitle={
                            job.lastRun
                              ? `Last run ${job.lastRun.startedAt} — ${job.lastRun.status}`
                              : 'Never run'
                          }
                        />
                        <CardActions>
                          <FilledButton
                            label="Back up now"
                            // Disabled WHILE A RUN IS IN FLIGHT. The 409 from the server is the
                            // real guarantee; this is so a user who can click twice is not told
                            // the feature is broken when it is working correctly.
                            disabled={jobs.busy}
                            onPress={async () => {
                              const summary = await jobs.runNow(job.id);
                              if (summary) {
                                setNotice(
                                  summary.status === 'success'
                                    ? `Backed up ${summary.movieCount} movies.`
                                    : `That backup did not finish: ${summary.failureReason ?? 'reason unavailable'}`,
                                );
                                if (openJobId === job.id) await refreshOpenJob(job.id);
                              }
                            }}
                            testID={`backup-job-run-${job.id}`}
                          />
                          <TextButton
                            label={openJobId === job.id ? 'Hide versions' : 'Versions'}
                            disabled={jobs.busy}
                            onPress={() => (openJobId === job.id ? setOpenJobId(null) : openJob(job))}
                            testID={`backup-job-versions-${job.id}`}
                          />
                          <TextButton
                            label="Edit"
                            disabled={jobs.busy}
                            onPress={() => setEditingJob(job)}
                            testID={`backup-job-edit-${job.id}`}
                          />
                          <TextButton
                            label="Delete"
                            danger
                            disabled={jobs.busy}
                            onPress={() => jobs.remove(job.id)}
                            testID={`backup-job-delete-${job.id}`}
                          />
                        </CardActions>
                      </Card>

                      {openJobId === job.id ? (
                        <View style={styles.section}>
                          <RunHistory runs={runs} lastRun={job.lastRun} />
                          <View style={styles.section}>
                            <VersionList
                              versions={versions}
                              busy={jobs.busy}
                              downloadUrl={(key) => jobs.downloadUrl(job.id, key)}
                              onRestore={async (version) => {
                                const outcome = await jobs.restore(job.id, version.key);
                                if (outcome) {
                                  setNotice(
                                    `Restored ${outcome.movieCount} movies into ${outcome.createdCollectionIds.length} new collection(s).` +
                                      (outcome.partial ? ' Some records could not be restored.' : ''),
                                  );
                                }
                              }}
                            />
                          </View>
                        </View>
                      ) : null}
                    </View>
                  ))}
                </View>
              )}
            </CardContent>
            <CardActions>
              <FilledButton
                label="Set up a backup"
                onPress={() => setAddingJob(true)}
                disabled={jobs.busy || destinations.length === 0}
                testID="backup-job-add"
              />
            </CardActions>
          </Card>
        )}
      </View>

      {jobs.error ? (
        <View style={styles.section}>
          <Banner tone="error" testID="backup-job-error-banner">
            {jobs.error}
          </Banner>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  // Layout only, on the base-8 grid. Every colour and type decision is made at the JSX site
  // from theme roles, so a declared style cannot drift from the rendered colour.
  container: { flex: 1 },
  content: { padding: 16, paddingBottom: 96 },
  section: { marginTop: 16 },
  jobRow: { marginBottom: 16 },
});
