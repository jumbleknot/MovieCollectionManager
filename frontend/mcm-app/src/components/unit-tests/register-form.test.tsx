/**
 * Unit tests for RegisterForm component (T-052)
 */

import React from 'react';
import { render, fireEvent, waitFor } from '@/test-support/render';
import { RegisterForm } from '@/components/register-form';

const validValues = {
  username: 'testuser',
  email: 'test@example.com',
  firstName: 'Test',
  lastName: 'User',
  password: 'SecurePass1!extra',
};

function fillAndSubmit(getByTestId: ReturnType<typeof render>['getByTestId'], overrides = {}) {
  const values = { ...validValues, confirmPassword: validValues.password, ...overrides };

  fireEvent.changeText(getByTestId('input-firstName'), values.firstName);
  fireEvent.changeText(getByTestId('input-lastName'), values.lastName);
  fireEvent.changeText(getByTestId('input-username'), values.username);
  fireEvent.changeText(getByTestId('input-email'), values.email);
  fireEvent.changeText(getByTestId('input-password'), values.password);
  fireEvent.changeText(getByTestId('input-confirmPassword'), (overrides as { confirmPassword?: string }).confirmPassword ?? values.password);

  fireEvent.press(getByTestId('btn-create-account'));
}

describe('RegisterForm', () => {
  it('renders all form fields', () => {
    const { getByTestId } = render(<RegisterForm onSubmit={jest.fn()} />);
    expect(getByTestId('input-firstName')).toBeTruthy();
    expect(getByTestId('input-lastName')).toBeTruthy();
    expect(getByTestId('input-username')).toBeTruthy();
    expect(getByTestId('input-email')).toBeTruthy();
    expect(getByTestId('input-password')).toBeTruthy();
    expect(getByTestId('input-confirmPassword')).toBeTruthy();
    expect(getByTestId('btn-create-account')).toBeTruthy();
  });

  it('calls onSubmit with valid values', async () => {
    const onSubmit = jest.fn().mockResolvedValue(undefined);
    const { getByTestId } = render(<RegisterForm onSubmit={onSubmit} />);

    fillAndSubmit(getByTestId);

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        username: validValues.username,
        email: validValues.email,
        firstName: validValues.firstName,
        lastName: validValues.lastName,
        password: validValues.password,
      });
    });
  });

  it('does not submit when password is weak', async () => {
    const onSubmit = jest.fn();
    const { getByTestId } = render(<RegisterForm onSubmit={onSubmit} />);

    fillAndSubmit(getByTestId, { password: 'weak', confirmPassword: 'weak' });

    await waitFor(() => {
      expect(onSubmit).not.toHaveBeenCalled();
    });
  });

  it('does not submit when passwords do not match', async () => {
    const onSubmit = jest.fn();
    const { getByTestId } = render(<RegisterForm onSubmit={onSubmit} />);

    fillAndSubmit(getByTestId, { confirmPassword: 'DifferentPass1!' });

    await waitFor(() => {
      expect(onSubmit).not.toHaveBeenCalled();
    });
  });

  it('displays error banner when error prop provided', () => {
    const { getByTestId } = render(
      <RegisterForm onSubmit={jest.fn()} error="An account with that email already exists." />,
    );
    expect(getByTestId('register-form-error')).toBeTruthy();
  });

  it('shows loading state when isLoading is true', () => {
    const { getByTestId } = render(<RegisterForm onSubmit={jest.fn()} isLoading />);
    expect(getByTestId('btn-create-account')).toBeTruthy();
  });
});
