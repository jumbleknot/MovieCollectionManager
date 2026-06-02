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

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { isAutoNavDone, markAutoNavDone } from '@/utils/default-collection-auto-nav';
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
import { useFocusEffect, useRouter } from 'expo-router';
import { CollectionList } from '@/components/collection-list';
import { CollectionForm } from '@/components/collection-form';
import { DeleteConfirmationDialog } from '@/components/delete-confirmation-dialog';
import { useCollections } from '@/hooks/use-collections';
import type { CollectionSummary, CreateCollectionRequest } from '@/types/collection';

// ─── FR-009 guard: auto-navigate to the default collection once per login ──────
// Cross-module invariant: clearAutoNav() is invoked on logout (use-auth.tsx) so
// the redirect fires again after the next login. Session/web-storage semantics
// live in @/utils/default-collection-auto-nav.

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
    refresh,
  } = useCollections();

  // Refresh the collection list when this screen re-gains focus.
  // Skip the INITIAL mount: useCollections already auto-fetches on mount via
  // its own useEffect. Calling refresh() again on mount would create two
  // concurrent API calls, which interferes with the FR-009 redirect timing.
  // We only want to refresh on SUBSEQUENT focus events (e.g. navigating back).
  const hasMountedRef = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (!hasMountedRef.current) {
        hasMountedRef.current = true;
        return; // Skip: useCollections already fetches on mount via its own useEffect
      }
      void refresh();
    }, [refresh]),
  );

  // ─── FR-009: auto-navigate to default collection after initial load ──────────
  // Use a ref (not state) so the flag persists across re-renders but does not
  // cause additional renders. On web, also check localStorage to prevent the
  // redirect from looping when the user navigates back to /home after the
  // initial redirect (each page.goto() remounts this component from scratch).
  const hasAutoNavCheckedRef = useRef(false);
  // isFr009Checked becomes true only AFTER the FR-009 check has completed.
  // This ensures home-screen-create-button (and all content) is NEVER visible
  // before FR-009 has had a chance to redirect — preventing a race where the
  // login helper (or E2E test) sees home-screen-create-button briefly before
  // router.replace() fires. On redirect, this component unmounts so the flag
  // never needs to be set; on no-redirect, setIsFr009Checked(true) triggers
  // one more render that reveals the full home screen UI.
  const [isFr009Checked, setIsFr009Checked] = useState(false);

  useEffect(() => {
    if (isLoading) return; // wait for the initial fetch to complete
    if (hasAutoNavCheckedRef.current) return; // already ran this effect this mount

    // FR-009 reveal/redirect is intentionally synchronous: the no-redirect
    // branches must flip isFr009Checked in the same commit that the redirect
    // branch would have called router.replace(), so the home UI appears (or the
    // redirect fires) on the same frame the initial fetch completes. Deferring
    // setIsFr009Checked to a microtask delays the UI reveal by a frame, which the
    // home-screen tests (and the FR-009 E2E timing) observe directly — so the
    // react-hooks/set-state-in-effect suggestion to defer it would change
    // behavior here. The setState is a one-shot guarded by hasAutoNavCheckedRef
    // (runs at most once per mount), so it cannot cause the cascading-render loop
    // the rule guards against. Disable the rule for these two intentional calls.

    if (isAutoNavDone()) { // already fired this session — skip redirect
      hasAutoNavCheckedRef.current = true;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot FR-009 reveal; see comment above
      setIsFr009Checked(true);
      return;
    }
    hasAutoNavCheckedRef.current = true;

    const defaultCollection = collections.find(c => c.isDefault);
    if (defaultCollection) {
      markAutoNavDone(); // prevent redirect on subsequent /home visits this session
      // replace() so home is not added to the navigation stack.
      // Do NOT call setIsFr009Checked here — the component is about to unmount.
      router.replace(
        `/collections/${defaultCollection.collectionId}` as Parameters<typeof router.replace>[0],
      );
    } else {
      // No default collection: reveal the full home UI now.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot FR-009 reveal; see comment above
      setIsFr009Checked(true);
    }
  }, [isLoading, collections, router]);

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
      {(isLoading || !isFr009Checked) ? (
        /* Loading state — also shown while FR-009 check is pending to ensure
           home-screen-create-button never appears before the auto-nav check runs.
           This prevents a race where mobile login helper (or E2E test) sees the
           create button briefly before router.replace() fires the FR-009 redirect. */
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
