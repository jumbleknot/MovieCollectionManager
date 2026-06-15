/**
 * MovieFilterPanel component (T133)
 *
 * Collapsible panel of filter chips. All displayed values come exclusively
 * from the filterOptions prop — no hardcoded option lists.
 * Exception: "Owned" and "Ripped" are static Yes/No sections (FR-022a).
 *
 * Props:
 *   filterOptions   — dynamic values from the collection (from /filter-options)
 *   activeFilters   — currently applied filters
 *   onFilterChange  — called with (filterKey, value) when a chip is pressed;
 *                     called with (filterKey, undefined) when an active chip is
 *                     tapped to deselect it (FR-022c)
 *   onClearFilters  — called when the Clear button is pressed
 *
 * testIDs:
 *   movie-filter-panel                   — root container
 *   filter-section-{filterKey}           — each filter section container
 *   filter-chip-{filterKey}-{value}      — each filter chip
 *   filter-clear-button                  — the clear all filters button
 *
 * Filter section order (FR-022b):
 *   contentType → owned → ownedMedia → ripped → ripQuality → genre → decade → language → rated
 */

import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@tamagui/core';
import type { FilterOptionsData, MovieListFilters } from '@/types/collection';

interface MovieFilterPanelProps {
  filterOptions: FilterOptionsData;
  isLoading?: boolean;
  activeFilters: MovieListFilters;
  onFilterChange: (key: keyof MovieListFilters, value: string | number | undefined) => void;
  onClearFilters: () => void;
}

interface FilterSectionProps {
  filterKey: string;
  label: string;
  options: (string | number)[];
  activeValue?: string | number;
  onPress: (value: string | number | undefined) => void;
}

function FilterSection({ filterKey, label, options, activeValue, onPress }: FilterSectionProps) {
  const styles = makeStyles(useTheme());
  if (options.length === 0) return null;

  return (
    <View testID={`filter-section-${filterKey}`} style={styles.section}>
      <Text style={styles.sectionLabel}>{label}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {options.map((opt) => {
          const isActive = opt === activeValue;
          return (
            <Pressable
              key={String(opt)}
              testID={`filter-chip-${filterKey}-${opt}`}
              style={[styles.chip, isActive && styles.chipActive]}
              onPress={() => isActive ? onPress(undefined) : onPress(opt)}
              accessibilityState={{ selected: isActive }}
            >
              <Text style={[styles.chipText, isActive && styles.chipTextActive]}>
                {String(opt)}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const OWNED_RIPPED_OPTIONS: string[] = ['Yes', 'No'];

export function MovieFilterPanel({
  filterOptions,
  isLoading = false,
  activeFilters,
  onFilterChange,
  onClearFilters,
}: MovieFilterPanelProps) {
  const theme = useTheme();
  const styles = makeStyles(theme);
  const hasActiveFilters = Object.values(activeFilters).some((v) => v !== undefined && v !== '');

  return (
    <View testID="movie-filter-panel" style={styles.container}>
      {isLoading && (
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color={theme.primary?.val} />
        </View>
      )}
      <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* Order: contentType, owned, ownedMedia, ripped, ripQuality, genre, decade, language, rated (FR-022b) */}
        <FilterSection
          filterKey="contentType"
          label="Type"
          options={filterOptions.contentTypes}
          activeValue={activeFilters.contentType}
          onPress={(v) => onFilterChange('contentType', v as string | undefined)}
        />
        <FilterSection
          filterKey="owned"
          label="Owned"
          options={OWNED_RIPPED_OPTIONS}
          activeValue={activeFilters.owned === true ? 'Yes' : activeFilters.owned === false ? 'No' : undefined}
          onPress={(v) => onFilterChange('owned', v)}
        />
        <FilterSection
          filterKey="ownedMedia"
          label="Media"
          options={filterOptions.ownedMedia}
          activeValue={activeFilters.ownedMedia}
          onPress={(v) => onFilterChange('ownedMedia', v)}
        />
        <FilterSection
          filterKey="ripped"
          label="Ripped"
          options={OWNED_RIPPED_OPTIONS}
          activeValue={activeFilters.ripped === true ? 'Yes' : activeFilters.ripped === false ? 'No' : undefined}
          onPress={(v) => onFilterChange('ripped', v)}
        />
        <FilterSection
          filterKey="ripQuality"
          label="Rip Quality"
          options={filterOptions.ripQuality}
          activeValue={activeFilters.ripQuality}
          onPress={(v) => onFilterChange('ripQuality', v)}
        />
        <FilterSection
          filterKey="genre"
          label="Genre"
          options={filterOptions.genres}
          activeValue={activeFilters.genre}
          onPress={(v) => onFilterChange('genre', v)}
        />
        <FilterSection
          filterKey="decade"
          label="Decade"
          options={filterOptions.decades}
          activeValue={activeFilters.decade}
          onPress={(v) => v === undefined ? onFilterChange('decade', undefined) : onFilterChange('decade', Number(v))}
        />
        <FilterSection
          filterKey="language"
          label="Language"
          options={filterOptions.languages}
          activeValue={activeFilters.language}
          onPress={(v) => onFilterChange('language', v)}
        />
        <FilterSection
          filterKey="rated"
          label="Rating"
          options={filterOptions.rated}
          activeValue={activeFilters.rated}
          onPress={(v) => onFilterChange('rated', v)}
        />
      </ScrollView>

      {hasActiveFilters && (
        <Pressable
          testID="filter-clear-button"
          style={styles.clearButton}
          onPress={onClearFilters}
          accessibilityRole="button"
          accessibilityLabel="Clear all filters"
        >
          <Text style={styles.clearButtonText}>Clear Filters</Text>
        </Pressable>
      )}
    </View>
  );
}

type Theme = ReturnType<typeof useTheme>;

const makeStyles = (theme: Theme) => StyleSheet.create({
  container: {
    backgroundColor: theme.background?.val,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.outlineVariant?.val,
    minHeight: 36,
    maxHeight: 220,
  },
  loadingRow: {
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scroll: {
    flex: 1,
  },
  section: {
    paddingHorizontal: 12,
    paddingTop: 8,
  },
  sectionLabel: {
    fontFamily: 'Inter',
    fontSize: 11,
    fontWeight: '600',
    color: theme.onSurfaceVariant?.val,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  chips: {
    flexDirection: 'row',
    gap: 8,
    paddingBottom: 8,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: theme.surfaceVariant?.val,
    borderWidth: 1,
    borderColor: theme.outline?.val,
  },
  chipActive: {
    backgroundColor: theme.primary?.val,
    borderColor: theme.primary?.val,
  },
  chipText: {
    fontFamily: 'Inter',
    fontSize: 13,
    color: theme.onSurfaceVariant?.val,
  },
  chipTextActive: {
    color: theme.onPrimary?.val,
    fontWeight: '600',
  },
  clearButton: {
    margin: 8,
    padding: 8,
    borderRadius: 6,
    backgroundColor: theme.errorContainer?.val,
    alignItems: 'center',
  },
  clearButtonText: {
    fontFamily: 'Inter',
    fontSize: 13,
    color: theme.onErrorContainer?.val,
    fontWeight: '600',
  },
});
