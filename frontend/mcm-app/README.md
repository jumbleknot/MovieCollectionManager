# mcm-app (Movie Collection Manager frontend)

React Native Expo app targeting **web** and **Android**, with the BFF running
server-side inside Expo Router API routes. See the repo-root
[CLAUDE.md](../../CLAUDE.md) for the full architecture, commands, and dev-infra
runbook; this file covers the **UI / design system** layer added in feature 015.

## Design system & theming (feature 015)

The UI is built on the **MCM Cinema design system** — a Tamagui-based component
+ token library shipped as the workspace package
[`@mcm/design-system`](../../packages/design-system) (dark-first, MD3-derived,
Outfit headings / Inter body, Cinematic-Blue primary, restrained orange accent).

### How it is wired

- **`tamagui.config.ts`** re-exports the design-system config. The app is wrapped
  in `<TamaguiProvider>` in [src/app/_layout.tsx](src/app/_layout.tsx).
- **Runtime-only Tamagui.** The Tamagui babel/metro compiler plugins are **not**
  installed — only the runtime. This keeps the (fragile, Windows) Android build,
  the `@segment` metro shim, and the Reanimated worklets babel plugin untouched.
  Bundle/TTI cost is accepted in exchange (measured in the feature-015 PR).
- **Pin Tamagui to v1 (`^1.144`).** The design system is authored against the
  Tamagui **v1** API; `expo install tamagui` pulls a breaking v2 by default. Keep
  the v1 pin on any future install. Migrating the DS to v2 is a separate effort.
- **Fonts** (Outfit/Inter via `@expo-google-fonts/*`) load non-blocking in
  `_layout.tsx`; the Tamagui families fall back to `system-ui, sans-serif` so a
  font-load failure never hangs the app or flashes unstyled text (FR-017).

### Dark / light theme

- **Dark is the default.** The device-local preference is held by
  [`use-theme`](src/hooks/use-theme.tsx) and persisted under the AsyncStorage key
  **`mcm.theme`** (web: `localStorage`; native: app storage). No backend/profile
  involvement — UI state only.
- The **theme toggle** lives in the app bar
  ([navigation-bar.tsx](src/components/navigation-bar.tsx), `testID="theme-toggle"`)
  on both web and native, so it is reachable on every authenticated screen. It
  calls `useTheme().toggle()`; the `TamaguiProvider` theme follows the choice.

### Writing / re-skinning a component

- Style with **theme tokens**: `const theme = useTheme()` then `theme.<role>?.val`
  (Tamagui's `useTheme` values are optionally typed — always `?.val`).
- Import leanly: stacks from `@tamagui/stacks`, `Text`/`useTheme` from
  `@tamagui/core`, DS components from `@mcm/design-system` — **never** `from 'tamagui'`.
- **Preserve every `testID`** — the stable selectors are a contract
  (`specs/015-apply-design-system/contracts/selectors-baseline.txt`; FR-018).
- Unit tests that render a themed component must import `render` from
  [`@/test-support/render`](src/test-support/render.tsx) (it wraps `TamaguiProvider`)
  or `useTheme()` throws.
- **Flex layouts that must align across rows** (e.g. the web movie data table):
  Tamagui's `flex={N}` prop sets only `flex-grow` and leaves `flex-basis: auto`,
  so cell widths track their content and columns drift. Use a true proportional
  item — `flexGrow={N} flexShrink={1} flexBasis={0} minWidth={0}` — on every
  aligned cell (see [movie-list.tsx](src/components/movie-list.tsx) /
  [movie-list-item.tsx](src/components/movie-list-item.tsx)).

## Web E2E note (Tamagui on this machine)

Metro's **dev** web bundler OOMs building the app + Tamagui locally, so web E2E
runs against the **dev BFF container** (production-mode `expo export`, which is
memory-bounded). Rebuild the image after every source change — the container
serves a prebuilt bundle, so a stale image silently tests old code:

```bash
pnpm nx docker-build mcm-app
docker compose --profile bff-dev up -d --force-recreate mcm-bff-dev
E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app
```

See CLAUDE.md → "Final local E2E runs against the BFF container" for the full
matrix (dev vs prod container, mobile deltas) and the Metro reset afterwards.
