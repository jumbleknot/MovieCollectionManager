/**
 * HomeScreen component (T063)
 *
 * Displays the user's collection list and a "Create Collection" button.
 * Opening a collection navigates to /collections/[collectionId].
 * The create form appears inline as a modal overlay.
 * Edit opens a pre-filled modal; save calls updateCollection.
 * Delete prompts a confirmation dialog before calling deleteCollection.
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
  KeyboardAvoidingView,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { CollectionList } from '@/components/collection-list';
import { CollectionForm } from '@/components/collection-form';
import { DeleteConfirmationDialog } from '@/components/delete-confirmation-dialog';
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

  // ─── Create modal state ─────────────────────────────────────────────────────
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [isCreating, setIsCreating] = useState(false);

  // ─── Edit modal state ───────────────────────────────────────────────────────
  const [editingCollection, setEditingCollection] = useState<CollectionSummary | null>(null);
  const [isEditing, setIsEditing] = useState(false);

  // ─── Delete dialog state ────────────────────────────────────────────────────
  const [collectionToDelete, setCollectionToDelete] = useState<CollectionSummary | null>(null);

  // ─── Handlers ───────────────────────────────────────────────────────────────

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

  const handleEdit = (collection: CollectionSummary) => {
    setEditingCollection(collection);
  };

  const handleEditSubmit = async (values: CreateCollectionRequest) => {
    if (!editingCollection) return;
    setIsEditing(true);
    try {
      await updateCollection(editingCollection.collectionId, values);
      setEditingCollection(null);
    } finally {
      setIsEditing(false);
    }
  };

  const handleEditCancel = () => {
    setEditingCollection(null);
  };

  const handleDeleteRequest = (collectionId: string) => {
    const collection = collections.find(c => c.collectionId === collectionId) ?? null;
    setCollectionToDelete(collection);
  };

  const handleDeleteConfirm = async () => {
    if (!collectionToDelete) return;
    const id = collectionToDelete.collectionId;
    setCollectionToDelete(null);
    await deleteCollection(id);
  };

  const handleDeleteCancel = () => {
    setCollectionToDelete(null);
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
            onDelete={handleDeleteRequest}
          />
        </>
      )}

      {/* Create collection modal */}
      <Modal
        visible={showCreateForm}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowCreateForm(false)}
      >
        {/*
          behavior="padding" (both platforms): pushes content UP by keyboard height so buttons
          stay above the keyboard fold. "height" shrinks the container and can hide buttons.
          ScrollView + keyboardShouldPersistTaps="handled": lets taps reach buttons even while
          the keyboard is open (the button "handles" the tap → keyboard persists but button fires).
          This removes the need for explicit keyboard-dismiss steps in E2E tests.
        */}
        <KeyboardAvoidingView
          style={styles.keyboardAvoid}
          behavior="padding"
        >
          {/* testID on inner View — Modal root doesn't expose testID to Maestro on Android */}
          <SafeAreaView style={styles.modalContainer} testID="home-screen-create-modal">
            <Text style={styles.modalTitle}>New Collection</Text>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.modalScroll}>
              <CollectionForm
                mode="create"
                onSubmit={handleCreateSubmit}
                onCancel={() => setShowCreateForm(false)}
                isLoading={isCreating}
              />
            </ScrollView>
          </SafeAreaView>
        </KeyboardAvoidingView>
      </Modal>

      {/* Edit collection modal */}
      <Modal
        visible={editingCollection !== null}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={handleEditCancel}
      >
        <KeyboardAvoidingView
          style={styles.keyboardAvoid}
          behavior="padding"
        >
          {/* testID on inner View — Modal root doesn't expose testID to Maestro on Android */}
          <SafeAreaView style={styles.modalContainer} testID="home-screen-edit-modal">
            <Text style={styles.modalTitle}>Edit Collection</Text>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.modalScroll}>
              {editingCollection !== null && (
                <CollectionForm
                  mode="edit"
                  initialValues={{
                    name: editingCollection.name,
                    description: editingCollection.description,
                  }}
                  onSubmit={handleEditSubmit}
                  onCancel={handleEditCancel}
                  isLoading={isEditing}
                />
              )}
            </ScrollView>
          </SafeAreaView>
        </KeyboardAvoidingView>
      </Modal>

      {/* Delete confirmation dialog */}
      <DeleteConfirmationDialog
        visible={collectionToDelete !== null}
        entityName={collectionToDelete?.name ?? ''}
        onConfirm={handleDeleteConfirm}
        onCancel={handleDeleteCancel}
      />
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
  keyboardAvoid: {
    flex: 1,
  },
  modalContainer: {
    flex: 1,
    backgroundColor: '#fff',
  },
  modalScroll: {
    flexGrow: 1,
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
