/**
 * DeleteConfirmationDialog component (T060)
 *
 * Reusable modal dialog for destructive delete actions — collections and movies.
 * Displays an irreversible-loss warning, the entity name, and Confirm/Cancel buttons.
 * Built on the design-system `Dialog` (feature 017 — DS surface adoption).
 */

import React from 'react';
import { ConfirmDialog } from './confirm-dialog';

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
  return (
    <ConfirmDialog
      visible={visible}
      dialogTestID="delete-dialog"
      title={`Delete "${entityName}"?`}
      supportingText={`This action cannot be undone. "${entityName}" and all its contents will be permanently deleted.`}
      confirmLabel="Delete"
      onConfirm={onConfirm}
      onCancel={onCancel}
      cancelTestID="delete-dialog-cancel-button"
      confirmTestID="delete-dialog-confirm-button"
      cancelAccessibilityLabel="Cancel delete"
      confirmAccessibilityLabel="Confirm delete"
    />
  );
}
