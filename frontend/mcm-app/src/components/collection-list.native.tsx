/**
 * CollectionList component — native variant (T061; feature 015 re-skin)
 *
 * Uses React Native FlatList for virtualized rendering on Android/iOS.
 * The web variant (collection-list.tsx) uses ScrollView.
 *
 * Re-skinned: empty state uses theme tokens (FR-002 / FR-018; testIDs unchanged).
 */

import React, { useCallback } from 'react';
import { FlatList } from 'react-native';
import { Text, useTheme } from '@tamagui/core';
import { YStack } from '@tamagui/stacks';
import { CollectionCard } from '@/components/collection-card';
import type { CollectionSummary } from '@/types/collection';

interface CollectionListProps {
  collections: CollectionSummary[];
  onCollectionTap: (collectionId: string) => void;
  onEdit: (collection: CollectionSummary) => void;
  onSetDefault: (collectionId: string) => void;
  onDelete: (collectionId: string) => void;
}

function EmptyState(): React.JSX.Element {
  const theme = useTheme();
  return (
    <YStack flex={1} alignItems="center" justifyContent="center" padding={32} testID="collection-list-empty-state">
      <Text fontFamily="$heading" fontSize={20} fontWeight="700" color={theme.onSurface?.val} marginBottom={8} textAlign="center">
        No collections yet
      </Text>
      <Text fontFamily="$body" fontSize={15} color={theme.onSurfaceVariant?.val} textAlign="center" lineHeight={22}>
        Create your first collection to start managing your movies.
      </Text>
    </YStack>
  );
}

export function CollectionList({
  collections,
  onCollectionTap,
  onEdit,
  onSetDefault,
  onDelete,
}: CollectionListProps): React.JSX.Element {
  const renderItem = useCallback(
    ({ item }: { item: CollectionSummary }) => (
      <CollectionCard
        collection={item}
        onOpen={onCollectionTap}
        onEdit={onEdit}
        onSetDefault={onSetDefault}
        onDelete={onDelete}
      />
    ),
    [onCollectionTap, onEdit, onSetDefault, onDelete]
  );

  const keyExtractor = useCallback(
    (item: CollectionSummary) => item.collectionId,
    []
  );

  return (
    <FlatList
      data={collections}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      contentContainerStyle={
        collections.length === 0
          ? { padding: 16, paddingBottom: 32, flex: 1 }
          : { padding: 16, paddingBottom: 32 }
      }
      ListEmptyComponent={EmptyState}
      testID="collection-list"
    />
  );
}
