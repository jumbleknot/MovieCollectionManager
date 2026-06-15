/**
 * Unit tests for MovieCountLine (013 T020) — US2-AC1 / US2-AC2 / US2-AC5.
 *
 * Renders the collection's movie count info line:
 *   - unfiltered → "<total> movies"
 *   - filtered   → "<filtered> of <total> movies"
 */
import React from 'react';
import { render, screen } from '@/test-support/render';
import { MovieCountLine } from '@/components/movie-count-line';

describe('MovieCountLine', () => {
  it('renders the total when not filtered (US2-AC1)', () => {
    render(<MovieCountLine count={{ filtered: 10, total: 10, isFiltered: false }} />);
    expect(screen.getByTestId('movie-count-line')).toBeTruthy();
    expect(screen.getByText('10 movies')).toBeTruthy();
  });

  it('renders filtered/total when a filter is active (US2-AC2/US2-AC5)', () => {
    render(<MovieCountLine count={{ filtered: 3, total: 10, isFiltered: true }} />);
    expect(screen.getByText('3 of 10 movies')).toBeTruthy();
  });

  it('uses the singular noun for a count of one', () => {
    render(<MovieCountLine count={{ filtered: 1, total: 1, isFiltered: false }} />);
    expect(screen.getByText('1 movie')).toBeTruthy();
  });
});
