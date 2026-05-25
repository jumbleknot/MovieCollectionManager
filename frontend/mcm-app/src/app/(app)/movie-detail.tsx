/**
 * Movie-detail route — flat (app)-level route to avoid nested-Stack navigation
 * issues in Expo Router v55 when pushing from [collectionId]/index.
 *
 * Receives collectionId and movieId via query params:
 *   router.replace({ pathname: '/movie-detail', params: { collectionId, movieId } })
 *
 * MovieDetailScreen reads both params from useLocalSearchParams.
 */

import React from 'react';
import { MovieDetailScreen } from '@/screens/movies/movie-detail-screen';

export default function MovieDetailRoute(): React.JSX.Element {
  return <MovieDetailScreen />;
}
