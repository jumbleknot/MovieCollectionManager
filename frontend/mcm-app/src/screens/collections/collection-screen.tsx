/**
 * CollectionScreen (T135)
 *
 * Composes the movie browse/search/filter UI for a single collection:
 *   - MovieSearchBar    — search by title (debounced in useMovies)
 *   - ColumnSelector    — show/hide optional columns
 *   - MovieFilterPanel  — filter by genre, contentType, language, etc.
 *   - MovieList         — infinite scroll list of movies
 *   - "Add Movie" button — navigate to new-movie screen
 *
 * All state management is delegated to the useMovies hook.
 * On mount: `listMovies()` and `fetchFilterOptions()` are called.
 *
 * NOTE: The Add Movie button is in the normal layout flow (not absolutely
 * positioned) because React Native Fabric on Android does not dispatch
 * performAction(ACTION_CLICK) to absolutely-positioned views correctly.
 * TouchableOpacity in normal flow works (same pattern as CollectionCard).
 *
 * SafeAreaView uses react-native-safe-area-context with edges={['bottom','left','right']}
 * so the FAB is pushed above the Android navigation bar. The top edge is
 * already handled by (app)/_layout.tsx's SafeAreaView with edges={['top']}.
 */

import React, { useCallback } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@tamagui/core';
import { PillButton } from '@mcm/design-system';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import { useMovies } from '@/hooks/use-movies';
import { useMovieCount } from '@/hooks/use-movie-count';
import { useCollection } from '@/hooks/use-collection';
import { useColumnVisibility } from '@/hooks/use-column-visibility';
import { useAuth } from '@/hooks/use-auth';
import { useAssistantDataRefresh } from '@/hooks/use-assistant-data-sync';
import { MovieList } from '@/components/movie-list';
import { MovieSearchBar } from '@/components/movie-search-bar';
import { MovieFilterPanel } from '@/components/movie-filter-panel';
import { MovieSortControl } from '@/components/movie-sort-control';
import { MovieCountLine } from '@/components/movie-count-line';
import { ColumnSelector } from '@/components/column-selector';
import type { ColumnKey, MovieListFilters } from '@/types/collection';

interface CollectionScreenProps {
  collectionId: string;
}

export function CollectionScreen({ collectionId }: CollectionScreenProps) {
  const router = useRouter();
  const theme = useTheme();
  const { user } = useAuth();
  const {
    movies,
    isLoadingList,
    hasMore,
    listMovies,
    loadMore,
    search,
    setSearch,
    sortBy,
    sortDir,
    setSort,
    filters,
    setFilter,
    clearFilters,
    filterOptions,
    isLoadingFilterOptions,
    fetchFilterOptions,
  } = useMovies(collectionId);
  const { count, refreshCount } = useMovieCount(collectionId, filters, search);
  const { name: collectionName } = useCollection(collectionId);
  const { visibleColumns, toggleColumn } = useColumnVisibility(user?.id ?? '');

  // Reload movies and filter options every time this screen gains focus.
  // useFocusEffect fires on initial mount AND whenever the user navigates back
  // to this screen (e.g., after adding/editing a movie), ensuring the list
  // always reflects the latest server state.
  useFocusEffect(
    useCallback(() => {
      void listMovies();
      void fetchFilterOptions();
      void refreshCount();
    }, [listMovies, fetchFilterOptions, refreshCount]),
  );

  // T072: the assistant can add/organize movies while THIS screen stays focused (under the dock
  // overlay), so useFocusEffect never re-fires. Re-load the list + filter options when an
  // approved assistant write completes.
  useAssistantDataRefresh(() => {
    void listMovies();
    void fetchFilterOptions();
    void refreshCount();
  });

  const handleMoviePress = useCallback(
    (movieId: string) => {
      router.push(
        `/collections/${collectionId}/movies/${movieId}` as Parameters<typeof router.push>[0],
      );
    },
    [router, collectionId],
  );

  const handleFilterChange = useCallback(
    (key: keyof MovieListFilters, value: string | number | undefined) => {
      if (value === undefined) {
        // Deselect: clear this filter key (FR-022c)
        void setFilter(key, undefined as never);
      } else if (key === 'owned' || key === 'ripped') {
        // Convert Yes/No display strings to boolean (FR-022a)
        void setFilter(key, (value === 'Yes' ? true : false) as never);
      } else {
        void setFilter(key, value as never);
      }
    },
    [setFilter],
  );

  const handleAddMovie = useCallback(() => {
    router.push(
      `/collections/${collectionId}/add-movie` as Parameters<typeof router.push>[0],
    );
  }, [router, collectionId]);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background?.val }]} edges={['bottom', 'left', 'right']}>
      {/* Collection name header (013 Enhancement 1) — which collection the user is viewing.
          Hidden until the name loads so the layout doesn't jump on a slow/failed fetch. */}
      {collectionName ? (
        <Text testID="collection-screen-name" style={[styles.collectionName, { color: theme.onSurface?.val }]} numberOfLines={1}>
          {collectionName}
        </Text>
      ) : null}

      {/* Search bar */}
      <MovieSearchBar value={search} onSearch={setSearch} />

      {/* Column selector */}
      <ColumnSelector visibleColumns={visibleColumns} onToggle={(col: ColumnKey) => toggleColumn(col)} />

      {/* Sort control (013 US1) — scalar columns currently shown + direction toggle */}
      <MovieSortControl
        sortBy={sortBy}
        sortDir={sortDir}
        visibleColumns={visibleColumns}
        onChange={(field, dir) => { void setSort(field, dir); }}
      />

      {/* Filter panel — always rendered; passes empty options while loading */}
      <MovieFilterPanel
        filterOptions={filterOptions ?? { genres: [], contentTypes: [], rated: [], languages: [], decades: [], ownedMedia: [], ripQuality: [] }}
        isLoading={isLoadingFilterOptions}
        activeFilters={filters}
        onFilterChange={handleFilterChange}
        onClearFilters={() => { void clearFilters(); }}
      />

      {/* Count info line (013 US2) + Add Movie action, sharing one bar above the grid.
          The count sits left; the "+" is right-justified in the same row.
          The button stays in normal layout flow (not absolutely positioned) so Maestro's
          performAction(ACTION_CLICK) reaches it — RN Fabric on Android does not dispatch
          ACTION_CLICK to absolutely-positioned views. */}
      <View style={[styles.countRow, { backgroundColor: theme.background?.val }]}>
        {/* Count info line — total, or filtered/total when a filter is active */}
        <MovieCountLine count={count} />
        {/* The single sanctioned orange (tertiary) call-to-action on this screen (FR-006) —
            the shared DS PillButton, in normal layout flow for RN-Fabric ACTION_CLICK. */}
        <PillButton
          testID="collection-screen-add-movie"
          accessibilityLabel="Add movie"
          label="+ Add movie"
          onPress={handleAddMovie}
        />
      </View>

      {/* Movie list */}
      <View style={styles.listContainer}>
        <MovieList
          items={movies}
          visibleColumns={visibleColumns}
          hasMore={hasMore}
          isLoadingMore={isLoadingList}
          onLoadMore={() => { void loadMore(); }}
          onMoviePress={handleMoviePress}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  // backgroundColor / color are set inline from the theme at each JSX site; no shadowed
  // literals here so the declared style can't drift from the rendered colour (feature 017 D6).
  container: {
    flex: 1,
  },
  collectionName: {
    fontSize: 20,
    fontWeight: '700',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
  },
  listContainer: {
    flex: 1,
  },
  countRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingRight: 16,
    paddingVertical: 4,
  },
});
