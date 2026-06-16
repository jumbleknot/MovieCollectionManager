/**
 * navigation-bar theme-toggle unit test (feature 015, US4 — T037).
 *
 * The app bar carries the dark/light theme toggle (FR-005 / SC-003 / Contract 2).
 * It must expose a stable `theme-toggle` testID and, when pressed, flip + persist
 * the device-local theme via the use-theme context (AsyncStorage key `mcm.theme`).
 */
import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { render, fireEvent, waitFor } from '@/test-support/render';
import { ThemeProvider } from '@/hooks/use-theme';
import { NavigationBar } from './navigation-bar';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

jest.mock('expo-router', () => ({
  usePathname: () => '/(app)/home',
  // <Link asChild> just renders its child in tests.
  Link: ({ children }: { children: React.ReactNode }) => children,
}));

beforeEach(async () => {
  await AsyncStorage.clear();
});

function renderNavBar() {
  return render(
    <ThemeProvider>
      <NavigationBar />
    </ThemeProvider>,
  );
}

describe('NavigationBar theme toggle', () => {
  it('renders a theme-toggle control with an accessibility label', () => {
    const { getByTestId } = renderNavBar();
    const toggle = getByTestId('theme-toggle');
    expect(toggle).toBeTruthy();
    expect(toggle.props.accessibilityRole).toBe('button');
    expect(toggle.props.accessibilityLabel).toBeTruthy();
  });

  it('flips and persists the theme to light when pressed (dark default)', async () => {
    const { getByTestId } = renderNavBar();
    // Let the dark default settle from the initial AsyncStorage read.
    await waitFor(() => expect(getByTestId('theme-toggle')).toBeTruthy());

    fireEvent.press(getByTestId('theme-toggle'));

    await waitFor(async () =>
      expect(await AsyncStorage.getItem('mcm.theme')).toBe('light'),
    );
  });

  it('preserves the existing navigation-bar selectors', () => {
    const { getByTestId } = renderNavBar();
    expect(getByTestId('navigation-bar')).toBeTruthy();
    expect(getByTestId('nav-home')).toBeTruthy();
    expect(getByTestId('nav-profile')).toBeTruthy();
  });
});
