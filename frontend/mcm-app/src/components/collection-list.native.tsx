/**
 * CollectionList component — native variant (T061)
 *
 * Uses React Native FlatList for virtualized rendering on Android/iOS.
 * The web variant (collection-list.tsx) uses ScrollView.
 */

import React, { useCallback } from 'react';
import { FlatList, View, Text, StyleSheet } from 'react-native';
import { CollectionCard } from '@/components/collection-card';
import type { CollectionSummary } from '@/types/collection';

interface CollectionListProps {
  collections: CollectionSummary[];
  onCollectionTap: (collectionId: string) => void;
  onEdit: (collection: CollectionSummary) => void;
  onSetDefault: (collectionId: string) => void;
  onDelete: (collectionId: string) => void;
}

function EmptyState() {
  return (
    <View style={styles.emptyContainer} testID="collection-list-empty-state">
      <Text style={styles.emptyTitle}>No collections yet</Text>
      <Text style={styles.emptySubtitle}>
        Create your first collection to start managing your movies.
      </Text>
    </View>
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
      contentContainerStyle={[
        styles.listContent,
        collections.length === 0 && styles.emptyFlex,
      ]}
      ListEmptyComponent={EmptyState}
      testID="collection-list"
    />
  );
}

const styles = StyleSheet.create({
  listContent: {
    padding: 16,
    paddingBottom: 32,
  },
  emptyFlex: {
    flex: 1,
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#2d3748',
    marginBottom: 8,
    textAlign: 'center',
  },
  emptySubtitle: {
    fontSize: 15,
    color: '#718096',
    textAlign: 'center',
    lineHeight: 22,
  },
});
