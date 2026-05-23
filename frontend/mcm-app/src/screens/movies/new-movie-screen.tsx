/**
 * NewMovieScreen (T107 support)
 *
 * Renders the MovieForm for creating a new movie within a collection.
 * On successful creation, navigates to the movie detail screen.
 * On cancel, navigates back to the collection screen.
 *
 * Route params: collectionId (from useLocalSearchParams)
 */

import React, { useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { MovieForm } from '@/components/movie-form';
import { useMovies } from '@/hooks/use-movies';
import type { CreateMovieRequest } from '@/types/collection';

export function NewMovieScreen(): React.JSX.Element {
  const { collectionId } = useLocalSearchParams<{ collectionId: string }>();
  const router = useRouter();
  const { createMovie, movie } = useMovies(collectionId);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (req: CreateMovieRequest) => {
    setIsSubmitting(true);
    try {
      await createMovie(req);
      // Navigate to movie detail once we have the movieId from the created movie
      // The hook sets `movie` after creation; navigate using that ID
    } finally {
      setIsSubmitting(false);
    }
  };

  // After creation, the useMovies hook sets `movie`; navigate to detail
  React.useEffect(() => {
    if (movie?.movieId) {
      router.replace(`/collections/${collectionId}/movies/${movie.movieId}`);
    }
  }, [movie?.movieId, collectionId, router]);

  const handleCancel = () => {
    router.back();
  };

  return (
    <View style={styles.container} testID="new-movie-screen">
      <MovieForm
        mode="create"
        onSubmit={handleSubmit}
        onCancel={handleCancel}
        isLoading={isSubmitting}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
});
