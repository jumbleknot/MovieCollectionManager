/**
 * MovieDetailScreen component (T104 + T149)
 *
 * Renders MovieDetail in read-only mode.
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
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { MovieDetail } from '@/components/movie-detail';
import { MovieForm } from '@/components/movie-form';
import { DeleteConfirmationDialog } from '@/components/delete-confirmation-dialog';
import { useMovies } from '@/hooks/use-movies';
import type { CreateMovieRequest } from '@/types/collection';

export function MovieDetailScreen(): React.JSX.Element {
  const { collectionId, movieId } = useLocalSearchParams<{
    collectionId: string;
    movieId: string;
  }>();
  const router = useRouter();

  const { movie, isLoading, getMovie, updateMovie, deleteMovie } = useMovies(collectionId);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleteDialogVisible, setIsDeleteDialogVisible] = useState(false);

  useEffect(() => {
    if (movieId) {
      getMovie(movieId);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movieId]);

  const handleEdit = () => setIsEditing(true);
  const handleEditCancel = () => setIsEditing(false);

  const handleEditSubmit = async (values: CreateMovieRequest) => {
    if (!movieId) return;
    setIsSaving(true);
    try {
      await updateMovie(movieId, values);
      setIsEditing(false);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = () => setIsDeleteDialogVisible(true);
  const handleDeleteCancel = () => setIsDeleteDialogVisible(false);

  const handleDeleteConfirm = async () => {
    if (!movieId) return;
    await deleteMovie(movieId);
    router.back();
  };

  if (isLoading) {
    return (
      <View style={styles.centered} testID="movie-detail-screen-loading">
        <ActivityIndicator size="large" color="#3182ce" />
      </View>
    );
  }

  if (!movie) {
    return <View style={styles.centered} testID="movie-detail-screen-empty" />;
  }

  if (isEditing) {
    return (
      <MovieForm
        mode="edit"
        initialValues={movie}
        onSubmit={handleEditSubmit}
        onCancel={handleEditCancel}
        isLoading={isSaving}
      />
    );
  }

  return (
    <>
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
    </>
  );
}

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
