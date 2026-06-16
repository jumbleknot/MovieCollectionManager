/**
 * CollectionList component (T061; feature 015 re-skin) — web default.
 *
 * Renders a scrollable list of CollectionCard components, or an empty-state
 * message when the list is empty.
 *
 * Re-skinned onto the MCM Cinema design system (Tamagui): surface + typography
 * use theme tokens. Structure, props, behaviour, and every testID are unchanged
 * (FR-002 / FR-018). The native variant (collection-list.native.tsx) uses
 * FlatList for performance on mobile.
 */

import React from 'react';
import { ScrollView } from 'react-native';
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
      <Text fontFamily="$body" fontSize={16} color={theme.onSurfaceVariant?.val} textAlign="center" lineHeight={22}>
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
  if (collections.length === 0) {
    return <EmptyState />;
  }

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
      testID="collection-list"
    >
      {collections.map(collection => (
        <CollectionCard
          key={collection.collectionId}
          collection={collection}
          onOpen={onCollectionTap}
          onEdit={onEdit}
          onSetDefault={onSetDefault}
          onDelete={onDelete}
        />
      ))}
    </ScrollView>
  );
}
