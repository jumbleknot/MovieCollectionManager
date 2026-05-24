/**
 * HomeScreen component (T063)
 *
 * Displays the user's collection list and a "Create Collection" button.
 * Opening a collection navigates to /collections/[collectionId].
 * The create form appears inline as a modal overlay.
 *
 * Navigation post-login:
 *   - If the user has a default collection, the (app)/_layout or home.tsx
 *     will handle the redirect via FR-009 (see T064).
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Modal,
  SafeAreaView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { CollectionList } from '@/components/collection-list';
import { CollectionForm } from '@/components/collection-form';
import { useCollections } from '@/hooks/use-collections';
import type { CollectionSummary, CreateCollectionRequest } from '@/types/collection';

export function HomeScreen(): React.JSX.Element {
  const router = useRouter();
  const {
    collections,
    isLoading,
    error,
    createCollection,
    updateCollection,
    setDefaultCollection,
    deleteCollection,
  } = useCollections();

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [isCreating, setIsCreating] = useState(false);

  const handleCollectionTap = (collectionId: string) => {
    router.push(`/collections/${collectionId}`);
  };

  const handleCreateSubmit = async (values: CreateCollectionRequest) => {
    setIsCreating(true);
    try {
      await createCollection(values);
      setShowCreateForm(false);
    } finally {
      setIsCreating(false);
    }
  };

  const handleEdit = (_collection: CollectionSummary) => {
    // Edit modal — implemented in T063 extension; stub for now
  };

  return (
    <SafeAreaView style={styles.container} testID="home-route">
      {isLoading ? (
        /* Loading state — same root element avoids root-element swap on hydration */
        <View style={styles.centered} testID="home-screen-loading">
          <ActivityIndicator size="large" color="#3182ce" />
        </View>
      ) : (
        <>
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.title}>My Collections</Text>
            <TouchableOpacity
              style={styles.createButton}
              onPress={() => setShowCreateForm(true)}
              testID="home-screen-create-button"
              accessibilityRole="button"
              accessibilityLabel="Create new collection"
            >
              <Text style={styles.createButtonText}>+ Create</Text>
            </TouchableOpacity>
          </View>

          {/* Error banner */}
          {error && (
            <View style={styles.errorBanner} testID="home-screen-error">
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          {/* Collection list */}
          <CollectionList
            collections={collections}
            onCollectionTap={handleCollectionTap}
            onEdit={handleEdit}
            onSetDefault={setDefaultCollection}
            onDelete={deleteCollection}
          />
        </>
      )}

      {/* Create collection modal — always mounted so state is preserved */}
      <Modal
        visible={showCreateForm}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowCreateForm(false)}
        testID="home-screen-create-modal"
      >
        <SafeAreaView style={styles.modalContainer}>
          <Text style={styles.modalTitle}>New Collection</Text>
          <CollectionForm
            mode="create"
            onSubmit={handleCreateSubmit}
            onCancel={() => setShowCreateForm(false)}
            isLoading={isCreating}
          />
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f7fafc',
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  title: {
    fontSize: 22,
    fontWeight: '800',
    color: '#1a202c',
  },
  createButton: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    backgroundColor: '#3182ce',
    borderRadius: 8,
  },
  createButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  errorBanner: {
    backgroundColor: '#fff5f5',
    borderColor: '#feb2b2',
    borderWidth: 1,
    margin: 12,
    borderRadius: 8,
    padding: 12,
  },
  errorText: {
    color: '#c53030',
    fontSize: 14,
  },
  modalContainer: {
    flex: 1,
    backgroundColor: '#fff',
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: '#1a202c',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
  },
});
