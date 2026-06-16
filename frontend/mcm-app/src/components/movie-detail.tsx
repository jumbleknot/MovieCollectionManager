/**
 * MovieDetail component (T102)
 *
 * Read-only view of all movie attributes.
 * Shows Edit and Delete action buttons.
 *
 * Edit button calls onEdit callback (parent switches to MovieForm).
 * Delete button calls onDelete callback (parent opens DeleteConfirmationDialog).
 */

import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Linking,
  Platform,
} from 'react-native';
import { useTheme } from '@tamagui/core';
import type { Movie } from '@/types/collection';
import { isSafeHttpUrl } from '@/utils/http-url';

/** Opens a URL: new tab on web, system browser on native. */
function openUrl(url: string): void {
  // Refuse non-http(s) schemes (e.g. javascript:, data:) — 009 finding #1 (FR-003).
  if (!isSafeHttpUrl(url)) return;
  if (Platform.OS === 'web') {
    window.open(url, '_blank', 'noopener,noreferrer');
  } else {
    void Linking.openURL(url);
  }
}

interface MovieDetailProps {
  movie: Movie;
  onEdit: () => void;
  onDelete: () => void;
}

export function MovieDetail({ movie, onEdit, onDelete }: MovieDetailProps): React.JSX.Element {
  const theme = useTheme();
  const styles = makeStyles(theme);
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Title */}
      <Text style={styles.title} testID="movie-detail-title">
        {movie.title}
      </Text>

      {/* Core fields */}
      <View style={styles.row}>
        <Text style={styles.label}>Year</Text>
        <Text style={styles.value} testID="movie-detail-year">
          {movie.year}
        </Text>
      </View>

      <View style={styles.row}>
        <Text style={styles.label}>Type</Text>
        <Text style={styles.value} testID="movie-detail-content-type">
          {movie.contentType}
        </Text>
      </View>

      <View style={styles.row}>
        <Text style={styles.label}>Language</Text>
        <Text style={styles.value} testID="movie-detail-language">
          {/* 014 US1: neutral placeholder when a movie has no recorded language. */}
          {movie.language || '—'}
        </Text>
      </View>

      {/* Boolean flags */}
      <View style={styles.row}>
        <Text style={styles.label}>Owned</Text>
        <Text
          style={[styles.value, movie.owned ? styles.yes : styles.no]}
          testID="movie-detail-owned"
        >
          {movie.owned ? 'Yes' : 'No'}
        </Text>
      </View>

      {movie.owned && movie.ownedMedia.length > 0 && (
        <View style={styles.row}>
          <Text style={styles.label}>Media</Text>
          <Text style={styles.value} testID="movie-detail-owned-media">
            {movie.ownedMedia.join(', ')}
          </Text>
        </View>
      )}

      <View style={styles.row}>
        <Text style={styles.label}>Ripped</Text>
        <Text
          style={[styles.value, movie.ripped ? styles.yes : styles.no]}
          testID="movie-detail-ripped"
        >
          {movie.ripped ? 'Yes' : 'No'}
        </Text>
      </View>

      {movie.ripped && movie.ripQuality.length > 0 && (
        <View style={styles.row}>
          <Text style={styles.label}>Rip Quality</Text>
          <Text style={styles.value} testID="movie-detail-rip-quality">
            {movie.ripQuality.join(', ')}
          </Text>
        </View>
      )}

      <View style={styles.row}>
        <Text style={styles.label}>Children's</Text>
        <Text
          style={[styles.value, movie.childrens ? styles.yes : styles.no]}
          testID="movie-detail-childrens"
        >
          {movie.childrens ? 'Yes' : 'No'}
        </Text>
      </View>

      {/* Optional fields */}
      {movie.genres.length > 0 && (
        <View style={styles.row}>
          <Text style={styles.label}>Genres</Text>
          <Text style={styles.value} testID="movie-detail-genres">
            {movie.genres.join(', ')}
          </Text>
        </View>
      )}

      {movie.rated != null && (
        <View style={styles.row}>
          <Text style={styles.label}>Rated</Text>
          <Text style={styles.value} testID="movie-detail-rated">
            {movie.rated}
          </Text>
        </View>
      )}

      {movie.directors.length > 0 && (
        <View style={styles.row}>
          <Text style={styles.label}>Directors</Text>
          <Text style={styles.value} testID="movie-detail-directors">
            {movie.directors.join(', ')}
          </Text>
        </View>
      )}

      {movie.actors.length > 0 && (
        <View style={styles.row}>
          <Text style={styles.label}>Actors</Text>
          <Text style={styles.value} testID="movie-detail-actors">
            {movie.actors.join(', ')}
          </Text>
        </View>
      )}

      {movie.runtime != null && (
        <View style={styles.row}>
          <Text style={styles.label}>Runtime</Text>
          <Text style={styles.value} testID="movie-detail-runtime">
            {`${movie.runtime} min`}
          </Text>
        </View>
      )}

      {movie.releaseDate != null && (
        <View style={styles.row}>
          <Text style={styles.label}>Release Date</Text>
          <Text style={styles.value} testID="movie-detail-release-date">
            {movie.releaseDate}
          </Text>
        </View>
      )}

      {movie.outline != null && (
        <View style={styles.section}>
          <Text style={styles.label}>Outline</Text>
          <Text style={styles.body} testID="movie-detail-outline">
            {movie.outline}
          </Text>
        </View>
      )}

      {movie.plot != null && (
        <View style={styles.section}>
          <Text style={styles.label}>Plot</Text>
          <Text style={styles.body} testID="movie-detail-plot">
            {movie.plot}
          </Text>
        </View>
      )}

      {movie.originalTitle != null && (
        <View style={styles.row}>
          <Text style={styles.label}>Original Title</Text>
          <Text style={styles.value} testID="movie-detail-original-title">
            {movie.originalTitle}
          </Text>
        </View>
      )}

      {movie.movieSet != null && (
        <View style={styles.row}>
          <Text style={styles.label}>Movie Set</Text>
          <Text style={styles.value} testID="movie-detail-movie-set">
            {movie.movieSet}
          </Text>
        </View>
      )}

      {movie.tags.length > 0 && (
        <View style={styles.row}>
          <Text style={styles.label}>Tags</Text>
          <Text style={styles.value} testID="movie-detail-tags">
            {movie.tags.join(', ')}
          </Text>
        </View>
      )}

      {movie.externalIds.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.label}>External IDs</Text>
          <View testID="movie-detail-external-ids">
            {movie.externalIds.map((eid, idx) => (
              <View key={idx} style={styles.externalIdRow}>
                <Text style={styles.body}>
                  {eid.system}: {eid.uniqueId}
                </Text>
                {eid.url ? (
                  <TouchableOpacity
                    onPress={() => { openUrl(eid.url!); }}
                    testID={`movie-detail-ext-id-url-${idx}`}
                    accessibilityRole="link"
                    accessibilityLabel={`Open ${eid.system} link`}
                  >
                    <Text style={styles.linkText}>{eid.url}</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            ))}
          </View>
        </View>
      )}

      {/* Actions */}
      <View style={styles.actions}>
        <TouchableOpacity
          style={styles.editButton}
          onPress={onEdit}
          testID="movie-detail-edit-button"
          accessibilityRole="button"
          accessibilityLabel="Edit movie"
        >
          <Text style={styles.editText}>Edit</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.deleteButton}
          onPress={onDelete}
          testID="movie-detail-delete-button"
          accessibilityRole="button"
          accessibilityLabel="Delete movie"
        >
          <Text style={styles.deleteText}>Delete</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

