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
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
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
            <TouchableOpacity
              key={f.key}
              testID={`sort-field-${f.key}`}
              style={[styles.chip, active && styles.chipActive]}
              onPress={() => onChange(f.key, sortDir)}
              accessible
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              accessibilityLabel={`Sort by ${f.label}`}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>{f.label}</Text>
            </TouchableOpacity>
          );
        })}
        <TouchableOpacity
          testID="sort-dir-toggle"
          style={styles.dirToggle}
          onPress={() => onChange(sortBy, sortDir === 'asc' ? 'desc' : 'asc')}
          accessible
          accessibilityRole="button"
          accessibilityLabel={sortDir === 'asc' ? 'Sort ascending, tap for descending' : 'Sort descending, tap for ascending'}
        >
          <Text style={styles.dirToggleText}>{sortDir === 'asc' ? '↑' : '↓'}</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#fff',
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: '#374151',
    marginRight: 8,
  },
  row: {
    alignItems: 'center',
    gap: 8,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: '#e5e7eb',
  },
  chipActive: {
    backgroundColor: '#1a56db',
  },
  chipText: {
    fontSize: 13,
    color: '#374151',
  },
  chipTextActive: {
    color: '#fff',
    fontWeight: '600',
  },
  dirToggle: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: '#1a56db',
  },
  dirToggleText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#fff',
  },
});
