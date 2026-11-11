/**
 * Unit tests for ColumnSelector component (T128)
 *
 * Tests cover:
 * - Renders all column options (one toggle per ColumnKey)
 * - Checked state reflects visibleColumns prop
 * - Pressing a column toggle calls onToggle with the correct column key
 */

import React from 'react';
import { render, fireEvent, isHiddenFromAccessibility } from '@/test-support/render';
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
  'language',
  'owned',
  'ripped',
  'childrens',
  'genres',
  'rated',
  'ownedMedia',
  'ripQuality',
  'runtime',
  'directors',
  'actors',
];

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('ColumnSelector', () => {
  it('renders a toggle for each toggleable column key (TR37)', async () => {
    const { getByTestId } = await render(
      <ColumnSelector visibleColumns={ALL_HIDDEN} onToggle={() => {}} />,
    );
    for (const key of TOGGLEABLE_COLUMN_KEYS) {
      expect(getByTestId(`column-toggle-${key}`)).toBeTruthy();
    }
  });

  it('does NOT render a toggle for year — year is always visible (FR-019b / TR37)', async () => {
    const { queryByTestId } = await render(
      <ColumnSelector visibleColumns={ALL_HIDDEN} onToggle={() => {}} />,
    );
    expect(queryByTestId('column-toggle-year')).toBeNull();
  });

  it('does NOT render a toggle for contentType — contentType is always visible (FR-019b / TR37)', async () => {
    const { queryByTestId } = await render(
      <ColumnSelector visibleColumns={ALL_HIDDEN} onToggle={() => {}} />,
    );
    expect(queryByTestId('column-toggle-contentType')).toBeNull();
  });

  it('shows correct checked state for visible columns', async () => {
    const { getByTestId } = await render(
      <ColumnSelector visibleColumns={SOME_VISIBLE} onToggle={() => {}} />,
    );
    // owned is visible in SOME_VISIBLE → checked (year/contentType no longer toggleable)
    const ownedToggle = getByTestId('column-toggle-owned');
    expect(ownedToggle.props.accessibilityState?.checked ?? ownedToggle.props.value).toBeTruthy();
  });

  it('shows correct unchecked state for hidden columns', async () => {
    const { getByTestId } = await render(
      <ColumnSelector visibleColumns={SOME_VISIBLE} onToggle={() => {}} />,
    );
    // language is hidden → unchecked
    const langToggle = getByTestId('column-toggle-language');
    const checked = langToggle.props.accessibilityState?.checked ?? langToggle.props.value;
    expect(checked).toBeFalsy();
  });

  it('calls onToggle with the correct key when a toggle is pressed', async () => {
    const onToggle = jest.fn();
    const { getByTestId } = await render(
      <ColumnSelector visibleColumns={ALL_HIDDEN} onToggle={onToggle} />,
    );
    await fireEvent.press(getByTestId('column-toggle-runtime'));
    expect(onToggle).toHaveBeenCalledWith('runtime');
  });

  it('calls onToggle with correct key for each column', async () => {
    const onToggle = jest.fn();
    const { getByTestId } = await render(
      <ColumnSelector visibleColumns={ALL_HIDDEN} onToggle={onToggle} />,
    );
    await fireEvent.press(getByTestId('column-toggle-genres'));
    expect(onToggle).toHaveBeenCalledWith('genres');
  });

  // 098 T011b (WCAG 4.1.2 / 2.5.8): the T010 panel-open axe scan found each toggle exposed TWO
  // controls — the Pressable (role=switch, but no aria-checked on web: RNW does not reflect
  // accessibilityState.checked) and a nested RN Switch rendering an unlabeled, focusable 40×20
  // input. The Pressable is now the single, labelled switch; the visual switch is hidden from AT.
  describe('one accessible switch per column (098 T011b)', () => {
    it('each toggle is role=switch with aria-checked and a label', async () => {
      const { getByTestId } = await render(
        <ColumnSelector visibleColumns={SOME_VISIBLE} onToggle={() => {}} />,
      );
      // On native RN folds `aria-checked` into accessibilityState, so the host shows the state there;
      // the web DOM's aria-checked is asserted by the panel-open axe scan (a11y.spec.ts).
      const owned = getByTestId('column-toggle-owned');
      expect(owned.props.role).toBe('switch');
      expect(owned.props.accessibilityState).toEqual(expect.objectContaining({ checked: true }));
      expect(owned.props.accessibilityLabel).toBe('Owned');
      expect(getByTestId('column-toggle-language').props.accessibilityState).toEqual(
        expect.objectContaining({ checked: false }),
      );
    });

    it('exposes exactly one switch per toggleable column — no nested control', async () => {
      const { getAllByRole } = await render(
        <ColumnSelector visibleColumns={ALL_HIDDEN} onToggle={() => {}} />,
      );
      expect(getAllByRole('switch')).toHaveLength(TOGGLEABLE_COLUMN_KEYS.length);
    });

    it('the visual switch is hidden from assistive tech', async () => {
      const { getByTestId } = await render(
        <ColumnSelector visibleColumns={SOME_VISIBLE} onToggle={() => {}} />,
      );
      const indicator = getByTestId('column-toggle-owned-indicator', {
        includeHiddenElements: true,
      });
      expect(isHiddenFromAccessibility(indicator)).toBe(true);
      expect(indicator.props.importantForAccessibility).toBe('no-hide-descendants');
    });
  });
});
