---
type: Service
title: MCM Cinema design system
description: The Material Design 3 token set and Tamagui 3 component library (@mcm/design-system) shared by the Expo app's web and native builds — its theme-split colour roles, dark default, runtime-only Tamagui wiring, the R1-R7 compliance scan that keeps the app from drifting off it, and the repo-wide Renovate locks that keep its framework versions owned by the Expo SDK.
resource: packages/DESIGN-SYSTEM.md
tags: [design-system, tamagui, ui, tokens, md3]
sources:
  - id: openwiki-source-e9bcd4372a4632d555b861a6
    resource: repo://frontend/mcm-app/package.json
  - id: openwiki-source-75c613635390ab18cc167ec1
    resource: repo://frontend/mcm-app/README.md
  - id: openwiki-source-d67eac1e98649691c637d9c0
    resource: repo://frontend/mcm-app/tamagui.config.ts
  - id: openwiki-source-786e50deebd10dc2a828d4e6
    resource: repo://frontend/mcm-app/tests/unit/design-system-compliance.test.ts
  - id: openwiki-source-4a49039347048abc47c466b7
    resource: repo://frontend/mcm-app/tests/unit/ds-compliance-scan.test.ts
  - id: openwiki-source-8ab33860194ded866427f647
    resource: repo://frontend/mcm-app/tests/unit/ds-compliance-scan.ts
  - id: openwiki-source-c847620424d66ef5f2e66d05
    resource: repo://packages/DESIGN-SYSTEM.md
  - id: openwiki-source-87ec032633e7c7bbf61a29f6
    resource: repo://packages/design-system/components/focus-ring.test.ts
  - id: openwiki-source-08eebdda17baf659b7ce331b
    resource: repo://packages/design-system/components/interaction-states.test.ts
  - id: openwiki-source-73371fb6e562a6846976bee5
    resource: repo://packages/design-system/components/primitives/FAB.tsx
  - id: openwiki-source-09ee847b43e33b41798d0b11
    resource: repo://packages/design-system/components/primitives/PillButton.tsx
  - id: openwiki-source-24ebe237368edff77286c22f
    resource: repo://packages/design-system/components/primitives/Text.tsx
  - id: openwiki-source-dbd3a1ab0d2813b1a52d6687
    resource: repo://packages/design-system/components/success-token.test.tsx
  - id: openwiki-source-4e5ca09d02519d4415cb5176
    resource: repo://packages/design-system/components/text-defaults.test.tsx
  - id: openwiki-source-a9c194be69907f6c04167c36
    resource: repo://packages/design-system/fonts/index.ts
  - id: openwiki-source-c946714d585eda56a568ec4a
    resource: repo://packages/design-system/index.ts
  - id: openwiki-source-9315324d9a0185179ef416f8
    resource: repo://packages/design-system/jest.config.js
  - id: openwiki-source-95aa559e7d1634eddb9fc64d
    resource: repo://packages/design-system/jest/tamagui-cjs-resolver.js
  - id: openwiki-source-f7e16ba323424b9790bca8b9
    resource: repo://packages/design-system/package.json
  - id: openwiki-source-43b80bf7258168486914092e
    resource: repo://packages/design-system/README.md
  - id: openwiki-source-7c01a8501da7bfee76f8ed12
    resource: repo://packages/design-system/tamagui.config.ts
  - id: openwiki-source-aebe1152602dd681cb05f131
    resource: repo://packages/design-system/theme/dark.ts
  - id: openwiki-source-9ccf7d043a370e9d13139133
    resource: repo://packages/design-system/tokens/colors.ts
  - id: openwiki-source-33cc1b67f34fd8d337e8639e
    resource: repo://packages/design-system/tokens/typography.ts
  - id: openwiki-source-cc2828785988d51226a4241e
    resource: repo://renovate.json
  - id: openwiki-source-e1b32ed173a0f6b508f94a03
    resource: repo://scripts/__tests__/tamagui-version-lockstep.guard.test.mjs
  - id: openwiki-source-e1a7063386de1c5b8a2e79a9
    resource: repo://scripts/lib/renovate-package-rules.mjs
  - id: openwiki-source-4b5e8012f071d7a46c3a91d4
    resource: repo://specs/017-design-system-consistency/contracts/compliance-rules.md
  - id: openwiki-source-4a3f18ae9eac44709bf504c7
    resource: repo://specs/017-design-system-consistency/contracts/sanctioned-deviations.md
  - id: openwiki-source-54da196e9c02e7f7f455cfb8
    resource: repo://specs/017-design-system-consistency/contracts/success-token.md
