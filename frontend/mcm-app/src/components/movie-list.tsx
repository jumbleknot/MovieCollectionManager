/**
 * MovieList component (T127)
 *
 * Scrollable list of movies using FlatList. Supports:
 * - Sticky column header row (always visible; matches visible columns)
 * - Infinite scroll via onEndReached → onLoadMore
 * - Empty state when items is empty (header still shown)
 * - Per-row onMoviePress callback
 *
 * testIDs:
 *   movie-list-header     — the column header row
 *   movie-list-container  — the FlatList wrapper
 *   movie-list-empty      — the empty state view
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

// ─── Column header labels ─────────────────────────────────────────────────────

const COLUMN_LABELS: Record<keyof ColumnVisibility, string> = {
  year: 'Year',
  contentType: 'Type',
  language: 'Language',
  owned: 'Own',
  ripped: 'Rip',
  childrens: 'Kids',
  genres: 'Genres',
  rated: 'Rating',
  ownedMedia: 'Media',
  ripQuality: 'Quality',
  runtime: 'Runtime',
  directors: 'Director',
  actors: 'Cast',
};

// ─── MovieListHeader component ────────────────────────────────────────────────

interface MovieListHeaderProps {
  visibleColumns: ColumnVisibility;
}

function MovieListHeader({ visibleColumns }: MovieListHeaderProps) {
  return (
    <View testID="movie-list-header" style={styles.header}>
      {/* Title is always visible — matches flex:2 in MovieListItem */}
      <Text style={styles.headerCellTitle}>Title</Text>

      {(Object.keys(COLUMN_LABELS) as (keyof ColumnVisibility)[]).map((col) =>
        visibleColumns[col] ? (
          <Text key={col} style={styles.headerCell}>
            {COLUMN_LABELS[col]}
          </Text>
        ) : null,
      )}
    </View>
  );
}

// ─── MovieList component ──────────────────────────────────────────────────────

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
      <View style={styles.wrapper}>
        <MovieListHeader visibleColumns={visibleColumns} />
        <View testID="movie-list-empty" style={styles.emptyContainer}>
          <Text style={styles.emptyText}>No movies found</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.wrapper}>
      <MovieListHeader visibleColumns={visibleColumns} />
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
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    flex: 1,
  },
  // ── Header row ────────────────────────────────────────────────────────────
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 12,
    backgroundColor: '#f7fafc',
    borderBottomWidth: 1,
    borderBottomColor: '#cbd5e0',
    gap: 8,
  },
  headerCellTitle: {
    flex: 2,
    fontSize: 11,
    fontWeight: '700',
    color: '#4a5568',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  headerCell: {
    flex: 1,
    fontSize: 11,
    fontWeight: '700',
    color: '#4a5568',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    textAlign: 'center',
  },
  // ── List ──────────────────────────────────────────────────────────────────
  list: {
    flex: 1,
  },
  content: {
    paddingBottom: 16,
  },
  // ── Empty state ───────────────────────────────────────────────────────────
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
