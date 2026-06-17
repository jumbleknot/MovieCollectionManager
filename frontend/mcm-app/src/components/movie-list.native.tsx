/**
 * MovieList component — native variant (T128; feature 015).
 *
 * The web default (`movie-list.tsx`) renders a wide DS data table; a wide table
 * is wrong for a phone, so the native override renders a DS `MovieCard`-style
 * compact card list instead (research R7).
 *
 * Exposes IDENTICAL props to the web default and preserves the same load-bearing
 * testIDs so the Maestro flows assert the same scenarios on both platforms
 * (Contract 1):
 *   movie-list-header     — slim section header (asserted visible by movie-browse.yaml)
 *   movie-list-container  — the FlatList wrapper
 *   movie-list-empty      — the empty state view
 *   movie-list-item-row   — each pressable card row
 *   movie-list-item-title — each row's title
 *
 * Native has no column-visibility toggle (Platform Parity Table), so the card
 * shows a fixed compact meta set; `visibleColumns` is accepted for prop parity.
 */

import React, { useCallback } from 'react';
import { FlatList } from 'react-native';
import { Text, useTheme } from '@tamagui/core';
import { XStack, YStack } from '@tamagui/stacks';
import { hasMediaQualityMismatch } from '@/components/movie-list-item';
import type { Movie, ColumnVisibility } from '@/types/collection';

interface MovieListProps {
  items: Movie[];
  visibleColumns: ColumnVisibility;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
  onMoviePress: (movieId: string) => void;
}

// ─── Card row ─────────────────────────────────────────────────────────────────

interface MovieCardRowProps {
  movie: Movie;
  onPress: (movieId: string) => void;
}

function MovieCardRow({ movie, onPress }: MovieCardRowProps) {
  const theme = useTheme();
  const mismatch = hasMediaQualityMismatch(movie);

  const meta = [movie.year, movie.contentType].filter(Boolean).join(' · ');
  const media = movie.ownedMedia.join(', ');
  const quality = movie.ripQuality.join(', ');

  return (
    <YStack
      testID="movie-list-item-row"
      onPress={() => onPress(movie.movieId)}
      accessibilityRole="button"
      accessibilityLabel={movie.title}
      backgroundColor={theme.surface1?.val}
      borderRadius={12}
      paddingVertical={12}
      paddingHorizontal={16}
      marginBottom={8}
      gap={4}
      cursor="pointer"
      pressStyle={{ opacity: 0.92, scale: 0.99 }}
      hoverStyle={{ backgroundColor: theme.surface2?.val }}
      shadowColor={theme.shadow?.val}
      shadowOffset={{ width: 0, height: 1 }}
      shadowOpacity={0.12}
      shadowRadius={2}
      elevation={1}
    >
      <Text
        testID="movie-list-item-title"
        fontFamily="$heading"
        fontSize={16}
        fontWeight="500"
        color={theme.onSurface?.val}
        numberOfLines={1}
      >
        {movie.title}
      </Text>

      {meta.length > 0 && (
        <Text fontFamily="$body" fontSize={14} letterSpacing={0.4} color={theme.onSurfaceVariant?.val}>
          {meta}
        </Text>
      )}

      {(media.length > 0 || quality.length > 0) && (
        <XStack gap={8} marginTop={2} flexWrap="wrap" alignItems="center">
          {media.length > 0 && (
            <Text
              fontFamily="$body"
              fontSize={12}
              fontWeight={mismatch ? '700' : '400'}
              color={mismatch ? theme.tertiary?.val : theme.onSurfaceVariant?.val}
            >
              {media}
            </Text>
          )}
          {media.length > 0 && quality.length > 0 && (
            <Text fontFamily="$body" fontSize={12} color={theme.outlineVariant?.val}>
              ·
            </Text>
          )}
          {quality.length > 0 && (
            <Text
              fontFamily="$body"
              fontSize={12}
              fontWeight={mismatch ? '700' : '400'}
              color={mismatch ? theme.tertiary?.val : theme.onSurfaceVariant?.val}
            >
              {quality}
            </Text>
          )}
        </XStack>
      )}
    </YStack>
  );
}

// ─── MovieList ────────────────────────────────────────────────────────────────

export function MovieList({
  items,
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
    ({ item }: { item: Movie }) => <MovieCardRow movie={item} onPress={onMoviePress} />,
    [onMoviePress],
  );

  const keyExtractor = useCallback((item: Movie) => item.movieId, []);

  // Slim section header — preserves movie-list-header (asserted visible on native).
  const header = (
    <XStack
      testID="movie-list-header"
      alignItems="center"
      paddingVertical={8}
      paddingHorizontal={16}
      borderBottomWidth={2}
      borderBottomColor={theme.primary?.val}
    >
      <Text fontFamily="$body" fontSize={12} fontWeight="500" color={theme.primary?.val} textTransform="uppercase" letterSpacing={0.5}>
        Movies
      </Text>
    </XStack>
  );

  if (items.length === 0) {
    return (
      <YStack flex={1}>
        {header}
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
      {header}
      <FlatList
        testID="movie-list-container"
        data={items}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        onEndReached={handleEndReached}
        onEndReachedThreshold={0.3}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: 16 }}
      />
    </YStack>
  );
}
