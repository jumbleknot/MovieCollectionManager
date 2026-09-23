/**
 * ScheduleEditor — when a backup runs, and the consent that lets it (feature 073, T060 —
 * FR-016/FR-022; US4-AC2, US4-AC5).
 *
 * THERE IS NO FREE-TEXT RECURRENCE FIELD HERE, and that is a requirement rather than a styling
 * choice (FR-016). A box a user can type `0 3 * * *` into is a box they can type `0 3 * *` into,
 * and a malformed expression silently means "never" — a schedule that looks configured, reports
 * nothing wrong, and produces no backups at all. Every control below is a closed set.
 *
 * THE TIMEZONE IS A PROPERTY OF THE JOB, NOT OF THE DEVICE. It is DEFAULTED from the device
 * because that is almost always what the user means, and then STORED, so the backup window does
 * not silently move when they travel or when they next open the app on a different machine.
 * Shown plainly for the same reason: "03:00" is not a time unless you know where.
 *
 * CONSENT GATES THE SWITCH. Turning scheduling on does not turn it on — it asks. The prompt says
 * in plain words what is being granted, because "grant offline access" means nothing to the
 * person being asked, and an informed grant is the whole point of FR-022.
 */
import React, { useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { Text, useTheme } from '@tamagui/core';
import {
  Card,
  CardHeader,
  CardContent,
  CardActions,
  TextField,
  Chip,
  Switch,
  Banner,
  FilledButton,
  TextButton,
} from '@mcm/design-system';

import type { BackupFrequency, Schedule } from '@/types/backups';

export interface ScheduleEditorProps {
  /** The job's stored schedule, or null for on-demand only. */
  value: Schedule | null;
  /** Whether the standing permission has already been granted. */
  consentGranted: boolean;
  busy?: boolean;
  onChange: (schedule: Schedule | null) => void;
  /** Start the consent round trip. The caller opens the returned authorization URL. */
  onRequestConsent: () => void | Promise<void>;
  /** Give the standing permission up. */
  onRevokeConsent?: () => void | Promise<void>;
}

const FREQUENCIES: { value: BackupFrequency; label: string }[] = [
  { value: 'daily', label: 'Every day' },
  { value: 'weekly', label: 'Every week' },
  { value: 'monthly', label: 'Every month' },
];

// ISO weekday numbering, Monday = 1 — the same numbering the job stores, so nothing has to be
// converted between here and the arithmetic.
const WEEKDAYS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 7, label: 'Sun' },
];

/** The device's zone, used only as the DEFAULT for a new schedule. */
function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

