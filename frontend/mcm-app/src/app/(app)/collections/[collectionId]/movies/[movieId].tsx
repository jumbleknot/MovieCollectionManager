/**
 * Movie detail route (T105)
 *
 * Nested under `collections/[collectionId]/` directory so both
 * `collectionId` and `movieId` params are available via useLocalSearchParams.
 *
 * Route: /collections/:collectionId/movies/:movieId
 */

import React from 'react';
import { MovieDetailScreen } from '@/screens/movies/movie-detail-screen';

export default function MovieDetailRoute(): React.JSX.Element {
  return <MovieDetailScreen />;
}
