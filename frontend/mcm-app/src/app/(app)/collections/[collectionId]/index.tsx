/**
 * Collection screen route (T065 → T136)
 *
 * Directory-based route so nested movie routes can inherit the `collectionId`
 * param: `collections/[collectionId]/movies/[movieId].tsx`.
 *
 * T136: Renders CollectionScreen (browse/search/filter movie list).
 * Replaces the Phase 3 placeholder from T065.
 */

import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { CollectionScreen } from '@/screens/collections/collection-screen';

export default function CollectionRoute(): React.JSX.Element {
  const { collectionId } = useLocalSearchParams<{ collectionId: string }>();

  return <CollectionScreen collectionId={collectionId} />;
}
