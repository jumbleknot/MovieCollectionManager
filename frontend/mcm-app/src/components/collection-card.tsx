/**
 * CollectionCard component (T056)
 *
 * Displays a single collection summary with name, description, movie count,
 * an optional "Default" badge, and an inline action menu (Open, Edit,
 * Set as Default, Delete).
 */

import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import type { CollectionSummary } from '@/types/collection';

interface CollectionCardProps {
  collection: CollectionSummary;
  onOpen: (collectionId: string) => void;
  onEdit: (collection: CollectionSummary) => void;
  onSetDefault: (collectionId: string) => void;
  onDelete: (collectionId: string) => void;
}

export function CollectionCard({
  collection,
  onOpen,
  onEdit,
  onSetDefault,
  onDelete,
}: CollectionCardProps): React.JSX.Element {
  const { collectionId, name, description, isDefault, movieCount } = collection;

  return (
    <TouchableOpacity
      style={styles.card}
      onPress={() => onOpen(collectionId)}
      testID="collection-card"
      accessibilityLabel={`Open collection ${name}`}
    >
      {/*
       * accessibilityRole="button" intentionally omitted on this outer wrapper.
       * The inner action buttons already carry role="button". Adding the role here
       * produces nested <button> elements on web — an HTML spec violation that
       * triggers the Expo dev error overlay. The wrapper remains pressable via
       * TouchableOpacity; ARIA role is surfaced through the action buttons below.
       */}
      {/* Header row: name + default badge */}
      <View style={styles.header}>
        <Text style={styles.name}>{name}</Text>
        {isDefault && (
          <View style={styles.badge} testID="collection-card-default-badge">
            <Text style={styles.badgeText}>Default</Text>
          </View>
        )}
      </View>

      {/* Description */}
      {description != null && (
        <Text
          style={styles.description}
          testID="collection-card-description"
          numberOfLines={2}
        >
          {description}
        </Text>
      )}

      {/* Movie count */}
      <Text style={styles.movieCount}>{movieCount} movies</Text>

      {/* Action row */}
      <View style={styles.actions}>
        <TouchableOpacity
          style={styles.actionButton}
          onPress={() => onOpen(collectionId)}
          testID="collection-card-action-open"
          accessibilityRole="button"
          accessibilityLabel="Open collection"
        >
          <Text style={styles.actionText}>Open</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.actionButton}
          onPress={() => onEdit(collection)}
          testID="collection-card-action-edit"
          accessibilityRole="button"
          accessibilityLabel="Edit collection"
        >
          <Text style={styles.actionText}>Edit</Text>
        </TouchableOpacity>

        {!isDefault && (
          <TouchableOpacity
            style={styles.actionButton}
            onPress={() => onSetDefault(collectionId)}
            testID="collection-card-action-set-default"
            accessibilityRole="button"
            accessibilityLabel="Set as default collection"
          >
            <Text style={styles.actionText}>Set as Default</Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity
          style={[styles.actionButton, styles.deleteButton]}
          onPress={() => onDelete(collectionId)}
          testID="collection-card-action-delete"
          accessibilityRole="button"
          accessibilityLabel="Delete collection"
        >
          <Text style={styles.deleteText}>Delete</Text>
        </TouchableOpacity>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  name: {
    fontSize: 17,
    fontWeight: '700',
    color: '#1a202c',
    flex: 1,
  },
  badge: {
    backgroundColor: '#3182ce',
    borderRadius: 6,
    paddingVertical: 2,
    paddingHorizontal: 8,
  },
  badgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
  description: {
    fontSize: 14,
    color: '#718096',
    marginBottom: 6,
  },
  movieCount: {
    fontSize: 13,
    color: '#a0aec0',
    marginBottom: 12,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  actionButton: {
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  actionText: {
    fontSize: 13,
    color: '#2d3748',
    fontWeight: '600',
  },
  deleteButton: {
    borderColor: '#feb2b2',
    backgroundColor: '#fff5f5',
  },
  deleteText: {
    fontSize: 13,
    color: '#c53030',
    fontWeight: '600',
  },
});
