/**
 * DeleteConfirmationDialog component (T060)
 *
 * Reusable modal dialog for destructive delete actions — collections and movies.
 * Displays an irreversible-loss warning, the entity name, and Confirm/Cancel buttons.
 */

import React from 'react';
import { Modal, View, Text, StyleSheet } from 'react-native';
import { useTheme } from '@tamagui/core';
import { Button } from '@mcm/design-system';

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
      <View style={[styles.overlay, { backgroundColor: theme.scrim?.val ? `${theme.scrim.val}88` : undefined }]}>
        <View style={[styles.dialog, { backgroundColor: theme.surface3?.val }]}>
          <Text style={[styles.title, { color: theme.onSurface?.val }]}>Delete "{entityName}"?</Text>
          <Text style={[styles.message, { color: theme.onSurfaceVariant?.val }]}>
            This action cannot be undone. "{entityName}" and all its contents will be
            permanently deleted.
          </Text>
          <View style={styles.actions}>
            <Button
              variant="outlined"
              label="Cancel"
              onPress={onCancel}
              testID="delete-dialog-cancel-button"
              accessibilityLabel="Cancel delete"
            />
            <Button
              variant="filled"
              danger
              label="Delete"
              onPress={onConfirm}
              testID="delete-dialog-confirm-button"
              accessibilityLabel="Confirm delete"
            />
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
    fontSize: 16,
    marginBottom: 24,
    lineHeight: 22,
  },
  actions: {
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'flex-end',
  },
});
