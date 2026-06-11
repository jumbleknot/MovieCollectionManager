/**
 * Movie detail route (T105)
 *
 * Nested under `collections/[collectionId]/` directory so both
 * `collectionId` and `movieId` params are available via useLocalSearchParams.
 *
 * Route: /collections/:collectionId/movies/:movieId
 */

import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { MovieDetailScreen } from '@/screens/movies/movie-detail-screen';
import { useReportUiState } from '@/hooks/use-ui-state';

export default function MovieDetailRoute(): React.JSX.Element {
  const { collectionId, movieId } = useLocalSearchParams<{
    collectionId: string;
    movieId: string;
  }>();

  // US3: "this" on a movie-detail screen resolves to the containing collection.
  useReportUiState({
    current_screen: 'movie-detail',
    collection_id: collectionId,
    movie_id: movieId,
    nav_depth: 2,
  });

  return <MovieDetailScreen />;
}
