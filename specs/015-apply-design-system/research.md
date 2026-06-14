# Phase 0 Research: Apply MCM Cinema Design System

All decisions below resolve the "NEEDS CLARIFICATION / unknowns" surfaced in the Technical Context.
Context is constrained by: Expo SDK 56 / RN 0.85 / Hermes, a fragile Windows Android build, existing
Metro (segment shim) + Babel (reanimated worklets) customizations, and a load-bearing requirement to
keep every E2E `testID` intact.

---

## R1 — Tamagui integration mode and provider/font ordering

**Decision**: Integrate Tamagui in **runtime-only** mode — install `tamagui` (+ `@tamagui/core`,
`@tamagui/config`), add a root `tamagui.config.ts` that re-exports
`@mcm/design-system/tamagui.config`, and wrap the app in `<TamaguiProvider config={config}
defaultTheme="dark">`. **Do NOT** add `@tamagui/babel-plugin` or `@tamagui/metro-plugin` in this
feature. Mount the provider as the **outermost** wrapper in `src/app/_layout.tsx`, gated on
`expo-font` `useFonts(...)` having loaded Outfit + Inter; the `@/assistant-polyfills` import stays
first, then `TamaguiProvider` → `ThemeProvider(use-theme)` → existing
`SafeAreaProvider`/`AuthProvider`/`UiStateProvider`/`AssistantDataSyncProvider` → `Stack`.

**Rationale**: Tamagui runs fully at runtime without its compiler plugins; the plugins are
build-time *optimizations* (style extraction, tree-shaking), not requirements. The Windows Android
build already walks a tightrope (CMAKE path wall) and Metro/Babel carry custom logic; adding two
more compiler plugins now is the highest-risk way to destabilize a known-green build. Provider must
wrap routes so `useTheme`/tokens resolve everywhere; font gate prevents a flash of fallback text
swapping to Outfit/Inter mid-render.

**Alternatives considered**: (a) Full compiler setup per the DESIGN-SYSTEM.md quickstart — smaller
bundles, but build risk now; deferred (R3 gate). (b) NativeWind/Tailwind — rejected: the design
system is authored in Tamagui; switching engines discards the source of truth.

---

## R2 — Device-local theme persistence (dark default, no flash)

**Decision**: Persist the theme with `@react-native-async-storage/async-storage` under key
`mcm.theme` (`'dark' | 'light'`). A `use-theme` Hook initializes state to `'dark'` (the default),
reads AsyncStorage on mount, and applies the stored value once resolved; writes happen on toggle.
On web, AsyncStorage is backed by `localStorage`, so the same code path persists across reloads; on
native it persists across relaunches. To avoid a flash-of-wrong-theme, the initial render uses the
dark default (which is also the most common stored value) and only re-applies after async read;
because dark is the default, the only visible correction is dark→light for users who chose light —
acceptable and brief. The `TamaguiProvider`'s active theme is driven by the hook's value.

**Rationale**: Matches the clarified scope (device-local, two modes, dark default, no backend).
AsyncStorage is the standard Expo-supported cross-platform KV store and avoids any BFF/profile
change, keeping the UI-only boundary intact.

**Alternatives considered**: (a) `expo-secure-store` — rejected: theme is non-sensitive; SecureStore
is for secrets only (constitution). (b) Syncing to the user profile via BFF — rejected by
clarification (breaks UI-only scope). (c) Reading OS color scheme (`useColorScheme`) as default —
rejected: clarified "no system-follow"; dark is the fixed default.

---

## R3 — Bundle-size / TTI impact and the budget gate

**Decision**: Treat the constitution's ≤2 s-TTI-on-3G budget as a gate. Measure the web bundle
size and cold TTI before and after wiring Tamagui + fonts (Expo's bundle output + a manual
home-screen TTI check). Preload Outfit/Inter via `expo-font` (no FOIT beyond the gated splash).
Keep the runtime-only mode unless the measured delta threatens the budget; only then revisit the
compiler plugins (R1) as an optimization. Fonts are subset to the weights the DS uses (Outfit
400/500/700, Inter 400/500).

**Rationale**: Tamagui runtime + two font families add measurable weight; making the decision
data-driven (measure, then decide) prevents both premature optimization and silent budget breaches.

**Alternatives considered**: Adopting the compiler up front purely for bundle size — rejected until
measurement shows it's needed (build-risk tradeoff, R1).

---

## R4 — Native-dependency / APK-rebuild check

