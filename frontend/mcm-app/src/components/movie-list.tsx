/**
 * MovieList component (T127)
 *
 * Scrollable list of movies using FlatList. Supports:
 * - Infinite scroll via onEndReached → onLoadMore
 * - Empty state when items is empty
 * - Per-row onMoviePress callback
 *
 * testIDs:
 *   movie-list-container — the FlatList wrapper
 *   movie-list-empty     — the empty state view
 */

import React, { useCallback } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { MovieListItem } from '@/components/movie-list-item';
import type { Movie, ColumnVisibility } from '@/types/collection';

interface MovieListProps {
  items: Movie[];
  visibleColumns: ColumnVisibility;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
  onMoviePress: (movieId: string) => void;
}

export function MovieList({
  items,
  visibleColumns,
  hasMore,
  isLoadingMore,
  onLoadMore,
  onMoviePress,
}: MovieListProps) {
  const handleEndReached = useCallback(() => {
    if (hasMore && !isLoadingMore) {
      onLoadMore();
    }
  }, [hasMore, isLoadingMore, onLoadMore]);

  const renderItem = useCallback(
    ({ item }: { item: Movie }) => (
      <MovieListItem
        movie={item}
        visibleColumns={visibleColumns}
        onPress={onMoviePress}
      />
    ),
    [visibleColumns, onMoviePress],
  );

  const keyExtractor = useCallback((item: Movie) => item.movieId, []);

  if (items.length === 0) {
    return (
      <View testID="movie-list-empty" style={styles.emptyContainer}>
        <Text style={styles.emptyText}>No movies found</Text>
      </View>
    );
  }

  return (
    <FlatList
      testID="movie-list-container"
      data={items}
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      onEndReached={handleEndReached}
      onEndReachedThreshold={0.3}
      style={styles.list}
      contentContainerStyle={styles.content}
    />
  );
}

const styles = StyleSheet.create({
  list: {
    flex: 1,
  },
  content: {
    paddingBottom: 16,
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 48,
  },
  emptyText: {
    fontSize: 16,
    color: '#888',
  },
});
