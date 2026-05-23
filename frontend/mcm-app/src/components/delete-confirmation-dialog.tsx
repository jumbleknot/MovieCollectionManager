/**
 * DeleteConfirmationDialog component (T060)
 *
 * Reusable modal dialog for destructive delete actions — collections and movies.
 * Displays an irreversible-loss warning, the entity name, and Confirm/Cancel buttons.
 */

import React from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet } from 'react-native';

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
      <View style={styles.overlay}>
        <View style={styles.dialog}>
          <Text style={styles.title}>Delete "{entityName}"?</Text>
          <Text style={styles.message}>
            This action cannot be undone. "{entityName}" and all its contents will be
            permanently deleted.
          </Text>
          <View style={styles.actions}>
            <TouchableOpacity
              style={styles.cancelButton}
              onPress={onCancel}
              testID="delete-dialog-cancel-button"
              accessibilityRole="button"
              accessibilityLabel="Cancel delete"
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.confirmButton}
              onPress={onConfirm}
              testID="delete-dialog-confirm-button"
              accessibilityRole="button"
              accessibilityLabel="Confirm delete"
            >
              <Text style={styles.confirmText}>Delete</Text>
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
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  dialog: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 24,
    width: '100%',
    maxWidth: 400,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1a202c',
    marginBottom: 8,
  },
  message: {
    fontSize: 15,
    color: '#4a5568',
    marginBottom: 24,
    lineHeight: 22,
  },
  actions: {
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'flex-end',
  },
  cancelButton: {
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#cbd5e0',
  },
  cancelText: {
    color: '#2d3748',
    fontSize: 15,
    fontWeight: '600',
  },
  confirmButton: {
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 8,
    backgroundColor: '#e53e3e',
  },
  confirmText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
});
