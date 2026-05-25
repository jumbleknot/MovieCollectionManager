/**
 * Add-movie route — flat (app)-level route to avoid nested-Stack navigation
 * issues in Expo Router v55 when pushing from [collectionId]/index.
 *
 * Receives collectionId via query param:
 *   router.push({ pathname: '/add-movie', params: { collectionId } })
 *
 * NewMovieScreen reads collectionId from useLocalSearchParams.
 */

import React from 'react';
import { NewMovieScreen } from '@/screens/movies/new-movie-screen';

export default function AddMovieRoute(): React.JSX.Element {
  return <NewMovieScreen />;
}
