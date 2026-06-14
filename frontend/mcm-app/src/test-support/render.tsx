/**
 * Test render helper (feature 015 — design system).
 *
 * Re-skinned components are Tamagui components and require a <TamaguiProvider>
 * in the tree. This wraps @testing-library/react-native's render with the app's
 * Tamagui config (dark theme) and re-exports the rest of the RTL API, so unit
 * tests for re-skinned components import { render, fireEvent, ... } from here.
 */
import React from 'react';
import { render as rtlRender } from '@testing-library/react-native';
import type { RenderOptions } from '@testing-library/react-native';
import { TamaguiProvider } from '@tamagui/core';
import config from '../../tamagui.config';

function Providers({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <TamaguiProvider config={config} defaultTheme="dark">
      {children}
    </TamaguiProvider>
  );
}

export function render(
  ui: React.ReactElement,
  options?: Omit<RenderOptions, 'wrapper'>,
): ReturnType<typeof rtlRender> {
  return rtlRender(ui, { wrapper: Providers, ...options });
}

export * from '@testing-library/react-native';
