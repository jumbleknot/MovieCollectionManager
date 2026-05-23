/**
 * Unit tests for MovieSearchBar component (T130)
 *
 * Tests cover:
 * - Renders a text input with testID 'movie-search-input'
 * - Typing calls onSearch with the entered value
 * - Clearing the input calls onSearch with empty string
 * - Value prop reflects current search term
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { MovieSearchBar } from '@/components/movie-search-bar';

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('MovieSearchBar', () => {
  it('renders a text input with testID movie-search-input', () => {
    const { getByTestId } = render(
      <MovieSearchBar value="" onSearch={() => {}} />,
    );
    expect(getByTestId('movie-search-input')).toBeTruthy();
  });

  it('displays the current value in the input', () => {
    const { getByTestId } = render(
      <MovieSearchBar value="batman" onSearch={() => {}} />,
    );
    const input = getByTestId('movie-search-input');
    expect(input.props.value).toBe('batman');
  });

  it('calls onSearch with the new value when text changes', () => {
    const onSearch = jest.fn();
    const { getByTestId } = render(
      <MovieSearchBar value="" onSearch={onSearch} />,
    );
    fireEvent.changeText(getByTestId('movie-search-input'), 'batman');
    expect(onSearch).toHaveBeenCalledWith('batman');
  });

  it('calls onSearch with empty string when input is cleared', () => {
    const onSearch = jest.fn();
    const { getByTestId } = render(
      <MovieSearchBar value="batman" onSearch={onSearch} />,
    );
    fireEvent.changeText(getByTestId('movie-search-input'), '');
    expect(onSearch).toHaveBeenCalledWith('');
  });

  it('renders a clear button when value is non-empty', () => {
    const { getByTestId } = render(
      <MovieSearchBar value="batman" onSearch={() => {}} />,
    );
    expect(getByTestId('movie-search-clear')).toBeTruthy();
  });

  it('does not render a clear button when value is empty', () => {
    const { queryByTestId } = render(
      <MovieSearchBar value="" onSearch={() => {}} />,
    );
    expect(queryByTestId('movie-search-clear')).toBeNull();
  });

  it('pressing clear button calls onSearch with empty string', () => {
    const onSearch = jest.fn();
    const { getByTestId } = render(
      <MovieSearchBar value="batman" onSearch={onSearch} />,
    );
    fireEvent.press(getByTestId('movie-search-clear'));
    expect(onSearch).toHaveBeenCalledWith('');
  });
});