generated: { by: "openwiki/0.7.1", at: "2026-10-19T00:33:25.175Z" }
verified:
  - by: openwiki/0.7.1
    at: 2026-10-20T11:09:40.455Z
---

# MCM Cinema design system

`packages/design-system` — the workspace package `@mcm/design-system` — is a Material Design 3 token
set plus a Tamagui component library shared by both the web and native builds of the
[Expo/React Native app](./expo-app.md). It exists so the app's cinematic dark-first look (Cinematic
Blue primary, a restrained orange "marquee light" tertiary accent, Outfit headings over Inter body)
is expressed once, as tokens and components, rather than re-derived per screen.

Consumers import from the package barrel (`import { Button, Card, MovieCard, lightColors, darkColors }
from '@mcm/design-system'`) or from the config subpath (`@mcm/design-system/tamagui.config`); the app
re-exports the shared config from its own `tamagui.config.ts` rather than authoring a second one.
[`packages/DESIGN-SYSTEM.md`](../../packages/DESIGN-SYSTEM.md) is the full token and component
reference (colour roles, spacing, shape, elevation, motion, and every component's props) and
[`packages/design-system/README.md`](../../packages/design-system/README.md) the shorter package
summary. This page is a derived summary of those two plus the app-side enforcement, so it deliberately
does not enumerate component props — go to the source for those.

The package ships tokens (`tokens/`), the two themes (`theme/`), the `createFont` definitions
(`fonts/`), the Tamagui config, and the components grouped as primitives, inputs, surfaces, navigation,
domain and assistant. `package.json` publishes `"."` → `index.ts` and `"./tamagui.config"` →
`tamagui.config.ts`. `expo`, `react` and `react-native` are **peer dependencies declared as open
ranges** (`>=52.0.0`, `>=18.0.0`, `>=0.76.0`), and `react`/`react-native` are additionally pinned in
this package's own `devDependencies` so its Jest suite renders against the same runtime the app uses.
The package therefore never decides the app's framework versions — `react-native-safe-area-context`
and `react-native-svg` are ordinary `>=` dependencies for the same reason (they are only needed by
`NavigationBar` and `AssistantAvatar`, and the Expo SDK's version matrix owns the version, which is why
the Renovate lock below covers them too).

## Colour roles are theme-split

Semantic roles (`primary`, `secondary`, `tertiary`, `success`, `error`, the surface/background family,
`outline`, `scrim`, the pre-computed `surface1`–`surface5` tint tones, …) each carry a **distinct light
and dark value**, so one token resolves to a WCAG-AA-passing colour on both the near-white light surface
and the near-black "Cinema" dark surface. The role groups are:

| Role group | Tokens |
|---|---|
| Primary | `primary` `onPrimary` `primaryContainer` `onPrimaryContainer` |
| Secondary | `secondary` `onSecondary` `secondaryContainer` `onSecondaryContainer` |
| Tertiary (sparing orange accent) | `tertiary` `onTertiary` `tertiaryContainer` `onTertiaryContainer` |
| Success (positive / verified) | `success` `onSuccess` `successContainer` `onSuccessContainer` |
| Error | `error` `onError` `errorContainer` `onErrorContainer` |
| Surface / background | `background` `surface` `surface1`–`surface5` `surfaceVariant` `outline` `scrim` … |

Two properties of that mapping are load-bearing and easy to get wrong:

- **The semantic roles exist only in the themes, never also as colour tokens.** Palette tones are
  exposed as tokens (`primaryP40`, `tertiaryP50`, …), but the roles are not: Tamagui 3 resolves a bare
  name on a colour property *token-first* and theme second, so duplicating the light values as tokens
  made `color: 'onBackground'` resolve to the light colour inside the dark theme. Read roles via
  `useTheme()` → `theme.<role>?.val`, and in component code spell token/theme names **without** the
  Tamagui 2 `$` sigil — a leftover `"$primary"` still typechecks and resolves to nothing. The only
  non-palette colour tokens are `white` and `black`; `transparent` is deliberately *not* a token, since
  Tamagui 3 rejects a token named after a CSS keyword and the literal resolves correctly anyway.
- **`success` is a first-class role, not a green literal.** It was added (feature 017) precisely so
  positive/verified state flows through the theme: positive text uses `theme.success?.val`, a filled
  verified banner uses `successContainer` with `onSuccessContainer`, and no consumer may hardcode a
  green. The role exists in both colour maps and both themes, and the three required AA pairings
  (`success` on `surface`, `onSuccess` on `success`, `onSuccessContainer` on `successContainer`) are
  asserted in `components/success-token.test.tsx` — see
  [the success-token contract](../../specs/017-design-system-consistency/contracts/success-token.md).

## Typography and the weight ceiling

The type scale is the MD3 step set `{11,12,14,16,18,22,24,28,32,36,45,57}`. Outfit carries
display/headline/title and Inter carries body/label, and **both fonts load only the faces
400/500/600/700** — there is no 800 or 900 face. That ceiling is the whole rationale for compliance
rule R6: a `fontWeight` above 700 has no real face, so the renderer synthesizes one, which looks wrong
and differs per platform.

Styled text is expected to declare an explicit family (`Outfit`/`Outfit-*`, `Inter`/`Inter-*`, or the
`heading`/`body` font tokens). The app loads the fonts non-blocking and the Tamagui families fall back
to `system-ui, sans-serif`, so a font-load failure degrades the type rather than hanging the app.

## Themes: dark is the default

`dark` is the recommended default theme, and the reason is product-shaped rather than stylistic: MCM is
a movie-collection app, so a home-theatre-dark UI is the natural home for it. The dark background is
deliberately deeper than MD3's standard dark neutral — `#0F1117` instead of `#1A1C1E` — which evokes a
cinema and makes posters pop, and the orange tertiary accent glows warmly against it.

The app-side mechanism lives outside this package: the preference is device-local, defaults to dark,
and is persisted client-side only (no backend or profile involvement), with a toggle in the app bar.
See [Expo/React Native app](./expo-app.md) for how the app consumes the theme. Flipping the default is
a design decision that needs this rationale revisited, not a config tweak.

## Tamagui 3, runtime-only, pinned exactly

Tamagui is on **v3, pinned to one exact version in both manifests, with no compiler plugin** — and that
is a measured decision, not a leftover:

- **One exact version, never a range.** The design system declares `@tamagui/core`, `@tamagui/stacks`
  and `@tamagui/shorthands`; the app declares `@tamagui/core` and `@tamagui/stacks`. All of them sit at
  the same exact `3.0.18`. `scripts/__tests__/tamagui-version-lockstep.guard.test.mjs` fails if either
  manifest uses a range, if the two manifests disagree, if a Tamagui **peer** range is left open rather
  than bounded to the installed major (`>=3.0.0 <4`), if the lock holds more than one `@tamagui/core`
  or `@tamagui/web`, if any `@tamagui/*` entry in the lock drifts off the manifests' version, if the
  removed v2 `@tamagui/babel-plugin` is named by a manifest or `babel.config.js` again, or if any
  Tamagui update escapes the single Renovate `tamagui` group — a range lets a partial lock refresh split
  the set and leave two style registries behind. That group rule carries `rangeStrategy: pin` and sits
  *after* the broad `js patch/minor` / `js majors` rules, because the last matching `groupName` wins.
- **No Babel or Metro compiler plugin.** Tamagui 3 removed the Babel plugin the app ran from feature
  015, and its intended replacement, `@tamagui/metro-plugin` 3.0.x, was measured and rejected: it
  lowered some web modules to static class names *without emitting their CSS*, while saving no bytes.
  So Tamagui renders at runtime through `<TamaguiProvider>`, and `babel.config.js` carries only
  `babel-preset-expo` plus the Reanimated worklets plugin. Don't re-add a compiler incidentally while
  fixing something else.
- **The design system's own `Text` carries the defaults.** Tamagui 3 removed config-level
  `defaultProps`, so the body font and the theme's `onBackground` colour now live on
  `components/primitives/Text.tsx`; a bare `@tamagui/core` `Text` would silently fall back to the
  platform font and, on native, black text on the dark theme. That `Text` also restores the **web**
  default line height (`lineHeight: web:20px`), because Tamagui 2's stylesheet gave every Tamagui text
  its font's default (`true`) line height while Tamagui 3 only sets the family — measured as the 22px
  app-bar title growing 20 → 28px and table rows shrinking 37 → 35px. Native never had that rule and is
  left untouched. `components/text-defaults.test.tsx` pins the observable defaults *and* fails if any
  source file outside that one imports `Text` from `@tamagui/core`.
- **A numeric `lineHeight` on a Tamagui component is a ratio, not pixels.** Write pixels as the string
  `"20px"` (which is why the `Text` default above is a `web:`-scoped string). A bare number silently
  means something else.
- **A state is a clause on the property it modifies.** Tamagui 3 removed the v2 pseudo-state objects
  (`hoverStyle` / `pressStyle` / `focusVisibleStyle`), so a state is written either as a string program
  (`opacity="hover:0.92 press:0.88"`) or as a key of a typed value (`backgroundColor={{ default: a, hover: b }}`).
  A leftover v2 object is worse than wrong: it still typechecks, is forwarded as an unknown prop, and the
  interaction silently stops happening. The keyboard-only modifier is `focus-visible`; a bare `focus`
  clause reproduces the feature-015 bug where a mouse click leaves a persistent focus ring.
  `components/focus-ring.test.ts` and `components/interaction-states.test.ts` statically assert both —
  no v2 object survives, every ringed control keeps its `focus-visible` clause, and `Card`/`Button`/`Chip`
  each declare all three states.

Because the pin is a dependency-level constraint shared by two projects, a bump is a cross-repo change:
the guard, not prose, is the source of truth for what version is allowed.

## Framework versions belong to the Expo SDK, not to Renovate

The same cross-project reasoning applies to the framework packages this package declares, with one
extra twist: the lock has to be **repo-wide**, not per manifest. Three `packageRules` in
`renovate.json` carry `enabled: false` and **no `matchFileNames` scope**, so each one resolves for
every workspace manifest rather than only the app:

| Locked family | Patterns disabled repo-wide | Why the scope matters |
|---|---|---|
| React | `react`, `react-dom`, `react-test-renderer` | React also lives in the root manifest and here; a split React is two physical copies and an `invalid-hook-call` at runtime. This is the oldest of the three rules and the only one with no per-manifest assertion behind it. |
| React Native | `react-native`, `/^react-native-/`, `/^@react-native//`, `/^@react-native-community//` | The `/^react-native-/` half is not redundant: it is the only thing covering `react-native-reanimated`, `react-native-worklets`, gesture-handler, screens and safe-area-context — all SDK-matrix pins, none of them matched by the app-scoped rule's `react-native` / `/^@react-native//` patterns. |
| Expo SDK companions | `expo`, `/^expo-/`, `/^@expo//`, `/-expo$/` | `babel-preset-expo`, `jest-expo` and `eslint-config-expo` carry no `expo` prefix, so the app-scoped patterns miss all three, and `@expo/dom-webview` is declared in `pnpm-workspace.yaml`, which a `matchFileNames` rule cannot reach. |

The React Native scope is load-bearing rather than theoretical: PR #217 bumped `react-native`
0.85.3 → 0.87.0 *through this package's manifest*, where the older app-scoped rule could not reach
it, and RN 0.87 narrowed the press-event type so `GestureResponderEvent` stopped satisfying Tamagui's
`PressableProps['onPress']` — 15 typecheck errors across 14 files. The Expo-companion lock records the
same defect a third time, measured 2026-08-27 from the Dependency Dashboard (item #29): `babel-preset-expo`,
`jest-expo`, `eslint-config-expo` and `@expo/dom-webview` were all queued in `js majors` for 56 → 57
while `expo` itself sat at `^56.0.8` and `react-native` was correctly disabled — an SDK-56 runtime
against SDK-57 transform and test tooling, which fails as unexplained transform errors rather than as
typecheck errors pointing at a dependency. Both this package's devDependencies (`jest-expo ~57.0.6`,
`eslint-config-expo ~57.0.2`, `react 19.2.3`, `react-native 0.86.3`) and the app's are exactly why the
lock cannot be app-scoped. `@expo-google-fonts/*` is deliberately **not** matched — `/^@expo//`
requires a slash after `@expo` while the font packages separate with a hyphen — so it stays updatable.

The guard asserts the **resolved** value, not the presence of a rule:
`scripts/__tests__/renovate-workflow.guard.test.mjs` resolves `enabled` through the repository's own
`packageRules` (last matching rule wins, modelled in
[`scripts/lib/renovate-package-rules.mjs`](../../scripts/lib/renovate-package-rules.mjs)) for every
member of the RN family and the Expo-companion family, in each of `package.json`,
`frontend/mcm-app/package.json`, `packages/design-system/package.json` and `pnpm-workspace.yaml` — the
property being asserted is "what does this dependency resolve to in each package file", because the
broken configuration would have passed a check for "does a rule mentioning `react-native` exist".
A control test asserts `@expo-google-fonts/inter` and `@expo-google-fonts/outfit` still resolve
enabled, so widening the Expo lock past the SDK matrix fails the suite. That guard is not an
app-repo gate: it is a plain `node:test` file picked up by the `naming` job's
`node --test scripts/__tests__/*.test.mjs` step in `.forgejo/workflows/guardrails.yml`, which is why
`pnpm nx test design-system` does **not** run it — a green package suite says nothing about the lock.

```mermaid
flowchart TD
    A["renovate.json: three repo-wide lock rules, no matchFileNames"] --> B["guard replays packageRules in order - last matching rule wins"]
    B --> C["per manifest: package.json, frontend/mcm-app, packages/design-system, pnpm-workspace.yaml"]
    C --> D{"dependency in the RN or Expo-companion family"}
    D -- yes --> E["resolved enabled must be false"]
    D -- no --> F["@expo-google-fonts control must resolve enabled true"]
    E --> G["node:test file in the guardrails naming job"]
    F --> G
```

How the framework lock is asserted: the guard replays the repository's own `packageRules` per manifest and per dependency rather than searching for a rule that mentions the package.

Operationally: a `react`, `react-native` or Expo-companion bump in this package is never a raw
Renovate change — it goes through `expo install` / the expo upgrade skill together with the app, so
the two manifests move as one. Separately, the **toolchain majors** this package shares with the app
(`jest` with `@types/jest`, and `typescript`) are held behind an explicit dependency-dashboard tick
rather than a version ceiling, each in its own group so one tick releases one blocker, while patch and
minor updates stay ungated in `js patch/minor`; the babel and async-storage holds cover only the app
manifest. See [the Renovate runbook](../runbooks/renovate.md) for the bot's cadence and channels.

## The compliance scan (R1–R7)

The app enforces design-system usage with a **static scan run by its Jest suite**, not a runtime check.
The rules live in
[`frontend/mcm-app/tests/unit/design-system-compliance.test.ts`](../../frontend/mcm-app/tests/unit/design-system-compliance.test.ts)
— one `it()` per rule, each asserting zero violations over `frontend/mcm-app/src/**` (excluding the
`bff-server`/`bff-api`/`__mocks__`/`unit-tests` directories and test/spec files) — and it runs as part
of the ordinary `pnpm nx test mcm-app` unit tier. Read that file and
[the compliance-rules contract](../../specs/017-design-system-consistency/contracts/compliance-rules.md)
for the authoritative rule table; in outline, R1 forbids hardcoded colour literals, R2 requires numeric
`fontSize` values to be on the MD3 scale, R3 requires styled text to declare an Outfit/Inter family, R4
forbids bespoke `TouchableOpacity`/`Pressable` buttons, R5 forbids a duplicated private "pill" button
style across agent components, R6 forbids a synthesized weight above 700, and R7 forbids a raw
`<Modal>` where the DS `Dialog` is the canonical surface.

```mermaid
flowchart TD
    A["App source change under frontend/mcm-app/src"] --> B["pnpm nx test mcm-app"]
    B --> C["design-system-compliance.test.ts: one it per rule R1-R7"]
    C --> D["ds-compliance-scan.ts builds one cached ScanFile per source file"]
    D --> E{"Rule predicate flags a line"}
    E -- no --> F["Rule passes"]
    E -- yes --> G{"ds-exempt marker on that line or the previous non-blank line"}
    G -- yes --> F
    G -- no --> H["Violation printed as file line rule snippet"]
    H --> I["Suite fails"]
```

The scan's shape: the read/neutralize/brace-parse pass and the seven rule predicates live in
`tests/unit/ds-compliance-scan.ts` so each file is read once and the predicates can be unit-tested in
isolation; failures print `file:line — rule — snippet` so a migration can be driven file by file.

Two asymmetries matter to anyone changing this area:

- **A design-system change can break the scan in the *app* repo.** The scale set and the 700 weight
  ceiling are constants inside the app's scan engine, so changing this package's type scale or loaded
  font weights turns the app's unit suite red, not this package's.
- **The scan only sees the marker; the catalogue entry is enforced by review.** A deviation is
  sanctioned only when it has *both* a site annotation and an entry in the contract file — the marker
  alone silences the scan.

## Sanctioned deviations

A call site that intentionally departs from a rule needs a `// ds-exempt(R<n>): <reason>` comment on the
flagged line (or the immediately-preceding non-blank line — `ds-exempt(all)` exempts every rule) **and**
an entry in
[`specs/017-design-system-consistency/contracts/sanctioned-deviations.md`](../../specs/017-design-system-consistency/contracts/sanctioned-deviations.md).
That contract file, not tribal knowledge, is the single source of truth for what is an approved
exception versus a real regression; it also carries the R1 colour-utility allowlist and the "intentional
control conventions" (two-tier destructive emphasis, choice-vs-filter chips) that are deliberate
differentiation rather than drift. Adding a deviation means adding a one-line rationale there plus the
marker at the site.

## Tests that pin this package

The package's own suite (`jest.config.js`, `pnpm nx test design-system`) uses the `jest-expo` preset with
`jest/tamagui-cjs-resolver.js` — Tamagui 3 maps two subpaths' `react-native` export condition to ESM-only
`.mjs` files Jest cannot load, while Metro handles them fine, so the resolver redirects exactly those to
the CJS build. `testMatch` covers the **whole** package rather than just `components/**`, so a new test
directory cannot be silently invisible to the runner again (a `tokens/` test was once written, committed
and never executed). The same resolver is wired into the app's own Jest config
(`frontend/mcm-app/package.json` → `jest.resolver`), so both suites load Tamagui 3 identically.

Beyond the success-token and text-defaults tests, the suite covers the focus-ring and interaction-state
guards described above, the controls, navigation, the inputs and the domain cards. These tests are the
package's contract with the app: they assert the observable result (resolved theme values, rendered
style, AA contrast) rather than the implementation.

