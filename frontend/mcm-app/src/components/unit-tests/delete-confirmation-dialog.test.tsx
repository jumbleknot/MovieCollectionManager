/**
 * Unit tests for DeleteConfirmationDialog component (T059)
 *
 * Tests cover:
 * - Renders warning message containing entity name
 * - Confirm button calls onConfirm
 * - Cancel button calls onCancel
 * - Dialog is visible when visible=true, hidden when visible=false
 */

import React from 'react';
import { render, fireEvent } from '@/test-support/render';
import { DeleteConfirmationDialog } from '@/components/delete-confirmation-dialog';

function renderDialog(overrides: { visible?: boolean; entityName?: string } = {}) {
  const onConfirm = jest.fn();
  const onCancel = jest.fn();

  const utils = render(
    <DeleteConfirmationDialog
      visible={overrides.visible ?? true}
      entityName={overrides.entityName ?? 'My Collection'}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
  return { ...utils, onConfirm, onCancel };
}

describe('DeleteConfirmationDialog', () => {
  it('renders the entity name in the warning message', () => {
    const { getAllByText } = renderDialog({ entityName: 'Action Movies' });
    // Entity name appears in both the title and the body — at least one occurrence required
    expect(getAllByText(/Action Movies/).length).toBeGreaterThan(0);
  });

  it('renders an irreversible-loss warning', () => {
    const { getByText } = renderDialog();
    expect(getByText(/cannot be undone|permanently|irreversible/i)).toBeTruthy();
  });

  it('calls onConfirm when confirm button is pressed', () => {
    const { getByTestId, onConfirm } = renderDialog();
    fireEvent.press(getByTestId('delete-dialog-confirm-button'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when cancel button is pressed', () => {
    const { getByTestId, onCancel } = renderDialog();
    fireEvent.press(getByTestId('delete-dialog-cancel-button'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('does not render content when visible is false', () => {
    const { queryByTestId } = renderDialog({ visible: false });
    expect(queryByTestId('delete-dialog-confirm-button')).toBeNull();
  });
});
