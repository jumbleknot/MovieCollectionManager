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
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import { useMovies } from '@/hooks/use-movies';
import { MovieList } from '@/components/movie-list';
import { MovieSearchBar } from '@/components/movie-search-bar';
import { MovieFilterPanel } from '@/components/movie-filter-panel';
import { ColumnSelector } from '@/components/column-selector';
import type { ColumnKey, MovieListFilters } from '@/types/collection';

interface CollectionScreenProps {
  collectionId: string;
}

export function CollectionScreen({ collectionId }: CollectionScreenProps) {
  const router = useRouter();
  const {
    movies,
    isLoadingList,
    hasMore,
    listMovies,
    loadMore,
    search,
    setSearch,
    filters,
    setFilter,
    clearFilters,
    visibleColumns,
    toggleColumn,
    filterOptions,
    isLoadingFilterOptions,
    fetchFilterOptions,
  } = useMovies(collectionId);

  // Reload movies and filter options every time this screen gains focus.
  // useFocusEffect fires on initial mount AND whenever the user navigates back
  // to this screen (e.g., after adding/editing a movie), ensuring the list
  // always reflects the latest server state.
  useFocusEffect(
    useCallback(() => {
      void listMovies();
      void fetchFilterOptions();
    }, [listMovies, fetchFilterOptions]),
  );

  const handleMoviePress = useCallback(
    (movieId: string) => {
      router.push(
        `/collections/${collectionId}/movies/${movieId}` as Parameters<typeof router.push>[0],
      );
    },
    [router, collectionId],
  );

  const handleFilterChange = useCallback(
    (key: keyof MovieListFilters, value: string | number) => {
      void setFilter(key, value as never);
    },
    [setFilter],
  );

  const handleAddMovie = useCallback(() => {
    router.push(
      `/collections/${collectionId}/add-movie` as Parameters<typeof router.push>[0],
    );
  }, [router, collectionId]);

  return (
    <SafeAreaView style={styles.container} edges={['bottom', 'left', 'right']}>
      {/* Search bar */}
      <MovieSearchBar value={search} onSearch={setSearch} />

      {/* Column selector */}
      <ColumnSelector visibleColumns={visibleColumns} onToggle={(col: ColumnKey) => toggleColumn(col)} />

      {/* Filter panel — always rendered; passes empty options while loading */}
      <MovieFilterPanel
        filterOptions={filterOptions ?? { genres: [], contentTypes: [], rated: [], languages: [], decades: [], ownedMedia: [], ripQuality: [] }}
        isLoading={isLoadingFilterOptions}
        activeFilters={filters}
        onFilterChange={handleFilterChange}
        onClearFilters={() => { void clearFilters(); }}
      />

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

      {/* Add Movie button — in normal layout flow so Maestro ACTION_CLICK reaches it.
          Absolutely-positioned Pressable/TouchableOpacity does not receive
          performAction(ACTION_CLICK) in RN Fabric on Android. */}
      <View style={styles.fabRow}>
        <TouchableOpacity
          testID="collection-screen-add-movie"
          style={styles.fab}
          onPress={handleAddMovie}
          accessible={true}
          accessibilityRole="button"
          accessibilityLabel="Add movie"
        >
          <Text style={styles.fabText}>+</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  listContainer: {
    flex: 1,
  },
  fabRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingRight: 24,
    paddingTop: 12,
    paddingBottom: 16,
    backgroundColor: '#fff',
  },
  fab: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#1a56db',
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
  },
  fabText: {
    color: '#fff',
    fontSize: 28,
    fontWeight: '300',
    lineHeight: 32,
    textAlign: 'center',
  },
});
