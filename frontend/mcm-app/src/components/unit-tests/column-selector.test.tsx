/**
 * Unit tests for ColumnSelector component (T128)
 *
 * Tests cover:
 * - Renders all column options (one toggle per ColumnKey)
 * - Checked state reflects visibleColumns prop
 * - Pressing a column toggle calls onToggle with the correct column key
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { ColumnSelector } from '@/components/column-selector';
import type { ColumnKey, ColumnVisibility } from '@/types/collection';

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const ALL_HIDDEN: ColumnVisibility = {
  year: false,
  contentType: false,
  language: false,
  owned: false,
  ripped: false,
  childrens: false,
  genres: false,
  rated: false,
  ownedMedia: false,
  ripQuality: false,
  runtime: false,
  directors: false,
  actors: false,
};

const SOME_VISIBLE: ColumnVisibility = {
  ...ALL_HIDDEN,
  year: true,
  contentType: true,
  owned: true,
  ripped: true,
};

const TOGGLEABLE_COLUMN_KEYS: ColumnKey[] = [
  'language', 'owned', 'ripped', 'childrens',
  'genres', 'rated', 'ownedMedia', 'ripQuality', 'runtime', 'directors', 'actors',
];

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('ColumnSelector', () => {
  it('renders a toggle for each toggleable column key (TR37)', () => {
    const { getByTestId } = render(
      <ColumnSelector visibleColumns={ALL_HIDDEN} onToggle={() => {}} />,
    );
    for (const key of TOGGLEABLE_COLUMN_KEYS) {
      expect(getByTestId(`column-toggle-${key}`)).toBeTruthy();
    }
  });

  it('does NOT render a toggle for year — year is always visible (FR-019b / TR37)', () => {
    const { queryByTestId } = render(
      <ColumnSelector visibleColumns={ALL_HIDDEN} onToggle={() => {}} />,
    );
    expect(queryByTestId('column-toggle-year')).toBeNull();
  });

  it('does NOT render a toggle for contentType — contentType is always visible (FR-019b / TR37)', () => {
    const { queryByTestId } = render(
      <ColumnSelector visibleColumns={ALL_HIDDEN} onToggle={() => {}} />,
    );
    expect(queryByTestId('column-toggle-contentType')).toBeNull();
  });

  it('shows correct checked state for visible columns', () => {
    const { getByTestId } = render(
      <ColumnSelector visibleColumns={SOME_VISIBLE} onToggle={() => {}} />,
    );
    // owned is visible in SOME_VISIBLE → checked (year/contentType no longer toggleable)
    const ownedToggle = getByTestId('column-toggle-owned');
    expect(ownedToggle.props.accessibilityState?.checked ?? ownedToggle.props.value).toBeTruthy();
  });

  it('shows correct unchecked state for hidden columns', () => {
    const { getByTestId } = render(
      <ColumnSelector visibleColumns={SOME_VISIBLE} onToggle={() => {}} />,
    );
    // language is hidden → unchecked
    const langToggle = getByTestId('column-toggle-language');
    const checked = langToggle.props.accessibilityState?.checked ?? langToggle.props.value;
    expect(checked).toBeFalsy();
  });

  it('calls onToggle with the correct key when a toggle is pressed', () => {
    const onToggle = jest.fn();
    const { getByTestId } = render(
      <ColumnSelector visibleColumns={ALL_HIDDEN} onToggle={onToggle} />,
    );
    fireEvent.press(getByTestId('column-toggle-runtime'));
    expect(onToggle).toHaveBeenCalledWith('runtime');
  });

  it('calls onToggle with correct key for each column', () => {
    const onToggle = jest.fn();
    const { getByTestId } = render(
      <ColumnSelector visibleColumns={ALL_HIDDEN} onToggle={onToggle} />,
    );
    fireEvent.press(getByTestId('column-toggle-genres'));
    expect(onToggle).toHaveBeenCalledWith('genres');
  });
});
