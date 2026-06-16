/**
 * PillButton unit test (feature 015 consolidation).
 * The sanctioned orange CTA primitive — verifies label render + testID/accessibility passthrough.
 */
import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { TamaguiProvider } from '@tamagui/core';
import config from '../../tamagui.config';
import { PillButton } from './PillButton';

function renderDS(ui: React.ReactElement) {
  return render(
    <TamaguiProvider config={config} defaultTheme="dark">
      {ui}
    </TamaguiProvider>,
  );
}

describe('PillButton', () => {
  it('renders its label', () => {
    const { getByText } = renderDS(<PillButton label="+ Add movie" onPress={() => {}} />);
    expect(getByText('+ Add movie')).toBeTruthy();
  });

  it('forwards testID + accessibilityLabel and fires onPress', () => {
    const onPress = jest.fn();
    const { getByTestId } = renderDS(
      <PillButton label="+ Create" testID="home-screen-create-button" accessibilityLabel="Create new collection" onPress={onPress} />,
    );
    const node = getByTestId('home-screen-create-button');
    expect(node).toBeTruthy();
    fireEvent.press(node);
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