type Theme = ReturnType<typeof useTheme>;

const makeStyles = (theme: Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.background?.val },
  content: { padding: 16 },
  title: {
    fontFamily: 'Outfit',
    fontSize: 22,
    fontWeight: '800',
    color: theme.onSurface?.val,
    marginBottom: 16,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: theme.outlineVariant?.val,
  },
  section: {
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: theme.outlineVariant?.val,
  },
  label: {
    fontFamily: 'Inter',
    fontSize: 14,
    color: theme.onSurfaceVariant?.val,
    fontWeight: '600',
    flex: 1,
  },
  value: {
    fontFamily: 'Inter',
    fontSize: 14,
    color: theme.onSurface?.val,
    flex: 2,
    textAlign: 'right',
  },
  body: {
    fontFamily: 'Inter',
    fontSize: 14,
    color: theme.onSurfaceVariant?.val,
    marginTop: 4,
    lineHeight: 20,
  },
  externalIdRow: {
    marginTop: 4,
  },
  linkText: {
    fontFamily: 'Inter',
    fontSize: 14,
    color: theme.primary?.val,
    textDecorationLine: 'underline',
    marginTop: 2,
  },
  yes: { color: '#68d391' },
  no: { color: theme.onSurfaceVariant?.val },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
    marginTop: 32,
  },
  editButton: {
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: theme.outline?.val,
  },
  editText: {
    color: theme.primary?.val,
    fontFamily: 'Inter',
    fontSize: 16,
    fontWeight: '700',
  },
  deleteButton: {
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 24,
    backgroundColor: theme.error?.val,
  },
  deleteText: {
    color: theme.onError?.val,
    fontFamily: 'Inter',
    fontSize: 16,
    fontWeight: '700',
  },
});
