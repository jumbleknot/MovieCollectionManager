/**
 * Design-system harness smoke test (feature 015, T009).
 * Proves the Tamagui config + a styled DS component render under jest-expo.
 */
import React from 'react';
import { render } from '@testing-library/react-native';
import { TamaguiProvider } from '@tamagui/core';
import config from '../../tamagui.config';
import { Button } from './Button';

async function renderDS(ui: React.ReactElement) {
  return await render(
    <TamaguiProvider config={config} defaultTheme="dark">
      {ui}
    </TamaguiProvider>,
  );
}

describe('design-system harness', () => {
  it('renders a Button label inside the Tamagui provider', async () => {
    const { getByText } = await renderDS(<Button label="Add movie" onPress={() => {}} />);
    expect(getByText('Add movie')).toBeTruthy();
  });

  it('forwards testID and accessibilityLabel to the underlying node', async () => {
    const { getByTestId } = await renderDS(
      <Button label="Add" testID="add-movie" accessibilityLabel="Add movie" onPress={() => {}} />,
    );
    expect(getByTestId('add-movie')).toBeTruthy();
  });
});
