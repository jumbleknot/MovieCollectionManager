/**
 * MovieList component (T127; feature 015 re-skin) — web default (data table).
 *
 * The extensionless file is the WEB variant (constitution §Components-Layer);
 * `movie-list.native.tsx` overrides it with a DS card list. Both expose
 * identical props and the same testIDs (research R7).
 *
 * Scrollable data table using FlatList. Supports:
 * - Sticky column header row (always visible; matches visible columns), styled
 *   as a DS data-table header: dense uppercase labels with a 2dp primary
 *   bottom-border (FR re-skin).
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
import { FlatList } from 'react-native';
import { Text, useTheme } from '@tamagui/core';
import { XStack, YStack } from '@tamagui/stacks';
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
  const theme = useTheme();
  const labelColor = theme.onSurfaceVariant?.val;

  return (
    <XStack
      testID="movie-list-header"
      alignItems="center"
      paddingVertical={8}
      paddingHorizontal={12}
      gap={8}
      backgroundColor={theme.surface1?.val}
      borderBottomWidth={2}
      borderBottomColor={theme.primary?.val}
    >
      {/* Title is always visible — matches flex:2 in MovieListItem */}
      <Text flex={2} fontFamily="$heading" fontSize={11} fontWeight="700" color={labelColor} textTransform="uppercase" letterSpacing={0.5}>
        Title
      </Text>

      {(Object.keys(COLUMN_LABELS) as (keyof ColumnVisibility)[]).map((col) =>
        visibleColumns[col] ? (
          <Text
            key={col}
            flex={1}
            fontFamily="$heading"
            fontSize={11}
            fontWeight="700"
            color={labelColor}
            textTransform="uppercase"
            letterSpacing={0.5}
            textAlign="center"
          >
            {COLUMN_LABELS[col]}
          </Text>
        ) : null,
      )}
    </XStack>
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
  const theme = useTheme();

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
      <YStack flex={1}>
        <MovieListHeader visibleColumns={visibleColumns} />
        <YStack testID="movie-list-empty" flex={1} alignItems="center" justifyContent="center" paddingVertical={48}>
          <Text fontFamily="$body" fontSize={16} color={theme.onSurfaceVariant?.val}>
            No movies found
          </Text>
        </YStack>
      </YStack>
    );
  }

  return (
    <YStack flex={1}>
      <MovieListHeader visibleColumns={visibleColumns} />
      <FlatList
        testID="movie-list-container"
        data={items}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        onEndReached={handleEndReached}
        onEndReachedThreshold={0.3}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 16 }}
      />
    </YStack>
  );
}
