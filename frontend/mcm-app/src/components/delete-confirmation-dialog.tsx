/**
 * DeleteConfirmationDialog component (T060)
 *
 * Reusable modal dialog for destructive delete actions — collections and movies.
 * Displays an irreversible-loss warning, the entity name, and Confirm/Cancel buttons.
 * Built on the design-system `Dialog` (feature 017 — DS surface adoption).
 */

import React from 'react';
import { Button, Dialog } from '@mcm/design-system';

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
    <Dialog
      visible={visible}
      testID="delete-dialog"
      title={`Delete "${entityName}"?`}
      supportingText={`This action cannot be undone. "${entityName}" and all its contents will be permanently deleted.`}
      onDismiss={onCancel}
      actions={[
        <Button
          key="cancel"
          variant="outlined"
          label="Cancel"
          onPress={onCancel}
          testID="delete-dialog-cancel-button"
          accessibilityLabel="Cancel delete"
        />,
        <Button
          key="confirm"
          variant="filled"
          danger
          label="Delete"
          onPress={onConfirm}
          testID="delete-dialog-confirm-button"
          accessibilityLabel="Confirm delete"
        />,
      ]}
    />
  );
}
