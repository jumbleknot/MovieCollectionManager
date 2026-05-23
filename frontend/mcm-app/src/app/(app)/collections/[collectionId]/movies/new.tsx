/**
 * New movie route (T107 support)
 *
 * Route: /collections/:collectionId/movies/new
 * Renders the NewMovieScreen which shows MovieForm for creation.
 *
 * Nested under `collections/[collectionId]/` so collectionId param
 * is available via useLocalSearchParams.
 *
 * Note: This route will remain in place when Phase 5 adds the full movie
 * list to the collection screen.
 */

import React from 'react';
import { NewMovieScreen } from '@/screens/movies/new-movie-screen';

export default function NewMovieRoute(): React.JSX.Element {
  return <NewMovieScreen />;
}
