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
import { useReportUiState } from '@/hooks/use-ui-state';

export default function CollectionRoute(): React.JSX.Element {
  const { collectionId } = useLocalSearchParams<{ collectionId: string }>();

  // US3: report the on-screen collection so "add <movie> to this" resolves it.
  useReportUiState({ current_screen: 'collection', collection_id: collectionId, nav_depth: 1 });

  return <CollectionScreen collectionId={collectionId} />;
}
