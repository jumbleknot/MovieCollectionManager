/**
 * DeleteConfirmationDialog component (T060)
 *
 * Reusable modal dialog for destructive delete actions — collections and movies.
 * Displays an irreversible-loss warning, the entity name, and Confirm/Cancel buttons.
 */

import React from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useTheme } from '@tamagui/core';

interface DeleteConfirmationDialogProps {
  visible: boolean;
  /** The name of the item being deleted, shown in the warning. */
  entityName: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DeleteConfirmationDialog({
  visible,
  entityName,
  onConfirm,
  onCancel,
}: DeleteConfirmationDialogProps): React.JSX.Element {
  const theme = useTheme();

  if (!visible) {
    return <></>;
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
      testID="delete-dialog"
    >
      <View style={[styles.overlay, { backgroundColor: theme.scrim?.val ? `${theme.scrim.val}88` : 'rgba(0,0,0,0.5)' }]}>
        <View style={[styles.dialog, { backgroundColor: theme.surface3?.val }]}>
          <Text style={[styles.title, { color: theme.onSurface?.val }]}>Delete "{entityName}"?</Text>
          <Text style={[styles.message, { color: theme.onSurfaceVariant?.val }]}>
            This action cannot be undone. "{entityName}" and all its contents will be
            permanently deleted.
          </Text>
          <View style={styles.actions}>
            <TouchableOpacity
              style={[styles.cancelButton, { borderColor: theme.outline?.val }]}
              onPress={onCancel}
              testID="delete-dialog-cancel-button"
              accessibilityRole="button"
              accessibilityLabel="Cancel delete"
            >
              <Text style={[styles.cancelText, { color: theme.onSurface?.val }]}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.confirmButton, { backgroundColor: theme.error?.val }]}
              onPress={onConfirm}
              testID="delete-dialog-confirm-button"
              accessibilityRole="button"
              accessibilityLabel="Confirm delete"
            >
              <Text style={[styles.confirmText, { color: theme.onError?.val }]}>Delete</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  dialog: {
    borderRadius: 28,
    padding: 24,
    width: '100%',
    maxWidth: 400,
  },
  title: {
    fontFamily: 'Outfit',
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 8,
  },
  message: {
    fontFamily: 'Inter',
    fontSize: 15,
    marginBottom: 24,
    lineHeight: 22,
  },
  actions: {
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'flex-end',
  },
  cancelButton: {
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 24,
    borderWidth: 1,
    justifyContent: 'center',
  },
  cancelText: {
    fontFamily: 'Inter',
    fontSize: 15,
    fontWeight: '600',
  },
  confirmButton: {
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 24,
    justifyContent: 'center',
  },
  confirmText: {
    fontFamily: 'Inter',
    fontSize: 15,
    fontWeight: '700',
  },
});
