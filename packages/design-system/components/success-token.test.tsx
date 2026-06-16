/**
 * Success colour-role contract (feature 017, T004).
 * specs/017-design-system-consistency/contracts/success-token.md
 *
 * Asserts the new semantic role exists in both colour maps, resolves through TamaguiProvider
 * under each theme, and meets WCAG AA (≥4.5:1) for the three required pairings in BOTH themes.
 * This is the RED→GREEN driver for the token itself (T005 makes it pass).
 */
import React from 'react';
import { Text } from 'react-native';
import { render } from '@testing-library/react-native';
import { TamaguiProvider, useTheme } from '@tamagui/core';
import config from '../tamagui.config';
import { lightColors, darkColors } from '../tokens/colors';

const ROLES = ['success', 'onSuccess', 'successContainer', 'onSuccessContainer'] as const;

// ─── WCAG relative-luminance contrast ─────────────────────────────────────────
function luminance(hex: string): number {
  const c = hex.replace('#', '');
  const ch = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
  const lin = ch.map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}
function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// ─── Probe: reads the resolved theme values into testIDs ──────────────────────
function ThemeProbe() {
  const theme = useTheme();
  return (
    <>
      {ROLES.map((r) => (
        <Text key={r} testID={`val-${r}`}>
          {(theme as Record<string, { val?: string } | undefined>)[r]?.val ?? ''}
        </Text>
      ))}
    </>
  );
}

describe('success colour role (contract)', () => {
  it('all four roles exist and are non-empty in lightColors and darkColors', () => {
    for (const role of ROLES) {
      expect((lightColors as Record<string, string>)[role]).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect((darkColors as Record<string, string>)[role]).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it.each(['light', 'dark'] as const)('resolves all success roles via TamaguiProvider (%s)', (themeName) => {
    const map = themeName === 'light' ? lightColors : darkColors;
    const { getByTestId } = render(
      <TamaguiProvider config={config} defaultTheme={themeName}>
        <ThemeProbe />
      </TamaguiProvider>,
    );
    for (const role of ROLES) {
      expect(getByTestId(`val-${role}`).props.children).toBe((map as Record<string, string>)[role]);
    }
  });

  it.each(['light', 'dark'] as const)('meets WCAG AA in both themes (%s)', (themeName) => {
    const c = themeName === 'light' ? lightColors : darkColors;
    // success TEXT on the surface
    expect(contrast(c.success, c.surface)).toBeGreaterThanOrEqual(4.5);
    // onSuccess on a success-filled element
    expect(contrast(c.onSuccess, c.success)).toBeGreaterThanOrEqual(4.5);
    // onSuccessContainer text on the success container
    expect(contrast(c.onSuccessContainer, c.successContainer)).toBeGreaterThanOrEqual(4.5);
  });
});
