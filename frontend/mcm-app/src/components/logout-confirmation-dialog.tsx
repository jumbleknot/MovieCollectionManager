/**
 * LogoutConfirmationDialog component (T-102)
 * Presents a modal confirmation before executing logout.
 */

import React from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useTheme } from '@tamagui/core';

interface LogoutConfirmationDialogProps {
  visible: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function LogoutConfirmationDialog({
  visible,
  onConfirm,
  onCancel,
}: LogoutConfirmationDialogProps): React.JSX.Element {
  const theme = useTheme();

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
      testID="logout-dialog"
    >
      <View style={[styles.overlay, { backgroundColor: theme.scrim?.val ? `${theme.scrim.val}88` : 'rgba(0,0,0,0.5)' }]}>
        <View style={[styles.dialog, { backgroundColor: theme.surface3?.val }]}>
          <Text style={[styles.title, { color: theme.onSurface?.val }]}>Logout</Text>
          <Text style={[styles.message, { color: theme.onSurfaceVariant?.val }]}>Are you sure you want to logout?</Text>
          <View style={styles.actions}>
            <TouchableOpacity
              style={[styles.cancelButton, { borderColor: theme.outline?.val }]}
              onPress={onCancel}
              testID="btn-logout-cancel"
              accessibilityRole="button"
              accessibilityLabel="Cancel logout"
            >
              <Text style={[styles.cancelText, { color: theme.onSurface?.val }]}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.confirmButton, { backgroundColor: theme.error?.val }]}
              onPress={onConfirm}
              testID="btn-logout-confirm"
              accessibilityRole="button"
              accessibilityLabel="Confirm logout"
            >
              <Text style={[styles.confirmText, { color: theme.onError?.val }]}>Logout</Text>
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
    maxWidth: 380,
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