## Gotchas

- **The orange (tertiary) cap is a convention CI will not enforce.** The rule is at most 3–4 orange
  elements per screen, with sanctioned uses being the Grumpy Robot avatar, rating stars, the single
  "Add movie" call-to-action (`PillButton`, a deliberate one-off primitive rather than a `Button`
  variant, plus the `FAB`'s tertiary default), and *attention* highlights such as a media/quality
  mismatch badge. None of R1–R7 counts orange usage, so reaching for orange on a link, a background, or
  a secondary button is a design regression **that nothing will fail you for** — the asymmetry is the
  point, and the sanctioned list lives in the deviations contract.
- **Don't add a Tamagui compiler plugin or move off the exact pin incidentally.** The runtime-only
  wiring and the lockstep guard exist because both alternatives were measured and rejected; treat a
  version bump as its own change.
- **Don't flip the app's default theme or the type scale without revisiting the rationale above** —
  the first is a product decision, the second silently breaks the app's compliance scan.
- **Never import `Text` from `@tamagui/core`** — use the design system's `Text`, which carries the body
  font, `onBackground` colour and web default line height that Tamagui 3 no longer supplies from config.
  `components/text-defaults.test.tsx` fails on a core `Text` import anywhere in the package or the app.
- **Don't bump `react`, `react-native` or an Expo SDK companion in this package's manifest by hand.**
  The Renovate locks are repo-wide precisely because this manifest is where PR #217's RN bump escaped;
  moving one of them here splits React or the RN family between two manifests. The guards assert the
  lock *rules* resolve to disabled, not what this manifest declares, so a hand edit is the one route
  that gets no warning at all. Framework moves go with the app, through `expo install`.
- **Don't add a `matchFileNames` scope to the RN or Expo lock rules.** The scope is the fix, not an
  implementation detail: the app-scoped rule that predates them is what let `react-native` (and later
  the three unprefixed Expo companions) move alone. The guards resolve `enabled` per workspace
  manifest, including `pnpm-workspace.yaml`.

## Where to look next

[Expo/React Native app](./expo-app.md) for how the app wires and consumes this package (config
re-export, provider, font loading, theme preference), `packages/DESIGN-SYSTEM.md` for the full
token/component reference, and `frontend/mcm-app/README.md`'s "Design-system compliance & sanctioned
deviations" section for the app-side rule table and deviation catalogue. Test wiring for the app tiers
lives in [Testing tiers](../invariants/testing-tiers.md), and stable selectors for anything you re-skin
are covered by [Playwright testID mapping](../gotchas/playwright-testid-mapping.md). The dependency
locks that keep this package's framework versions aligned with the Expo SDK — and the guard that
asserts them — are described in [the Renovate runbook](../runbooks/renovate.md) and
[the CI/CD pipeline](./ci-cd-pipeline.md).
