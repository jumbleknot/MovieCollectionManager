/**
 * MovieFilterPanel component (T133)
 *
 * Collapsible panel of filter chips. All displayed values come exclusively
 * from the filterOptions prop — no hardcoded option lists.
 * Exception: "Owned" and "Ripped" are static Yes/No sections (FR-022a).
 *
 * SINGLE-SELECT per category by design: each FilterSection has ONE `activeValue` — picking a
 * different value replaces it; re-tapping the active one clears it. These render as DS
 * `Chip type="choice"` (MD3 single-select choice chip — fill-only when selected, NO checkmark),
 * VISUALLY distinct from the multi-value form fields (owned-media/rip-quality) which use
 * `Chip type="filter"` (checkmark when selected). Single-value form INPUTS use radios. See
 * specs/017-design-system-consistency/contracts/sanctioned-deviations.md.
 *
 * Props:
 *   filterOptions   — dynamic values from the collection (from /filter-options)
 *   activeFilters   — currently applied filters
 *   onFilterChange  — called with (filterKey, value) when a chip is pressed;
 *                     called with (filterKey, undefined) when an active chip is
 *                     tapped to deselect it (FR-022c)
 *
 * 099: the panel has no height cap and no vertical scroller of its own — it sits in the view-options
 * pane, whose single body scroller owns vertical scrolling (FR-002). Chips WRAP rather than scroll
 * sideways (FR-003). "Clear Filters" is exported as ClearFiltersButton and rendered by the screen in
 * the pane header, so it stays visible at any scroll position (FR-004).
 *
 * testIDs:
 *   movie-filter-panel                   — root container
 *   filter-section-{filterKey}           — each filter section container
 *   filter-chips-{filterKey}             — each section's (wrapping) chip container
 *   filter-chip-{filterKey}-{value}      — each filter chip
 *   filter-clear-button                  — ClearFiltersButton (rendered by the screen)
 *
 * Filter section order (FR-022b):
 *   contentType → owned → ownedMedia → ripped → ripQuality → genre → decade → language → rated
 */

import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@tamagui/core';
import { Button, Chip } from '@mcm/design-system';
import type { FilterOptionsData, MovieListFilters } from '@/types/collection';

interface MovieFilterPanelProps {
  filterOptions: FilterOptionsData;
  isLoading?: boolean;
  activeFilters: MovieListFilters;
  onFilterChange: (key: keyof MovieListFilters, value: string | number | undefined) => void;
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
      <View testID={`filter-chips-${filterKey}`} style={styles.chips}>
        {options.map((opt) => {
          const isActive = opt === activeValue;
          return (
            <Chip
              key={String(opt)}
              testID={`filter-chip-${filterKey}-${opt}`}
              type="choice"
              selected={isActive}
              selectedScheme="primary"
              label={String(opt)}
              onPress={() => (isActive ? onPress(undefined) : onPress(opt))}
            />
          );
        })}
      </View>
    </View>
  );
}

/**
 * "Clear Filters" — shown by the screen in the view-options pane header while a filter is active.
 * A text button, matching the header's Close beside it: a filled-tonal background paints the full
 * 48px touch-target minHeight and read as an outsized, mismatched pill there.
 */
export function ClearFiltersButton({ onPress }: { onPress: () => void }): React.JSX.Element {
  return (
    <Button
      testID="filter-clear-button"
      variant="text"
      size="sm"
      label="Clear Filters"
      onPress={onPress}
      accessibilityLabel="Clear all filters"
    />
  );
}

const OWNED_RIPPED_OPTIONS: string[] = ['Yes', 'No'];

export function MovieFilterPanel({
  filterOptions,
  isLoading = false,
  activeFilters,
  onFilterChange,
}: MovieFilterPanelProps) {
  const theme = useTheme();
  const styles = makeStyles(theme);

  return (
    <View testID="movie-filter-panel" style={styles.container}>
      {isLoading && (
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color={theme.primary?.val} />
        </View>
      )}
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
        activeValue={
          activeFilters.owned === true ? 'Yes' : activeFilters.owned === false ? 'No' : undefined
        }
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
        activeValue={
          activeFilters.ripped === true ? 'Yes' : activeFilters.ripped === false ? 'No' : undefined
        }
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
        onPress={(v) =>
          v === undefined
            ? onFilterChange('decade', undefined)
            : onFilterChange('decade', Number(v))
        }
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
    </View>
  );
}

type Theme = ReturnType<typeof useTheme>;

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    container: {
      backgroundColor: theme.background?.val,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.outlineVariant?.val,
    },
    loadingRow: {
      height: 36,
      alignItems: 'center',
      justifyContent: 'center',
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
      flexWrap: 'wrap',
      gap: 8,
      paddingBottom: 8,
    },
  });
