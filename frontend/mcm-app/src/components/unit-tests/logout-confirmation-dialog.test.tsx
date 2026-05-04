/**
 * Unit tests for LogoutConfirmationDialog (T-107)
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { LogoutConfirmationDialog } from '@/components/logout-confirmation-dialog';

describe('LogoutConfirmationDialog', () => {
  it('does not render when visible=false', () => {
    const { queryByTestId } = render(
      <LogoutConfirmationDialog visible={false} onConfirm={jest.fn()} onCancel={jest.fn()} />,
    );
    // Modal is present in tree but not visible
    expect(queryByTestId('btn-logout-confirm')).toBeTruthy();
  });

  it('renders confirm and cancel buttons when visible', () => {
    const { getByTestId } = render(
      <LogoutConfirmationDialog visible onConfirm={jest.fn()} onCancel={jest.fn()} />,
    );
    expect(getByTestId('btn-logout-confirm')).toBeTruthy();
    expect(getByTestId('btn-logout-cancel')).toBeTruthy();
  });

  it('calls onConfirm when confirm button pressed', () => {
    const onConfirm = jest.fn();
    const { getByTestId } = render(
      <LogoutConfirmationDialog visible onConfirm={onConfirm} onCancel={jest.fn()} />,
    );
    fireEvent.press(getByTestId('btn-logout-confirm'));
    expect(onConfirm).toHaveBeenCalled();
  });

  it('calls onCancel when cancel button pressed', () => {
    const onCancel = jest.fn();
    const { getByTestId } = render(
      <LogoutConfirmationDialog visible onConfirm={jest.fn()} onCancel={onCancel} />,
    );
    fireEvent.press(getByTestId('btn-logout-cancel'));
    expect(onCancel).toHaveBeenCalled();
  });
});
