/**
 * Add-movie route — sibling to [collectionId]/index.tsx so that
 * `collectionId` is inherited as a path param without a nested Stack.
 *
 * Route: /collections/:collectionId/add-movie
 * Navigate here with: router.push(`/collections/${collectionId}/add-movie`)
 *
 * NewMovieScreen reads collectionId from useLocalSearchParams (path param).
 */

import React from 'react';
import { NewMovieScreen } from '@/screens/movies/new-movie-screen';

export default function AddMovieRoute(): React.JSX.Element {
  return <NewMovieScreen />;
}
