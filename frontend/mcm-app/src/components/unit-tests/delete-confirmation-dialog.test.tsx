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

async function renderDialog(overrides: { visible?: boolean; entityName?: string } = {}) {
  const onConfirm = jest.fn();
  const onCancel = jest.fn();

  const utils = await render(
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
  it('renders the entity name in the warning message', async () => {
    const { getAllByText } = await renderDialog({ entityName: 'Action Movies' });
    // Entity name appears in both the title and the body — at least one occurrence required
    expect(getAllByText(/Action Movies/).length).toBeGreaterThan(0);
  });

  it('renders an irreversible-loss warning', async () => {
    const { getByText } = await renderDialog();
    expect(getByText(/cannot be undone|permanently|irreversible/i)).toBeTruthy();
  });

  it('calls onConfirm when confirm button is pressed', async () => {
    const { getByTestId, onConfirm } = await renderDialog();
    await fireEvent.press(getByTestId('delete-dialog-confirm-button'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when cancel button is pressed', async () => {
    const { getByTestId, onCancel } = await renderDialog();
    await fireEvent.press(getByTestId('delete-dialog-cancel-button'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('does not render content when visible is false', async () => {
    const { queryByTestId } = await renderDialog({ visible: false });
    expect(queryByTestId('delete-dialog-confirm-button')).toBeNull();
  });
});
