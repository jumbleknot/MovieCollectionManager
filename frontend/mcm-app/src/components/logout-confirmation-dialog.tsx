/**
 * LogoutConfirmationDialog component (T-102)
 * Presents a modal confirmation before executing logout.
 * Built on the design-system `Dialog` (feature 017 — DS surface adoption).
 */

import React from 'react';
import { ConfirmDialog } from './confirm-dialog';

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
    <ConfirmDialog
      visible={visible}
      dialogTestID="logout-dialog"
      title="Logout"
      supportingText="Are you sure you want to logout?"
      confirmLabel="Logout"
      onConfirm={onConfirm}
      onCancel={onCancel}
      cancelTestID="btn-logout-cancel"
      confirmTestID="btn-logout-confirm"
      cancelAccessibilityLabel="Cancel logout"
      confirmAccessibilityLabel="Confirm logout"
    />
  );
}
