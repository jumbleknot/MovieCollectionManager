/**
 * Unit tests for the shared ConfirmDialog scaffold (feature 017 — code-review finding #8).
 * Verifies the explicit testID/label passthrough and the confirm/cancel callbacks, so the
 * delete- and logout-confirmation wrappers keep their exact selectors after the dedup.
 */

import React from 'react';
import { render, fireEvent } from '@/test-support/render';
import { ConfirmDialog } from '@/components/confirm-dialog';

function renderConfirm(overrides: { visible?: boolean } = {}) {
  const onConfirm = jest.fn();
  const onCancel = jest.fn();
  const utils = render(
    <ConfirmDialog
      visible={overrides.visible ?? true}
      title="Remove item?"
      supportingText="This cannot be undone."
      confirmLabel="Remove"
      onConfirm={onConfirm}
      onCancel={onCancel}
      dialogTestID="confirm-x"
      cancelTestID="confirm-x-cancel"
      confirmTestID="confirm-x-confirm"
      cancelAccessibilityLabel="Cancel remove"
      confirmAccessibilityLabel="Confirm remove"
    />,
  );
  return { ...utils, onConfirm, onCancel };
}

describe('ConfirmDialog', () => {
  it('renders the title and supporting text', () => {
    const { getByText } = renderConfirm();
    expect(getByText('Remove item?')).toBeTruthy();
    expect(getByText('This cannot be undone.')).toBeTruthy();
  });

  it('forwards the confirm/cancel testIDs and fires the callbacks', () => {
    const { getByTestId, onConfirm, onCancel } = renderConfirm();
    fireEvent.press(getByTestId('confirm-x-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.press(getByTestId('confirm-x-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when not visible', () => {
    const { queryByTestId } = renderConfirm({ visible: false });
    expect(queryByTestId('confirm-x-confirm')).toBeNull();
  });
});
