/**
 * Design-system unit tests — MovieCard + StarRating + FormatBadge (feature 015, T012).
 * Verifies title/year render, the star rating, format badges, testID forwarding,
 * the poster vs compact layouts, and the wishlist-toggle callback isolation.
 */
import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { TamaguiProvider } from '@tamagui/core';
import config from '../../tamagui.config';
import { MovieCard, StarRating, FormatBadge, type Movie } from './MovieCard';

function renderDS(ui: React.ReactElement) {
  return render(
    <TamaguiProvider config={config} defaultTheme="dark">
      {ui}
    </TamaguiProvider>,
  );
}

const base: Movie = { id: 'm1', title: 'Blade Runner', year: 1982 };

describe('MovieCard (poster layout)', () => {
  it('renders title and year', () => {
    const { getByText } = renderDS(<MovieCard movie={base} />);
    expect(getByText('Blade Runner')).toBeTruthy();
    expect(getByText(/1982/)).toBeTruthy();
  });

  it('renders format badges with short labels', () => {
    const { getByText } = renderDS(
      <MovieCard movie={{ ...base, formats: ['4K UHD', 'Blu-ray'] }} />,
    );
    expect(getByText('4K')).toBeTruthy();
    expect(getByText('BD')).toBeTruthy();
  });

  it('forwards testID to the pressable root and fires onPress', () => {
    const onPress = jest.fn();
    const { getByTestId } = renderDS(
      <MovieCard movie={base} testID="movie-card" onPress={onPress} />,
    );
    fireEvent.press(getByTestId('movie-card'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('defaults the accessibility label to the movie title', () => {
    const { getByLabelText } = renderDS(<MovieCard movie={base} testID="movie-card" />);
    expect(getByLabelText('Blade Runner')).toBeTruthy();
  });
});

describe('MovieCard (compact layout)', () => {
  it('renders the title and fires the wishlist toggle without firing onPress', () => {
    const onPress = jest.fn();
    const onWishlistToggle = jest.fn();
    const { getByText } = renderDS(
      <MovieCard
        movie={base}
        layout="compact"
        onPress={onPress}
        onWishlistToggle={onWishlistToggle}
      />,
    );
    expect(getByText('Blade Runner')).toBeTruthy();
    // Not in wishlist → outline heart ♡
    fireEvent.press(getByText('♡'));
    expect(onWishlistToggle).toHaveBeenCalledTimes(1);
    expect(onPress).not.toHaveBeenCalled();
  });
});

describe('StarRating', () => {
  it('renders 4 full stars for a rating of 8/10', () => {
    const { getAllByText } = renderDS(<StarRating rating={8} />);
    expect(getAllByText('★')).toHaveLength(4);
  });

  it('renders a half star for a rating of 7/10', () => {
    const { getAllByText, getByText } = renderDS(<StarRating rating={7} />);
    expect(getAllByText('★')).toHaveLength(3);
    expect(getByText('⯨')).toBeTruthy();
  });
});

describe('FormatBadge', () => {
  it('maps a media format to its short label', () => {
    const { getByText } = renderDS(<FormatBadge format="Digital" />);
    expect(getByText('DIG')).toBeTruthy();
  });
});
