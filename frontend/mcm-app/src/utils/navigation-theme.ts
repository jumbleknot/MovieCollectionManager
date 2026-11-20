/**
 * React Navigation theme derived from the design-system colour roles (item #243).
 *
 * Expo Router's navigators paint their own screen container with React Navigation's theme. Without
 * one, that is the LIGHT default (`DefaultTheme.colors.background` = rgb(242,242,242)) whatever the
 * app's theme: invisible only while every screen happened to paint over it, and a bright band
 * wherever a layout did not (the feature-062 settings layout carried a workaround for exactly that).
 *
 * Deriving from `DarkTheme` / `DefaultTheme` keeps React Navigation's own fields (fonts, `dark`);
 * only the colours come from the design system, so the container matches the app surface in both
 * themes and follows a runtime theme switch.
 */
import { DarkTheme, DefaultTheme, type Theme } from 'expo-router';
import { darkColors, lightColors } from '@mcm/design-system';
import type { ThemeName } from '@/hooks/use-theme';

function build(base: Theme, c: typeof lightColors | typeof darkColors): Theme {
  return {
    ...base,
    colors: {
      ...base.colors,
      primary: c.primary,
      background: c.background,
      card: c.surface,
      text: c.onSurface,
      border: c.outlineVariant,
      notification: c.error,
    },
  };
}

const NAVIGATION_THEMES: Record<ThemeName, Theme> = {
  dark: build(DarkTheme, darkColors),
  light: build(DefaultTheme, lightColors),
};

export function navigationTheme(name: ThemeName): Theme {
  return NAVIGATION_THEMES[name];
}
