/**
 * PillButton unit test (feature 015 consolidation).
 * The sanctioned orange CTA primitive — verifies label render + testID/accessibility passthrough.
 */
import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { TamaguiProvider } from '@tamagui/core';
import config from '../../tamagui.config';
import { PillButton } from './PillButton';

async function renderDS(ui: React.ReactElement) {
  return await render(
    <TamaguiProvider config={config} defaultTheme="dark">
      {ui}
    </TamaguiProvider>,
  );
}

describe('PillButton', () => {
  it('renders its label', async () => {
    const { getByText } = await renderDS(<PillButton label="+ Add movie" onPress={() => {}} />);
    expect(getByText('+ Add movie')).toBeTruthy();
  });

  it('forwards testID + accessibilityLabel and fires onPress', async () => {
    const onPress = jest.fn();
    const { getByTestId } = await renderDS(
      <PillButton label="+ Create" testID="home-screen-create-button" accessibilityLabel="Create new collection" onPress={onPress} />,
    );
    const node = getByTestId('home-screen-create-button');
    expect(node).toBeTruthy();
    await fireEvent.press(node);
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