**Decision**: Two new deps ship native code: `react-native-svg` and
`@react-native-async-storage/async-storage`. Both are Expo-supported (`npx expo install` resolves
SDK-56-compatible versions) and autolink. Because they add native modules, the **embedded-bundle
Android APK must be rebuilt** before mobile E2E (per the project's "FIRST — do you even need to
rebuild?" rule: a `package.json` native-dep change is exactly the trigger). Prefer the **CI
`android-apk.yml`** path (Linux runner, no CMAKE wall) over the local Windows recipe. Verify the
last successful CI APK's `headSha` diff against HEAD for `frontend/mcm-app/{package.json,android,app.json}`;
since this feature adds native deps, that diff is non-empty → rebuild required. Web needs no rebuild
(Metro serves the new JS).

**Rationale**: `react-native-svg` is needed for the Grumpy Robot avatar (DS `AssistantAvatar`);
AsyncStorage for theme persistence. Both are common, well-supported native modules. Skipping the
rebuild would run a stale APK that crashes on the new native module at launch.

**Alternatives considered**: (a) Pure-JS SVG/storage shims — rejected: `react-native-svg` is the DS's
own dependency and the idiomatic choice; a `localStorage`-only web path wouldn't cover native. (b)
Rendering the avatar as a PNG to avoid svg — rejected: loses scalability/theming the DS SVG provides.

---

## R5 — Re-skin pattern that preserves stable selectors

**Decision**: Re-skin by **swapping each existing component's internal rendering to DS components
while keeping the file, its exported name, its public props, and every `testID`/`accessibilityLabel`
unchanged**. DS components must forward `testID`/`accessibilityLabel`/`accessibilityState` to their
underlying pressable/text node (verified/added during hardening, FR-021). Where a DS component
doesn't expose a needed selector prop, wrap it in a thin `<View testID=…>` that doesn't alter layout
semantics. No `testID` value is renamed; the stable-selector contract (contracts/ui-contracts.md) is
the checklist.

**Rationale**: FR-018/SC-002 make selector preservation the single highest-risk area. Treating the
selector list as a contract and forwarding props through DS components keeps the Playwright/Maestro
suites green without rewriting tests (which would defeat the "behaviour unchanged" guarantee).

**Alternatives considered**: Rewriting screens fresh against DS and updating all E2E selectors —
rejected: enormous test churn, high regression risk, and it would mask behavioural changes behind
selector changes.

---

## R6 — Registering the design-system package in workspace + Nx

**Decision**: Add `- 'packages/*'` to `pnpm-workspace.yaml`; add `@mcm/design-system` to
`mcm-app`'s `dependencies` as `workspace:*`. Give `packages/design-system` an Nx `project.json`
with `lint` (ESLint) and `test` (Jest + Expo Testing Library) targets so all checks run via
`pnpm nx test design-system` / `pnpm nx lint design-system` (constitution: Nx-first). Configure a
Jest project for the package (jest-expo preset, RN/Tamagui transform) and `tsconfig` for type-check.

**Rationale**: The package is currently outside the workspace (only `frontend/*` is listed), so
`workspace:*` resolution and Nx targets don't exist yet. Hardening (FR-021) requires a real test
target. Nx-first invocation is a constitution requirement.

**Alternatives considered**: Keeping the DS as an un-managed source folder imported by relative path
— rejected: violates Nx-first, gives no test/lint gate, and breaks the monorepo dependency graph.

---

## R7 — Web data-table vs native card list

**Decision**: Use the constitution's platform-extension convention for the collection movie list —
the **extensionless `movie-list.tsx` is the web default** (DS **data-table** surface: toolbar with
count + orange "Add movie", Outfit uppercase headers with a 2dp primary bottom border, hover rows,
column-visibility honored), and **`movie-list.native.tsx` overrides** with the DS `MovieCard`
(compact) card/row list. **Do not add a `movie-list.web.tsx`** — the extensionless file already *is*
web (constitution §Components-Layer: "the default must be for web"; mirrors the existing
`collection-list.tsx` / `collection-list.native.tsx` pair). Both expose **identical props** and the
**same `testID`s** (row, add-movie button, count line, etc.).

**Rationale**: The mock-up's wide multi-column table is a web layout; a wide table is wrong for a
phone. Platform extensions are the constitution's sanctioned mechanism, and identical props/selectors
keep both E2E suites asserting the same scenarios.

**Alternatives considered**: One responsive component that collapses the table to cards under a
breakpoint — viable with Tamagui media tokens, but the platform-extension split is cleaner, matches
existing repo patterns (e.g. `collection-list.native.tsx`), and avoids shipping table code to the
native bundle.

---

## Summary of resolved unknowns

| # | Decision |
|---|---|
| R1 | Tamagui runtime-only; provider outermost, font-gated; no babel/metro plugins. |
| R2 | AsyncStorage `mcm.theme`, dark default, `use-theme` hook; web=localStorage, native=relaunch-persistent. |
| R3 | Measure bundle/TTI vs the ≤2 s/3G budget; runtime-only unless data says otherwise. |
| R4 | `react-native-svg` + `async-storage` are native → rebuild APK via CI; web unaffected. |
| R5 | Swap internals to DS, preserve every testID/label (prop-forwarding); selector list is a contract. |
| R6 | Add `packages/*` to workspace; `@mcm/design-system` as `workspace:*`; Nx `test`/`lint` project. |
| R7 | `movie-list.web` = DS table, `movie-list.native` = DS card list; identical props/selectors. |
