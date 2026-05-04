/**
 * LogoutConfirmationDialog component (T-102)
 * Presents a modal confirmation before executing logout.
 */

import React from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet } from 'react-native';

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
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
      testID="logout-dialog"
    >
      <View style={styles.overlay}>
        <View style={styles.dialog}>
          <Text style={styles.title}>Logout</Text>
          <Text style={styles.message}>Are you sure you want to logout?</Text>
          <View style={styles.actions}>
            <TouchableOpacity
              style={styles.cancelButton}
              onPress={onCancel}
              testID="btn-logout-cancel"
              accessibilityRole="button"
              accessibilityLabel="Cancel logout"
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.confirmButton}
              onPress={onConfirm}
              testID="btn-logout-confirm"
              accessibilityRole="button"
              accessibilityLabel="Confirm logout"
            >
              <Text style={styles.confirmText}>Logout</Text>
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
    maxWidth: 380,
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
