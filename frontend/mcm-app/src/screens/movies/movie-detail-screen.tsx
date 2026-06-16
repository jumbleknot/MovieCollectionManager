/**
 * MovieDetailScreen component (T104 + T149)
 *
 * Renders MovieDetail in read-only mode with a back button.
 * Switches to MovieForm (edit mode) when Edit is pressed.
 * Submitting the form calls updateMovie via use-movies hook.
 * Cancel returns to detail view without saving.
 * Delete button opens DeleteConfirmationDialog; confirming calls deleteMovie
 * via use-movies hook then navigates back (T149).
 *
 * Route params: collectionId, movieId (from useLocalSearchParams)
 * Fetches the movie on mount via getMovie.
 */

import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { useTheme } from '@tamagui/core';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { MovieDetail } from '@/components/movie-detail';
import { MovieForm } from '@/components/movie-form';
import { DeleteConfirmationDialog } from '@/components/delete-confirmation-dialog';
import { useMovies } from '@/hooks/use-movies';
import { useAssistantDataRefresh } from '@/hooks/use-assistant-data-sync';
import type { CreateMovieRequest } from '@/types/collection';

export function MovieDetailScreen(): React.JSX.Element {
  const { collectionId, movieId } = useLocalSearchParams<{
    collectionId: string;
    movieId: string;
  }>();
  const router = useRouter();
  const theme = useTheme();

  const { movie, isLoading, error, getMovie, updateMovie, deleteMovie } = useMovies(collectionId);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleteDialogVisible, setIsDeleteDialogVisible] = useState(false);

  useEffect(() => {
    if (movieId) {
      getMovie(movieId);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movieId]);

  // T072: the assistant can update THIS movie while the detail screen is focused — re-fetch it
  // when an approved assistant write completes so the on-screen detail isn't stale.
  useAssistantDataRefresh(() => {
    if (movieId) void getMovie(movieId);
  });

  const handleEdit = () => setIsEditing(true);
  const handleEditCancel = () => setIsEditing(false);

  const handleEditSubmit = async (values: CreateMovieRequest) => {
    if (!movieId) return;
    setIsSaving(true);
    try {
      await updateMovie(movieId, values);
      setIsEditing(false); // only close form on success
    } catch {
      // updateMovie already set error state; displayed via serverError prop on MovieForm.
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = () => setIsDeleteDialogVisible(true);
  const handleDeleteCancel = () => setIsDeleteDialogVisible(false);

  const handleDeleteConfirm = async () => {
    if (!movieId) return;
    try {
      await deleteMovie(movieId);
    } catch {
      // error is shown if needed; still navigate back (movie may be deleted)
    }
    router.back();
  };

  if (isLoading) {
    return (
      <View style={[styles.centered, { backgroundColor: theme.background?.val }]} testID="movie-detail-screen-loading">
        <ActivityIndicator size="large" color={theme.primary?.val} />
      </View>
    );
  }

  if (!movie) {
    return <View style={[styles.centered, { backgroundColor: theme.background?.val }]} testID="movie-detail-screen-empty" />;
  }

  if (isEditing) {
    return (
      <MovieForm
        mode="edit"
        initialValues={movie}
        onSubmit={handleEditSubmit}
        onCancel={handleEditCancel}
        isLoading={isSaving}
        serverError={error}
      />
    );
  }

  return (
    <View style={[styles.screen, { backgroundColor: theme.background?.val }]}>
      {/* Back button — themed so the bar isn't a high-contrast white block in dark mode. */}
      <TouchableOpacity
        style={[styles.backButton, { backgroundColor: theme.surface1?.val, borderBottomColor: theme.outlineVariant?.val }]}
        onPress={() => router.back()}
        testID="movie-detail-back-button"
        accessibilityRole="button"
        accessibilityLabel="Go back to collection"
      >
        <Text style={[styles.backText, { color: theme.primary?.val }]}>← Back</Text>
      </TouchableOpacity>

      <MovieDetail
        movie={movie}
        onEdit={handleEdit}
        onDelete={handleDelete}
      />
      <DeleteConfirmationDialog
        visible={isDeleteDialogVisible}
        entityName={movie.title}
        onConfirm={handleDeleteConfirm}
        onCancel={handleDeleteCancel}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#f7fafc',
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backButton: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  backText: {
    color: '#3182ce',
    fontSize: 16,
    fontWeight: '600',
  },
});
