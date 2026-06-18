/**
 * MovieSortControl (013 US1)
 *
 * Lets the user choose the collection's movie sort order. Offers the scalar columns currently
 * shown in the list (FR-003) — Title is always available; Year/Type/etc. appear when their
 * column is visible. Array-valued columns (genres, cast, media) are intentionally not sortable.
 * A direction toggle flips ascending/descending. Uses the pressable-chip pattern (not the native
 * Picker, which crashes on Android new arch — see movie-form radio buttons).
 */

import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@tamagui/core';
import { Chip, IconButton } from '@mcm/design-system';
import type { ColumnKey, ColumnVisibility, MovieSortField, SortDirection } from '@/types/collection';

interface MovieSortControlProps {
  sortBy: MovieSortField;
  sortDir: SortDirection;
  visibleColumns: ColumnVisibility;
  onChange: (field: MovieSortField, dir: SortDirection) => void;
}

// Scalar sortable columns paired with the ColumnKey that gates their visibility.
const SCALAR_SORT_FIELDS: { key: MovieSortField; col: ColumnKey; label: string }[] = [
  { key: 'year', col: 'year', label: 'Year' },
  { key: 'contentType', col: 'contentType', label: 'Type' },
  { key: 'language', col: 'language', label: 'Language' },
  { key: 'owned', col: 'owned', label: 'Owned' },
  { key: 'ripped', col: 'ripped', label: 'Ripped' },
  { key: 'childrens', col: 'childrens', label: 'Kids' },
  { key: 'rated', col: 'rated', label: 'Rating' },
  { key: 'runtime', col: 'runtime', label: 'Runtime' },
];

export function MovieSortControl({ sortBy, sortDir, visibleColumns, onChange }: MovieSortControlProps) {
  const theme = useTheme();
  const styles = makeStyles(theme);
  const fields: { key: MovieSortField; label: string }[] = [
    { key: 'title', label: 'Title' }, // always available
    ...SCALAR_SORT_FIELDS.filter((f) => visibleColumns[f.col]).map((f) => ({ key: f.key, label: f.label })),
  ];

  return (
    <View style={styles.container} testID="movie-sort-control">
      <Text style={styles.label}>Sort</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
        {fields.map((f) => {
          const active = f.key === sortBy;
          return (
            <Chip
              key={f.key}
              testID={`sort-field-${f.key}`}
              type="choice"
              selected={active}
              selectedScheme="primary"
              label={f.label}
              onPress={() => onChange(f.key, sortDir)}
              accessibilityLabel={`Sort by ${f.label}`}
            />
          );
        })}
        <IconButton
          testID="sort-dir-toggle"
          variant="filled"
          selected
          onPress={() => onChange(sortBy, sortDir === 'asc' ? 'desc' : 'asc')}
          label={sortDir === 'asc' ? 'Sort ascending, tap for descending' : 'Sort descending, tap for ascending'}
          icon={<Text style={styles.dirToggleText}>{sortDir === 'asc' ? '▲' : '▼'}</Text>}
        />
      </ScrollView>
    </View>
  );
}

type Theme = ReturnType<typeof useTheme>;

const makeStyles = (theme: Theme) => StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: theme.background?.val,
  },
  label: {
    fontFamily: 'Inter',
    fontSize: 14,
    fontWeight: '600',
    color: theme.onSurfaceVariant?.val,
    marginRight: 8,
  },
  row: {
    alignItems: 'center',
    gap: 8,
  },
  dirToggleText: {
    fontFamily: 'Inter',
    fontSize: 14,
    lineHeight: 16,
    fontWeight: '700',
    color: theme.onPrimary?.val,
  },
});
