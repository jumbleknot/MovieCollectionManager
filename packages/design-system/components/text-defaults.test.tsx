/**
 * Text-default preservation (feature 081 US10, T074 (i) — research R12 B4).
 *
 * On Tamagui 2 `createTamagui({ defaultProps: { Text: { fontFamily, color } } })` gave every bare
 * Tamagui `Text` the body font and the `onBackground` colour. Tamagui 3 removes config `defaultProps`
 * with no type error at the call sites, so dropping it silently would change the font and colour of
 * every Text that does not set its own — on native, an unset colour is black on the dark theme.
 * This pins the observable result, whatever mechanism supplies it.
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import { render } from '@testing-library/react-native';
import { TamaguiProvider, Text } from '@tamagui/core';
import config from '../tamagui.config';
import { darkColors, lightColors } from '../tokens/colors';

function flatStyle(node: { props: { style?: unknown } }) {
  return StyleSheet.flatten(node.props.style as never) as Record<string, unknown>;
}

describe('a bare Text inside the provider', () => {
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
        <Text testID="set" color="#123456" fontFamily="$heading">hello</Text>
      </TamaguiProvider>,
    );
    const style = flatStyle(getByTestId('set'));
    expect(String(style.color).toLowerCase()).toBe('#123456');
    expect(String(style.fontFamily)).toMatch(/^Outfit/);
  });
});
