/**
 * Admin settings screen (feature 040 US3 / Item 1) — mc-admin only.
 * The first admin UI in the app. Currently a single control: toggle user self-registration.
 */

import React from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { useTheme } from '@tamagui/core';
import { Switch, Card, CardContent } from '@mcm/design-system';
import { useAppSettings } from '@/hooks/use-app-settings';

export function AdminSettingsScreen(): React.JSX.Element {
  const theme = useTheme();
  const styles = makeStyles(theme);
  const { settings, loading, saving, error, setAllowSelfRegistration } = useAppSettings();

  return (
    <View style={styles.container} testID="admin-settings-screen">
      <Text style={styles.title}>Admin Settings</Text>

      <Card>
        <CardContent>
          <View style={styles.row}>
            <View style={styles.labelCol}>
              <Text style={styles.label}>Allow user self-registration</Text>
              <Text style={styles.help}>
                When off, new visitors cannot create an account and the “Create Account” link is
                hidden.
              </Text>
            </View>
            {loading ? (
              <ActivityIndicator testID="admin-settings-loading" color={theme.primary?.val} />
            ) : (
              <Switch
                value={settings?.allowSelfRegistration ?? true}
                onValueChange={(v) => void setAllowSelfRegistration(v)}
                disabled={saving}
                label="Allow user self-registration"
                testID="toggle-self-registration"
              />
            )}
          </View>
        </CardContent>
      </Card>

      {error ? (
        <Text style={styles.error} testID="admin-settings-error">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

type Theme = ReturnType<typeof useTheme>;

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.background?.val, padding: 24, gap: 16 },
    title: { fontSize: 24, fontWeight: '600', color: theme.color?.val },
    row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16 },
    labelCol: { flex: 1, gap: 4 },
    label: { fontSize: 16, fontWeight: '500', color: theme.color?.val },
    help: { fontSize: 13, color: theme.colorHover?.val ?? theme.color?.val, opacity: 0.7 },
    error: { color: theme.red10?.val ?? '#b00020' },
  });
