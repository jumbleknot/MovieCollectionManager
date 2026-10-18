/**
 * Text-default preservation (feature 081 US10, T074 (i) — research R12 B4).
 *
 * On Tamagui 2 `createTamagui({ defaultProps: { Text: { fontFamily, color } } })` gave every bare
 * Tamagui `Text` the body font and the `onBackground` colour. Tamagui 3 removes config `defaultProps`
 * with no type error at the call sites, so dropping it silently would change the font and colour of
 * every Text that does not set its own — on native, an unset colour is black on the dark theme.
 * This pins the observable result, whatever mechanism supplies it.
 *
 * Under Tamagui 3 the defaults live on the design system's own `Text` (primitives/Text.tsx), so the
 * render cases use it — and the last case enforces that nothing in the design system or the app
 * imports `Text` from `@tamagui/core` directly, which would quietly bypass the defaults again.
 */
import fs from 'fs';
import path from 'path';
import React from 'react';
import { StyleSheet } from 'react-native';
import { render } from '@testing-library/react-native';
import { TamaguiProvider } from '@tamagui/core';
import { Text } from './primitives/Text';
import config from '../tamagui.config';
import { darkColors, lightColors } from '../tokens/colors';

function flatStyle(node: { props: { style?: unknown } }) {
  return StyleSheet.flatten(node.props.style as never) as Record<string, unknown>;
}

describe('the design-system Text inside the provider', () => {
  it.each([
    ['dark', darkColors.onBackground],
    ['light', lightColors.onBackground],
  ] as const)('renders in the body font and the %s theme onBackground colour', (theme, colour) => {
    const { getByTestId } = render(
      <TamaguiProvider config={config} defaultTheme={theme}>
        <Text testID="bare">hello</Text>
      </TamaguiProvider>,
    );
    const style = flatStyle(getByTestId('bare'));
    expect(String(style.fontFamily)).toMatch(/^Inter/);
    expect(String(style.color).toLowerCase()).toBe(colour.toLowerCase());
  });

  it('keeps an explicitly set colour and font', () => {
    const { getByTestId } = render(
      <TamaguiProvider config={config} defaultTheme="dark">
        <Text testID="set" color="#123456" fontFamily="heading">hello</Text>
      </TamaguiProvider>,
    );
    const style = flatStyle(getByTestId('set'));
    expect(String(style.color).toLowerCase()).toBe('#123456');
    expect(String(style.fontFamily)).toMatch(/^Outfit/);
  });

  it('no source outside primitives/Text.tsx imports Text from @tamagui/core (it would skip the defaults)', () => {
    const roots = [path.resolve(__dirname), path.resolve(__dirname, '../../../frontend/mcm-app/src')];
    const allowed = path.resolve(__dirname, 'primitives/Text.tsx');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(full); continue; }
        if (!/\.tsx?$/.test(e.name) || full === allowed) continue;
        const src = fs.readFileSync(full, 'utf8');
        for (const m of src.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'@tamagui\/core'/g)) {
          if (m[1].split(',').some((n) => /^(type\s+)?Text(\s+as\s+\w+)?$/.test(n.trim()))) offenders.push(path.relative(path.resolve(__dirname, '../../..'), full));
        }
      }
    };
    roots.forEach(walk);
    expect(offenders).toEqual([]);
  });
});
