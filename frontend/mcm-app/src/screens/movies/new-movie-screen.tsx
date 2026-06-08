/**
 * NewMovieScreen (T107 support)
 *
 * Renders the MovieForm for creating a new movie within a collection.
 * On successful creation, navigates to the movie detail screen.
 * On cancel, navigates back to the collection screen.
 *
 * Route params: collectionId (from useLocalSearchParams)
 */

import React, { useEffect, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { MovieForm } from '@/components/movie-form';
import { useMovies } from '@/hooks/use-movies';
import type { CreateMovieRequest, Movie } from '@/types/collection';

export function NewMovieScreen(): React.JSX.Element {
  // `title`/`year` are OPTIONAL prefill params (US3/T059 prefill_add_movie). Absent → identical
  // to the existing empty add form (SC-005). They pre-fill the form only; the user still saves.
  const { collectionId, title, year } = useLocalSearchParams<{
    collectionId: string;
    title?: string;
    year?: string;
  }>();
  const router = useRouter();
  const { createMovie, movie, error } = useMovies(collectionId);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Build prefilled initial values only when a prefill param is present (else undefined →
  // unchanged blank form). Partial cast: MovieForm reads each field defensively (`?? ''`).
  const prefill: Movie | undefined =
    title || year
      ? ({
          title: title ?? '',
          year: year ? Number(year) : undefined,
        } as Movie)
      : undefined;

  const handleSubmit = async (values: CreateMovieRequest) => {
    setIsSubmitting(true);
    try {
      await createMovie(values);
      // On success, movie state is updated and the effect below navigates away.
    } catch {
      // createMovie already set error state; displayed via serverError prop.
    } finally {
      setIsSubmitting(false);
    }
  };

  // After successful creation, navigate to the movie detail screen.
  useEffect(() => {
    if (movie?.movieId) {
      router.replace(
        `/collections/${collectionId}/movies/${movie.movieId}` as Parameters<typeof router.replace>[0],
      );
    }
  }, [movie?.movieId, collectionId, router]);

  const handleCancel = () => {
    router.back();
  };

  return (
    <View style={styles.container} testID="new-movie-screen">
      <MovieForm
        mode="create"
        initialValues={prefill}
        onSubmit={handleSubmit}
        onCancel={handleCancel}
        isLoading={isSubmitting}
        serverError={error}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
});
