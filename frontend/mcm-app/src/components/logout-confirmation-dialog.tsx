/**
 * LogoutConfirmationDialog component (T-102)
 * Presents a modal confirmation before executing logout.
 */

import React from 'react';
import { Modal, View, Text, StyleSheet } from 'react-native';
import { useTheme } from '@tamagui/core';
import { Button } from '@mcm/design-system';

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
      <View style={[styles.overlay, { backgroundColor: theme.scrim?.val ? `${theme.scrim.val}88` : undefined }]}>
        <View style={[styles.dialog, { backgroundColor: theme.surface3?.val }]}>
          <Text style={[styles.title, { color: theme.onSurface?.val }]}>Logout</Text>
          <Text style={[styles.message, { color: theme.onSurfaceVariant?.val }]}>Are you sure you want to logout?</Text>
          <View style={styles.actions}>
            <Button
              variant="outlined"
              label="Cancel"
              onPress={onCancel}
              testID="btn-logout-cancel"
              accessibilityLabel="Cancel logout"
            />
            <Button
              variant="filled"
              danger
              label="Logout"
              onPress={onConfirm}
              testID="btn-logout-confirm"
              accessibilityLabel="Confirm logout"
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
    fontSize: 16,
    marginBottom: 24,
  },
  actions: {
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'flex-end',
  },
});
