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
 *   column-toggle-{key}           — the toggle: ONE labelled switch control per column
 *   column-toggle-{key}-indicator — its visual-only track + thumb (hidden from assistive tech)
 *
 * 098 T011b: each toggle used to nest an RN <Switch> inside the switch-role Pressable. On web that
 * rendered a second, unlabeled, focusable 40×20 input inside the control (axe: label,
 * nested-interactive, target-size), and RNW does not reflect accessibilityState.checked, so the
 * Pressable announced no state (aria-required-attr). The Pressable is now the single control, with
 * `role`, `aria-checked` and a label set explicitly; the switch is drawn, not a second control.
 */

import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
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
  return (
    <ScrollView horizontal style={styles.container} contentContainerStyle={styles.content}>
      {COLUMN_KEYS.map((key) => {
        const on = visibleColumns[key];
        return (
          <Pressable
            key={key}
            testID={`column-toggle-${key}`}
            style={styles.item}
            onPress={() => onToggle(key)}
            accessibilityRole="switch"
            accessibilityState={{ checked: on }}
            accessibilityLabel={COLUMN_LABELS[key]}
            role="switch"
            aria-checked={on}
          >
            <Text style={styles.label}>{COLUMN_LABELS[key]}</Text>
            {/* Visual-only switch, in the palette the old RN Switch used (track primary /
                surfaceVariant, thumb onPrimary). Hidden from AT: the Pressable carries the state. */}
            <View
              testID={`column-toggle-${key}-indicator`}
              aria-hidden
              importantForAccessibility="no-hide-descendants"
              accessibilityElementsHidden
              pointerEvents="none"
              style={[
                styles.track,
                {
                  backgroundColor: on ? theme.primary?.val : theme.surfaceVariant?.val,
                  justifyContent: on ? 'flex-end' : 'flex-start',
                },
              ]}
            >
              <View style={[styles.thumb, { backgroundColor: theme.onPrimary?.val }]} />
            </View>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

type Theme = ReturnType<typeof useTheme>;

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
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
    track: {
      width: 40,
      height: 20,
      borderRadius: 10,
      padding: 2,
      flexDirection: 'row',
      alignItems: 'center',
    },
    thumb: {
      width: 16,
      height: 16,
      borderRadius: 8,
    },
    label: {
      fontFamily: 'Inter',
      fontSize: 11,
      color: theme.onSurfaceVariant?.val,
      textAlign: 'center',
    },
  });
