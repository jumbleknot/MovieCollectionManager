/**
 * Design-system unit tests — CollectionCard (feature 015, T011).
 * Verifies render, testID/accessibilityLabel forwarding (FR-018), the role chip,
 * the default badge, both layout variants, and the press callback.
 */
import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { TamaguiProvider } from '@tamagui/core';
import config from '../../tamagui.config';
import { CollectionCard, type Collection } from './CollectionCard';

function renderDS(ui: React.ReactElement) {
  return render(
    <TamaguiProvider config={config} defaultTheme="dark">
      {ui}
    </TamaguiProvider>,
  );
}

const base: Collection = { id: 'c1', name: 'Alpha', movieCount: 3 };

describe('CollectionCard', () => {
  it('renders the name and pluralised movie count (grid variant)', () => {
    const { getByText } = renderDS(<CollectionCard collection={base} />);
    expect(getByText('Alpha')).toBeTruthy();
    expect(getByText('3 movies')).toBeTruthy();
  });

  it('uses the singular "movie" when the count is 1', () => {
    const { getByText } = renderDS(
      <CollectionCard collection={{ ...base, movieCount: 1 }} />,
    );
    expect(getByText('1 movie')).toBeTruthy();
  });

  it('forwards testID + accessibilityLabel to the pressable root and fires onPress', () => {
    const onPress = jest.fn();
    const { getByTestId, getByLabelText } = renderDS(
      <CollectionCard
        collection={base}
        testID="collection-card"
        accessibilityLabel="Open Alpha"
        onPress={onPress}
      />,
    );
    expect(getByLabelText('Open Alpha')).toBeTruthy();
    fireEvent.press(getByTestId('collection-card'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('shows the Default marker and the role chip when provided', () => {
    const { getByText } = renderDS(
      <CollectionCard collection={{ ...base, isDefault: true, role: 'contributor' }} />,
    );
    expect(getByText(/Default/)).toBeTruthy();
    expect(getByText('Contributor')).toBeTruthy();
  });

  it('renders the row variant', () => {
    const { getByText } = renderDS(
      <CollectionCard collection={base} variant="row" />,
    );
    expect(getByText('Alpha')).toBeTruthy();
    expect(getByText(/3 movies/)).toBeTruthy();
  });
});
