/**
 * MovieListItem component (T126)
 *
 * Renders a single row in the movie list table.
 * Title is always shown; all other columns are conditionally rendered
 * based on the visibleColumns prop.
 *
 * Each cell has a testID: `movie-list-item-{columnKey}`.
 * The row itself has testID: `movie-list-item-row`.
 */

import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import type { Movie, ColumnVisibility } from '@/types/collection';

interface MovieListItemProps {
  movie: Movie;
  visibleColumns: ColumnVisibility;
  onPress: (movieId: string) => void;
}

export function MovieListItem({ movie, visibleColumns, onPress }: MovieListItemProps) {
  return (
    <Pressable
      testID="movie-list-item-row"
      style={styles.row}
      onPress={() => onPress(movie.movieId)}
      accessibilityRole="button"
      accessibilityLabel={movie.title}
    >
      {/* Title — always visible */}
      <Text testID="movie-list-item-title" style={styles.cellTitle} numberOfLines={1}>
        {movie.title}
      </Text>

      {visibleColumns.year && (
        <Text testID="movie-list-item-year" style={styles.cell}>
          {movie.year}
        </Text>
      )}

      {visibleColumns.contentType && (
        <Text testID="movie-list-item-contentType" style={styles.cell}>
          {movie.contentType}
        </Text>
      )}

      {visibleColumns.language && (
        <Text testID="movie-list-item-language" style={styles.cell}>
          {/* 014 US1: neutral placeholder when a movie has no recorded language. */}
          {movie.language || '—'}
        </Text>
      )}

      {visibleColumns.owned && (
        <Text testID="movie-list-item-owned" style={styles.cell}>
          {movie.owned ? '✓' : '–'}
        </Text>
      )}

      {visibleColumns.ripped && (
        <Text testID="movie-list-item-ripped" style={styles.cell}>
          {movie.ripped ? '✓' : '–'}
        </Text>
      )}

      {visibleColumns.childrens && (
        <Text testID="movie-list-item-childrens" style={styles.cell}>
          {movie.childrens ? '✓' : '–'}
        </Text>
      )}

      {visibleColumns.genres && (
        <Text testID="movie-list-item-genres" style={styles.cell} numberOfLines={1}>
          {movie.genres.join(', ')}
        </Text>
      )}

      {visibleColumns.rated && (
        <Text testID="movie-list-item-rated" style={styles.cell}>
          {movie.rated ?? '–'}
        </Text>
      )}

      {visibleColumns.ownedMedia && (
        <Text testID="movie-list-item-ownedMedia" style={styles.cell} numberOfLines={1}>
          {movie.ownedMedia.join(', ')}
        </Text>
      )}

      {visibleColumns.ripQuality && (
        <Text testID="movie-list-item-ripQuality" style={styles.cell} numberOfLines={1}>
          {movie.ripQuality.join(', ')}
        </Text>
      )}

      {visibleColumns.runtime && (
        <Text testID="movie-list-item-runtime" style={styles.cell}>
          {movie.runtime !== null ? `${movie.runtime}m` : '–'}
        </Text>
      )}

      {visibleColumns.directors && (
        <Text testID="movie-list-item-directors" style={styles.cell} numberOfLines={1}>
          {movie.directors.join(', ')}
        </Text>
      )}

      {visibleColumns.actors && (
        <Text testID="movie-list-item-actors" style={styles.cell} numberOfLines={1}>
          {movie.actors.join(', ')}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e0e0e0',
    gap: 8,
  },
  cellTitle: {
    flex: 2,
    fontSize: 14,
    fontWeight: '500',
    color: '#111',
  },
  cell: {
    flex: 1,
    fontSize: 13,
    color: '#444',
    textAlign: 'center',
  },
});