export function ScheduleEditor({
  value,
  consentGranted,
  busy = false,
  onChange,
  onRequestConsent,
  onRevokeConsent,
}: ScheduleEditorProps): React.JSX.Element {
  const theme = useTheme();
  const [draft, setDraft] = useState<Schedule>(
    value ?? {
      frequency: 'daily',
      hour: 3,
      minute: 0,
      timeZone: deviceTimeZone(),
    },
  );
  const [hourText, setHourText] = useState(pad(draft.hour));
  const [minuteText, setMinuteText] = useState(pad(draft.minute));
  const [dayOfMonthText, setDayOfMonthText] = useState(String(draft.dayOfMonth ?? 1));

  const enabled = value !== null;

  const hour = Number.parseInt(hourText, 10);
  const minute = Number.parseInt(minuteText, 10);
  const dayOfMonth = Number.parseInt(dayOfMonthText, 10);
  const hourValid = Number.isInteger(hour) && hour >= 0 && hour <= 23;
  const minuteValid = Number.isInteger(minute) && minute >= 0 && minute <= 59;
  const dayValid = Number.isInteger(dayOfMonth) && dayOfMonth >= 1 && dayOfMonth <= 31;

  const timeValid =
    hourValid &&
    minuteValid &&
    (draft.frequency !== 'weekly' || draft.weekday !== undefined) &&
    (draft.frequency !== 'monthly' || dayValid);

  function emit(next: Partial<Schedule>): void {
    const merged: Schedule = {
      ...draft,
      ...next,
      hour: hourValid ? hour : draft.hour,
      minute: minuteValid ? minute : draft.minute,
      ...(('frequency' in next ? next.frequency : draft.frequency) === 'monthly'
        ? { dayOfMonth: dayValid ? dayOfMonth : 1 }
        : {}),
    };
    setDraft(merged);
    if (enabled && timeValid) onChange(merged);
  }

  function toggleScheduling(on: boolean): void {
    if (!on) {
      onChange(null);
      return;
    }
    // Consent FIRST. The schedule does not become active until it is given (US4-AC2).
    if (!consentGranted) {
      void onRequestConsent();
      return;
    }
    onChange(draft);
  }

  return (
    <Card testID="backup-schedule-editor">
      <CardHeader
        title="Run this backup automatically"
        subtitle="Backups happen on their own, even when you are not signed in"
      />
      <CardContent>
        <View style={styles.row}>
          <Switch
            testID="backup-schedule-enabled"
            value={enabled}
            onValueChange={toggleScheduling}
            disabled={busy}
            label="Run this backup automatically"
          />
          <Text fontFamily="$body" fontSize={14} color={theme.onSurface?.val} marginLeft={12}>
            {enabled ? 'On' : 'Off'}
          </Text>
        </View>

        {!consentGranted && (
          // Plain words, not "grant offline access". The user is being asked to let this system
          // read their collections while they are not here; anything less specific is not
          // informed consent, it is a dialog they clicked through.
          <View testID="backup-consent-prompt" style={styles.section}>
            <Banner tone="error" testID="backup-consent-banner">
              To back up on a schedule, this app needs your permission to read your collections
              while you are signed out. You will be asked to sign in once to confirm it. You can
              take the permission away at any time by turning every schedule off.
            </Banner>
            <CardActions>
              <FilledButton
                label="Give permission"
                onPress={() => void onRequestConsent()}
                disabled={busy}
                testID="backup-consent-grant"
              />
            </CardActions>
          </View>
        )}

        {consentGranted && onRevokeConsent && (
          <View style={styles.section}>
            <TextButton
              label="Withdraw permission"
              onPress={() => void onRevokeConsent()}
              disabled={busy}
              testID="backup-consent-revoke"
            />
          </View>
        )}

        {enabled && (
          <>
            <Text fontFamily="$body" fontSize={12} color={theme.onSurfaceVariant?.val} marginTop={16}>
              How often
            </Text>
            <View style={styles.chipRow}>
              {FREQUENCIES.map((f) => (
                <Chip
                  key={f.value}
                  label={f.label}
                  selected={draft.frequency === f.value}
                  onPress={() =>
                    emit({
                      frequency: f.value,
                      // Carry only the field the new frequency uses, so a job cannot end up
                      // stored with both a weekday and a day of the month.
                      weekday: f.value === 'weekly' ? (draft.weekday ?? 1) : undefined,
                      dayOfMonth: f.value === 'monthly' ? (dayValid ? dayOfMonth : 1) : undefined,
                    })
                  }
                  testID={`backup-schedule-frequency-${f.value}`}
                />
              ))}
            </View>

            {draft.frequency === 'weekly' && (
              <>
                <Text
                  fontFamily="$body"
                  fontSize={12}
                  color={theme.onSurfaceVariant?.val}
                  marginTop={16}
                >
                  On which day
                </Text>
                <View style={styles.chipRow}>
                  {WEEKDAYS.map((d) => (
                    <Chip
                      key={d.value}
                      label={d.label}
                      selected={draft.weekday === d.value}
                      onPress={() => emit({ weekday: d.value })}
                      testID={`backup-schedule-weekday-${d.value}`}
                    />
                  ))}
                </View>
              </>
            )}

            {draft.frequency === 'monthly' && (
              <TextField
                label="Day of the month"
                value={dayOfMonthText}
                onChangeText={(t) => {
                  setDayOfMonthText(t);
                  const parsed = Number.parseInt(t, 10);
                  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 31) {
                    emit({ dayOfMonth: parsed });
                  }
                }}
                keyboardType="number-pad"
                error={dayOfMonthText !== '' && !dayValid}
                errorText="Choose a day between 1 and 31"
                // The clamp, stated where the user chooses the number — otherwise picking the
                // 31st looks like it will skip February, which is exactly what it must not do.
                supportingText="In a shorter month this runs on the last day instead, never skipping the month"
                testID="backup-schedule-day-of-month"
              />
            )}

            <View style={styles.timeRow}>
              <View style={styles.timeField}>
                <TextField
                  label="Hour"
                  value={hourText}
                  onChangeText={(t) => {
                    setHourText(t);
                    const parsed = Number.parseInt(t, 10);
                    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 23) emit({ hour: parsed });
                  }}
                  keyboardType="number-pad"
                  error={hourText !== '' && !hourValid}
                  errorText="0–23"
                  testID="backup-schedule-hour"
                />
              </View>
              <View style={styles.timeField}>
                <TextField
                  label="Minute"
                  value={minuteText}
                  onChangeText={(t) => {
                    setMinuteText(t);
                    const parsed = Number.parseInt(t, 10);
                    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 59) emit({ minute: parsed });
                  }}
                  keyboardType="number-pad"
                  error={minuteText !== '' && !minuteValid}
                  errorText="0–59"
                  testID="backup-schedule-minute"
                />
              </View>
            </View>

            <Text
              fontFamily="$body"
              fontSize={12}
              color={theme.onSurfaceVariant?.val}
              marginTop={12}
              testID="backup-schedule-timezone"
            >
              Times are in {draft.timeZone}. This stays with the backup, so travelling does not
              move it.
            </Text>
          </>
        )}
      </CardContent>
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  section: { marginTop: 16 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  timeRow: { flexDirection: 'row', gap: 12, marginTop: 16 },
  timeField: { flex: 1 },
});
