/**
 * Unit tests for withAlpha (feature 062 follow-up).
 *
 * These exist because the bug this helper replaces FAILED SILENTLY: `theme.onSurface?.val + '14'`
 * produces an invalid colour for any non-hex token, and an invalid colour is dropped by both React
 * Native and the browser without an error. Nothing went red — the hover simply could not be seen.
 * So the cases that matter here are the non-hex ones, not the happy path.
 */

import { withAlpha, stateLayer } from './with-alpha';

describe('withAlpha', () => {
  it('converts a 6-digit hex to rgba', () => {
    expect(withAlpha('#E3E2E6', 0.12)).toBe('rgba(227, 226, 230, 0.12)');
  });

  it('expands a 3-digit hex', () => {
    expect(withAlpha('#FFF', 0.5)).toBe('rgba(255, 255, 255, 0.5)');
  });

  it('accepts a hex without the leading hash', () => {
    expect(withAlpha('0F1117', 1)).toBe('rgba(15, 17, 23, 1)');
  });

  it('returns a NON-HEX colour unchanged rather than corrupting it', () => {
    // The regression this helper exists for: string-concatenating an alpha suffix onto these
    // yields `rgb(1,2,3)14` / `red14`, which render as nothing at all.
    expect(withAlpha('rgb(1, 2, 3)', 0.12)).toBe('rgb(1, 2, 3)');
    expect(withAlpha('rgba(1, 2, 3, 0.5)', 0.12)).toBe('rgba(1, 2, 3, 0.5)');
    expect(withAlpha('red', 0.12)).toBe('red');
  });

  it('returns undefined for an undefined token, so a missing theme key does not become "undefined14"', () => {
    expect(withAlpha(undefined, 0.12)).toBeUndefined();
  });

  it('clamps alpha into 0–1', () => {
    expect(withAlpha('#000000', 5)).toBe('rgba(0, 0, 0, 1)');
    expect(withAlpha('#000000', -2)).toBe('rgba(0, 0, 0, 0)');
  });

  it('keeps the hover state layer visible enough to see on a dark surface', () => {
    // 0.08 was the effective opacity of the old `+ '14'` form and was invisible on #0F1117.
    expect(stateLayer.hover).toBeGreaterThan(0.08);
    expect(stateLayer.press).toBeGreaterThan(stateLayer.hover);
  });
});
