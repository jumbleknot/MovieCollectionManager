/**
 * Design-system harness smoke test (feature 015, T009).
 * Proves the Tamagui v1 config + a styled DS component render under jest-expo.
 */
import React from 'react';
import { render } from '@testing-library/react-native';
import { TamaguiProvider } from 'tamagui';
import config from '../../tamagui.config';
import { Button } from './Button';

function renderDS(ui: React.ReactElement) {
  return render(
    <TamaguiProvider config={config} defaultTheme="dark">
      {ui}
    </TamaguiProvider>,
  );
}

describe('design-system harness', () => {
  it('renders a Button label inside the Tamagui provider', () => {
    const { getByText } = renderDS(<Button label="Add movie" onPress={() => {}} />);
    expect(getByText('Add movie')).toBeTruthy();
  });
});
