/**
 * ColumnSelector component (T129)
 *
 * Shows a panel of toggle switches, one per ColumnKey, allowing users
 * to show/hide optional columns in the movie list.
 *
 * Props:
 *   visibleColumns — current visibility state
 *   onToggle       — called with the column key when a toggle is pressed
 *
 * testIDs:
 *   column-toggle-{key} — the Switch/TouchableOpacity for each column
 */

import React from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, type SwitchProps } from 'react-native';
import { useTheme } from '@tamagui/core';
import type { ColumnKey, ColumnVisibility } from '@/types/collection';

interface ColumnSelectorProps {
  visibleColumns: ColumnVisibility;
  onToggle: (col: ColumnKey) => void;
}

const COLUMN_LABELS: Record<ColumnKey, string> = {
  year: 'Year',
  contentType: 'Type',
  language: 'Language',
  owned: 'Owned',
  ripped: 'Ripped',
  childrens: "Children's",
  genres: 'Genres',
  rated: 'Rated',
  ownedMedia: 'Media',
  ripQuality: 'Rip Quality',
  runtime: 'Runtime',
  directors: 'Directors',
  actors: 'Actors',
};

// title, year, and contentType are always visible — not user-toggleable (FR-019b)
const COLUMN_KEYS: ColumnKey[] = (Object.keys(COLUMN_LABELS) as ColumnKey[]).filter(
  (k) => k !== 'year' && k !== 'contentType',
);

export function ColumnSelector({ visibleColumns, onToggle }: ColumnSelectorProps) {
  const theme = useTheme();
  const styles = makeStyles(theme);
  // The toggle's "on" thumb defaulted to react-native-web's teal-green (`activeThumbColor`
  // #009688), which clashes with the Cinema theme. Drive both the Android (`thumbColor`) and
  // web (`activeThumbColor`) thumb from the theme so the circle matches the palette. Cast to
  // SwitchProps via unknown because `activeThumbColor` is RNW-only (not in RN's SwitchProps).
  const thumbColors = {
    thumbColor: theme.onPrimary?.val,
    activeThumbColor: theme.onPrimary?.val,
  } as unknown as SwitchProps;
  return (
    <ScrollView horizontal style={styles.container} contentContainerStyle={styles.content}>
      {COLUMN_KEYS.map((key) => (
        <Pressable
          key={key}
          testID={`column-toggle-${key}`}
          style={styles.item}
          onPress={() => onToggle(key)}
          accessibilityRole="switch"
          accessibilityState={{ checked: visibleColumns[key] }}
        >
          <Text style={styles.label}>{COLUMN_LABELS[key]}</Text>
          <Switch
            value={visibleColumns[key]}
            onValueChange={() => onToggle(key)}
            trackColor={{ true: theme.primary?.val, false: theme.surfaceVariant?.val }}
            {...thumbColors}
            pointerEvents="none" // let Pressable handle the touch
          />
        </Pressable>
      ))}
    </ScrollView>
  );
}

type Theme = ReturnType<typeof useTheme>;

const makeStyles = (theme: Theme) => StyleSheet.create({
  container: {
    maxHeight: 64,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.outlineVariant?.val,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    gap: 12,
  },
  item: {
    alignItems: 'center',
    gap: 4,
  },
  label: {
    fontFamily: 'Inter',
    fontSize: 11,
    color: theme.onSurfaceVariant?.val,
    textAlign: 'center',
  },
});
