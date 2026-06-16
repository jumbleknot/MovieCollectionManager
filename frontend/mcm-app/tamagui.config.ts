/**
 * Tamagui config entry point for mcm-app (feature 015 — design system).
 *
 * Re-exports the shared `@mcm/design-system` Tamagui config (tokens, themes,
 * Outfit/Inter fonts, media queries) so the app and the design-system package
 * share one source of truth. Wired into the app via <TamaguiProvider> in
 * src/app/_layout.tsx. Runtime-only — no @tamagui/babel-plugin or metro-plugin
 * (research R1: protects the Windows Android build + existing metro/babel setup).
 */
export { default } from '@mcm/design-system/tamagui.config';
export type { AppConfig } from '@mcm/design-system/tamagui.config';
