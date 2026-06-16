/**
 * MovieListItem component (T126; feature 015 re-skin)
 *
 * Renders a single row in the web movie data table.
 * Title is always shown; all other columns are conditionally rendered
 * based on the visibleColumns prop.
 *
 * Re-skinned onto the MCM Cinema design system (Tamagui): the row surface,
 * typography (Outfit-less dense body text), and hover state use theme tokens.
 * Structure, props, behaviour, and every testID are unchanged (FR-002 / FR-018).
 *
 * FR-010 / SC-007: when a movie's owned media and rip quality disagree, the
 * `ownedMedia` / `ripQuality` cells are highlighted with the orange (tertiary)
 * accent; matching values stay neutral. The mismatch is the only sanctioned
 * orange element in this row.
 *
 * Each cell has a testID: `movie-list-item-{columnKey}`.
 * The row itself has testID: `movie-list-item-row`.
 */

import React from 'react';
import { Text, useTheme } from '@tamagui/core';
import { XStack } from '@tamagui/stacks';
import type { Movie, ColumnVisibility } from '@/types/collection';

interface MovieListItemProps {
  movie: Movie;
  visibleColumns: ColumnVisibility;
  onPress: (movieId: string) => void;
}

/**
 * FR-010: a movie's owned media format and its rip quality "disagree" when both
 * are recorded but hold different sets of values (e.g. owns Blu-Ray but only a
 * 1080p rip). Empty on either side → nothing to compare → no mismatch.
 */
export function hasMediaQualityMismatch(movie: Movie): boolean {
  const media = movie.ownedMedia;
  const quality = movie.ripQuality;
  if (media.length === 0 || quality.length === 0) return false;
  const m = new Set(media.map(s => s.toLowerCase()));
  const q = new Set(quality.map(s => s.toLowerCase()));
  if (m.size !== q.size) return true;
  for (const value of m) {
    if (!q.has(value)) return true;
  }
  return false;
}

export function MovieListItem({ movie, visibleColumns, onPress }: MovieListItemProps) {
  const theme = useTheme();
  const mismatch = hasMediaQualityMismatch(movie);

  const cellColor = theme.onSurfaceVariant?.val;
  // Orange (tertiary) accent on the disagreeing media/quality cells (FR-010).
  const mismatchColor = theme.tertiary?.val;

  return (
    <XStack
      testID="movie-list-item-row"
      onPress={() => onPress(movie.movieId)}
      accessibilityRole="button"
      accessibilityLabel={movie.title}
      alignItems="center"
      paddingVertical={8}
      paddingHorizontal={12}
      gap={8}
      cursor="pointer"
      borderBottomWidth={1}
      borderBottomColor={theme.outlineVariant?.val}
      hoverStyle={{ backgroundColor: theme.surface1?.val }}
      pressStyle={{ backgroundColor: theme.surface2?.val }}
    >
      {/* Title — always visible */}
      <Text
        testID="movie-list-item-title"
        flexGrow={2}
        flexShrink={1}
        flexBasis={0}
        minWidth={0}
        fontFamily="$heading"
        fontSize={14}
        fontWeight="500"
        color={theme.onSurface?.val}
        numberOfLines={1}
      >
        {movie.title}
      </Text>

      {visibleColumns.year && (
        <Text testID="movie-list-item-year" flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0} fontFamily="$body" fontSize={14} color={cellColor} textAlign="center">
          {movie.year}
        </Text>
      )}

      {visibleColumns.contentType && (
        <Text testID="movie-list-item-contentType" flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0} fontFamily="$body" fontSize={14} color={cellColor} textAlign="center">
          {movie.contentType}
        </Text>
      )}

      {visibleColumns.language && (
        <Text testID="movie-list-item-language" flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0} fontFamily="$body" fontSize={14} color={cellColor} textAlign="center">
          {/* 014 US1: neutral placeholder when a movie has no recorded language. */}
          {movie.language || '—'}
        </Text>
      )}

      {visibleColumns.owned && (
        <Text testID="movie-list-item-owned" flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0} fontFamily="$body" fontSize={14} color={cellColor} textAlign="center">
          {movie.owned ? '✓' : '–'}
        </Text>
      )}

      {visibleColumns.ripped && (
        <Text testID="movie-list-item-ripped" flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0} fontFamily="$body" fontSize={14} color={cellColor} textAlign="center">
          {movie.ripped ? '✓' : '–'}
        </Text>
      )}

      {visibleColumns.childrens && (
        <Text testID="movie-list-item-childrens" flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0} fontFamily="$body" fontSize={14} color={cellColor} textAlign="center">
          {movie.childrens ? '✓' : '–'}
        </Text>
      )}

      {visibleColumns.genres && (
        <Text testID="movie-list-item-genres" flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0} fontFamily="$body" fontSize={14} color={cellColor} textAlign="center" numberOfLines={1}>
          {movie.genres.join(', ')}
        </Text>
      )}

      {visibleColumns.rated && (
        <Text testID="movie-list-item-rated" flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0} fontFamily="$body" fontSize={14} color={cellColor} textAlign="center">
          {movie.rated ?? '–'}
        </Text>
      )}

      {visibleColumns.ownedMedia && (
        <Text
          testID="movie-list-item-ownedMedia"
          flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0}
          fontFamily="$body"
          fontSize={14}
          fontWeight={mismatch ? '700' : '400'}
          color={mismatch ? mismatchColor : cellColor}
          textAlign="center"
          numberOfLines={1}
        >
          {movie.ownedMedia.join(', ')}
        </Text>
      )}

      {visibleColumns.ripQuality && (
        <Text
          testID="movie-list-item-ripQuality"
          flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0}
          fontFamily="$body"
          fontSize={14}
          fontWeight={mismatch ? '700' : '400'}
          color={mismatch ? mismatchColor : cellColor}
          textAlign="center"
          numberOfLines={1}
        >
          {movie.ripQuality.join(', ')}
        </Text>
      )}

      {visibleColumns.runtime && (
        <Text testID="movie-list-item-runtime" flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0} fontFamily="$body" fontSize={14} color={cellColor} textAlign="center">
          {movie.runtime !== null ? `${movie.runtime}m` : '–'}
        </Text>
      )}

      {visibleColumns.directors && (
        <Text testID="movie-list-item-directors" flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0} fontFamily="$body" fontSize={14} color={cellColor} textAlign="center" numberOfLines={1}>
          {movie.directors.join(', ')}
        </Text>
      )}

      {visibleColumns.actors && (
        <Text testID="movie-list-item-actors" flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0} fontFamily="$body" fontSize={14} color={cellColor} textAlign="center" numberOfLines={1}>
          {movie.actors.join(', ')}
        </Text>
      )}
    </XStack>
  );
}
