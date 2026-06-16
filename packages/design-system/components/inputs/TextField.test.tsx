/**
 * Design-system unit tests — TextField (feature 015, T022).
 * Verifies label (+ required marker), supporting/error text, the character
 * counter, onChangeText forwarding, and the disabled (non-editable) state.
 */
import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { TamaguiProvider } from '@tamagui/core';
import config from '../../tamagui.config';
import { TextField } from './TextField';

function renderDS(ui: React.ReactElement) {
  return render(
    <TamaguiProvider config={config} defaultTheme="dark">
      {ui}
    </TamaguiProvider>,
  );
}

describe('TextField', () => {
  it('renders the label', () => {
    const { getByText } = renderDS(<TextField label="Email" />);
    expect(getByText('Email')).toBeTruthy();
  });

  it('appends a required marker to the label', () => {
    const { getByText } = renderDS(<TextField label="Email" required />);
    expect(getByText('Email *')).toBeTruthy();
  });

  it('renders supporting text', () => {
    const { getByText } = renderDS(
      <TextField label="Email" supportingText="We never share it" />,
    );
    expect(getByText('We never share it')).toBeTruthy();
  });

  it('renders error text when in the error state', () => {
    const { getByText } = renderDS(
      <TextField label="Email" error errorText="Invalid address" />,
    );
    expect(getByText('Invalid address')).toBeTruthy();
  });

  it('renders the character counter from value length and maxCount', () => {
    const { getByText } = renderDS(
      <TextField label="Email" value="ab" maxCount={10} />,
    );
    expect(getByText('2/10')).toBeTruthy();
  });

  it('forwards onChangeText to the underlying input', () => {
    const onChangeText = jest.fn();
    const { getByTestId } = renderDS(
      <TextField label="Email" testID="tf-input" onChangeText={onChangeText} />,
    );
    fireEvent.changeText(getByTestId('tf-input'), 'x');
    expect(onChangeText).toHaveBeenCalledWith('x');
  });

  it('is not editable when disabled', () => {
    const { getByTestId } = renderDS(
      <TextField label="Email" testID="tf-input" disabled />,
    );
    expect(getByTestId('tf-input').props.editable).toBe(false);
  });
});
