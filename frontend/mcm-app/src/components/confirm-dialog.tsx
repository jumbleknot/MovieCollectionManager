/**
 * ConfirmDialog (feature 017 — code-review finding #8)
 *
 * Shared scaffold for the two-button "are you sure?" confirmation pattern: an outlined Cancel and a
 * filled-danger confirm on the design-system `Dialog`. Extracted because the delete- and logout-
 * confirmation dialogs were byte-for-byte-identical apart from their strings/testIDs, so any future
 * convention change (button order, a11y scheme, scrim behaviour) only has to land here once.
 *
 * testIDs and accessibilityLabels are passed in explicitly so each caller keeps its exact existing
 * E2E selectors (they don't share a single prefix scheme).
 */

import React from 'react';
import { Button, Dialog } from '@mcm/design-system';

export interface ConfirmDialogProps {
  visible: boolean;
  title: string;
  supportingText?: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  dialogTestID: string;
  cancelTestID: string;
  confirmTestID: string;
  cancelAccessibilityLabel: string;
  confirmAccessibilityLabel: string;
}

export function ConfirmDialog({
  visible,
  title,
  supportingText,
  confirmLabel,
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  dialogTestID,
  cancelTestID,
  confirmTestID,
  cancelAccessibilityLabel,
  confirmAccessibilityLabel,
}: ConfirmDialogProps): React.JSX.Element {
  return (
    <Dialog
      visible={visible}
      testID={dialogTestID}
      title={title}
      supportingText={supportingText}
      onDismiss={onCancel}
      actions={[
        <Button
          key="cancel"
          variant="outlined"
          label={cancelLabel}
          onPress={onCancel}
          testID={cancelTestID}
          accessibilityLabel={cancelAccessibilityLabel}
        />,
        <Button
          key="confirm"
          variant="filled"
          danger
          label={confirmLabel}
          onPress={onConfirm}
          testID={confirmTestID}
          accessibilityLabel={confirmAccessibilityLabel}
        />,
      ]}
    />
  );
}
