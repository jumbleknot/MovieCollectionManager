/**
 * CollectionList component (T061)
 *
 * Renders a scrollable list of CollectionCard components, or an empty-state
 * message when the list is empty.
 *
 * Uses a plain ScrollView for web compatibility. The native variant
 * (collection-list.native.tsx) uses FlatList for performance on mobile.
 */

import React from 'react';
import { ScrollView, View, Text, StyleSheet } from 'react-native';
import { CollectionCard } from '@/components/collection-card';
import type { CollectionSummary } from '@/types/collection';

interface CollectionListProps {
  collections: CollectionSummary[];
  onCollectionTap: (collectionId: string) => void;
  onEdit: (collection: CollectionSummary) => void;
  onSetDefault: (collectionId: string) => void;
  onDelete: (collectionId: string) => void;
}

export function CollectionList({
  collections,
  onCollectionTap,
  onEdit,
  onSetDefault,
  onDelete,
}: CollectionListProps): React.JSX.Element {
  if (collections.length === 0) {
    return (
      <View
        style={styles.emptyContainer}
        testID="collection-list-empty-state"
      >
        <Text style={styles.emptyTitle}>No collections yet</Text>
        <Text style={styles.emptySubtitle}>
          Create your first collection to start managing your movies.
        </Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.list}
      contentContainerStyle={styles.listContent}
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

const styles = StyleSheet.create({
  list: {
    flex: 1,
  },
  listContent: {
    padding: 16,
    paddingBottom: 32,
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
