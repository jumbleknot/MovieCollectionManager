/**
 * Item #243: the navigator's screen container must follow the app theme, never React Navigation's
 * light default (rgb(242,242,242)).
 */
import { DarkTheme, DefaultTheme } from 'expo-router';
import { darkColors, lightColors } from '@mcm/design-system';
import { navigationTheme } from '@/utils/navigation-theme';

const RN_LIGHT_DEFAULT_BACKGROUND = DefaultTheme.colors.background; // rgb(242, 242, 242)

describe('navigationTheme', () => {
  it('dark: a dark theme painted with the design-system dark surface', () => {
    const theme = navigationTheme('dark');
    expect(theme.dark).toBe(true);
    expect(theme.colors.background).toBe(darkColors.background);
    expect(theme.colors.card).toBe(darkColors.surface);
    expect(theme.colors.text).toBe(darkColors.onSurface);
    expect(theme.colors.background).not.toBe(RN_LIGHT_DEFAULT_BACKGROUND);
  });

  it('light: the design-system light surface, not React Navigation’s grey default', () => {
    const theme = navigationTheme('light');
    expect(theme.dark).toBe(false);
    expect(theme.colors.background).toBe(lightColors.background);
    expect(theme.colors.background).not.toBe(RN_LIGHT_DEFAULT_BACKGROUND);
  });

  it('keeps React Navigation’s own non-colour fields (fonts)', () => {
    expect(navigationTheme('dark').fonts).toEqual(DarkTheme.fonts);
    expect(navigationTheme('light').fonts).toEqual(DefaultTheme.fonts);
  });
});
