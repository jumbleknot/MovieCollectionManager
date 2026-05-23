/**
 * CollectionScreen (T135)
 *
 * Composes the movie browse/search/filter UI for a single collection:
 *   - MovieSearchBar    — search by title (debounced in useMovies)
 *   - ColumnSelector    — show/hide optional columns
 *   - MovieFilterPanel  — filter by genre, contentType, language, etc.
 *   - MovieList         — infinite scroll list of movies
 *   - "Add Movie" FAB   — navigate to new-movie screen
 *
 * All state management is delegated to the useMovies hook.
 * On mount: `listMovies()` and `fetchFilterOptions()` are called.
 */

import React, { useEffect, useCallback } from 'react';
import { Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
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

  // Fetch data on mount
  useEffect(() => {
    void listMovies();
    void fetchFilterOptions();
  }, [listMovies, fetchFilterOptions]);

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
    router.push(`/collections/${collectionId}/movies/new` as Parameters<typeof router.push>[0]);
  }, [router, collectionId]);

  return (
    <SafeAreaView style={styles.container}>
      {/* Search bar */}
      <MovieSearchBar value={search} onSearch={setSearch} />

      {/* Column selector */}
      <ColumnSelector visibleColumns={visibleColumns} onToggle={(col: ColumnKey) => toggleColumn(col)} />

      {/* Filter panel (only when filter-options are loaded) */}
      {filterOptions && !isLoadingFilterOptions && (
        <MovieFilterPanel
          filterOptions={filterOptions}
          activeFilters={filters}
          onFilterChange={handleFilterChange}
          onClearFilters={() => { void clearFilters(); }}
        />
      )}

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

      {/* Add Movie FAB */}
      <Pressable
        testID="collection-screen-add-movie"
        style={styles.fab}
        onPress={handleAddMovie}
        accessibilityRole="button"
        accessibilityLabel="Add movie"
      >
        <Text style={styles.fabText}>+</Text>
      </Pressable>
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
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 24,
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
