/**
 * use-theme hook tests (feature 015, T006).
 * Covers FR-005 / SC-003 / data-model Theme Preference + Contract 2.
 */
import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ThemeProvider, useTheme } from './use-theme';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <ThemeProvider>{children}</ThemeProvider>
);

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('use-theme', () => {
  it('defaults to dark when nothing is stored', async () => {
    const { result } = renderHook(() => useTheme(), { wrapper });
    await waitFor(() => expect(result.current.theme).toBe('dark'));
  });

  it('reads a stored light preference on mount', async () => {
    await AsyncStorage.setItem('mcm.theme', 'light');
    const { result } = renderHook(() => useTheme(), { wrapper });
    await waitFor(() => expect(result.current.theme).toBe('light'));
  });

  it('toggle() flips the theme and persists it', async () => {
    const { result } = renderHook(() => useTheme(), { wrapper });
    await waitFor(() => expect(result.current.theme).toBe('dark'));
    act(() => result.current.toggle());
    expect(result.current.theme).toBe('light');
    await waitFor(async () =>
      expect(await AsyncStorage.getItem('mcm.theme')).toBe('light'),
    );
  });

  it('falls back to dark for an unrecognized stored value', async () => {
    await AsyncStorage.setItem('mcm.theme', 'chartreuse');
    const { result } = renderHook(() => useTheme(), { wrapper });
    await waitFor(() => expect(result.current.theme).toBe('dark'));
  });
});
