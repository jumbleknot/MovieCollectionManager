/**
 * Design-system unit tests — Button states (feature 015, T022).
 * Verifies variant render, the loading + disabled guards (handler removed +
 * aria-disabled), the danger flag, and multiline label rendering. The base
 * render/forwarding smoke lives in Button.test.tsx.
 */
import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { TamaguiProvider } from '@tamagui/core';
import config from '../../tamagui.config';
import { Button, type ButtonVariant } from './Button';

function renderDS(ui: React.ReactElement) {
  return render(
    <TamaguiProvider config={config} defaultTheme="dark">
      {ui}
    </TamaguiProvider>,
  );
}

describe('Button states', () => {
  it.each<ButtonVariant>(['filled', 'filledTonal', 'elevated', 'outlined', 'text'])(
    'renders the label for the %s variant',
    (variant) => {
      const { getByText } = renderDS(<Button variant={variant} label="Save" />);
      expect(getByText('Save')).toBeTruthy();
    },
  );

  // Note: the disabled/loading press *guard* (pointerEvents:none + onPress→undefined)
  // can only be proven on web; jest-expo's fireEvent.press ignores pointerEvents and
  // the disabled state. We assert the observable a11y contract (aria-disabled) here and
  // leave the click-suppression to the web E2E suite.
  it('marks aria-disabled and still shows the label while loading', () => {
    const { getByTestId, getByText } = renderDS(
      <Button label="Save" testID="btn" loading onPress={() => {}} />,
    );
    expect(getByText('Save')).toBeTruthy();
    expect(getByTestId('btn').props['aria-disabled']).toBe(true);
  });

  it('marks aria-disabled when disabled', () => {
    const { getByTestId } = renderDS(
      <Button label="Save" testID="btn" disabled onPress={() => {}} />,
    );
    expect(getByTestId('btn').props['aria-disabled']).toBe(true);
  });

  it('fires onPress when enabled', () => {
    const onPress = jest.fn();
    const { getByTestId } = renderDS(
      <Button label="Save" testID="btn" onPress={onPress} />,
    );
    fireEvent.press(getByTestId('btn'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('renders a danger (destructive) button label', () => {
    const { getByText } = renderDS(<Button label="Delete" danger />);
    expect(getByText('Delete')).toBeTruthy();
  });

  it('renders a multiline label', () => {
    const { getByText } = renderDS(
      <Button label="A very long option label that wraps" multiline />,
    );
    expect(getByText('A very long option label that wraps')).toBeTruthy();
  });
});
