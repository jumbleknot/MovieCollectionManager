/**
 * LogoutConfirmationDialog component (T-102)
 * Presents a modal confirmation before executing logout.
 * Built on the design-system `Dialog` (feature 017 — DS surface adoption).
 */

import React from 'react';
import { Button, Dialog } from '@mcm/design-system';

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
    <Dialog
      visible={visible}
      testID="logout-dialog"
      title="Logout"
      supportingText="Are you sure you want to logout?"
      onDismiss={onCancel}
      actions={[
        <Button
          key="cancel"
          variant="outlined"
          label="Cancel"
          onPress={onCancel}
          testID="btn-logout-cancel"
          accessibilityLabel="Cancel logout"
        />,
        <Button
          key="confirm"
          variant="filled"
          danger
          label="Logout"
          onPress={onConfirm}
          testID="btn-logout-confirm"
          accessibilityLabel="Confirm logout"
        />,
      ]}
    />
  );
}
