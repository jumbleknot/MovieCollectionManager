---
type: Service
title: MCM Cinema design system
description: The Material Design 3 token set and Tamagui component library (@mcm/design-system) that the Expo app is built on — its theme-split colour roles, type scale, and the R1-R7 compliance scan that keeps the app from drifting off it.
resource: packages/DESIGN-SYSTEM.md
tags: [design-system, tamagui, ui, tokens, md3]
timestamp: 2026-06-14T16:26:34-04:00
---

# MCM Cinema design system

`packages/design-system` (published as the workspace package `@mcm/design-system`) is a Material
Design 3 token set plus Tamagui component library shared by both web and native builds of the
[Expo/React Native app](/openwiki/projects/expo-app.md). It exists so the app's cinematic dark-first
look (Cinematic Blue primary, restrained orange "marquee light" tertiary accent, Outfit headings /
Inter body) is expressed once, as tokens and components, rather than re-derived per screen.

Everything is imported from the package barrel (`import { Button, Card, MovieCard, lightColors,
darkColors } from '@mcm/design-system'`), and the app re-exports the shared Tamagui config rather than
authoring its own. Semantic colour roles (`primary`, `success`, `error`, `surface`, …) are
theme-split — a distinct light and dark value each — so the same token resolves to a WCAG-AA-passing
colour on both themes; the `success` role in particular exists specifically so positive/verified
states never use a raw green literal.

## Gotchas

- **Tamagui is pinned to v1 on purpose, in both the library and the app.** `expo install tamagui`
  pulls a breaking v2 by default; the compiler (babel/metro) plugins are intentionally *not*
  installed, only the runtime, to keep the Android build and the Reanimated worklets plugin
  untouched. Migrating to v2 or adding the compiler plugin is a separate, larger effort — don't do it
  incidentally while fixing something else. See [Expo/React Native app](/openwiki/projects/expo-app.md)
  for the app-side version-pin gotcha this mirrors.
- **Orange (tertiary) is capped at 3-4 elements per screen, and that's enforced by convention, not a
  lint rule.** Sanctioned uses are the Grumpy Robot avatar, rating stars, the single "Add movie" FAB,
  and format/quality-mismatch attention badges. Reaching for orange on a link, a background, or a
  secondary button is a design regression even though nothing will fail CI for it.
- **The app enforces design-system usage with a static compliance scan, not a runtime check.**
  `frontend/mcm-app/tests/unit/design-system-compliance.test.ts` runs seven rules (R1-R7: no hardcoded
  colour, MD3 font-size scale only, explicit Outfit/Inter family on styled text, no bespoke touchable
  in place of DS `Button`/`Chip`, no duplicated pill-button style, no synthesized font weight above
  700, no raw `<Modal>` in place of DS `Dialog`) as part of the normal `pnpm nx test mcm-app` suite —
  a change to the design system's font weights or type scale can silently break this scan in the
  *app* repo, not this one.
- **A deliberate deviation from the system must be marked, not just written.** A call site that
  intentionally departs from a compliance rule needs a `// ds-exempt(R<n>): <reason>` comment *and* an
  entry in `specs/017-design-system-consistency/contracts/sanctioned-deviations.md` — that file, not
  tribal knowledge, is the single source of truth for what's an approved exception versus a real
  regression.
- **`dark` is the recommended default theme**, chosen because the product is a movie-collection app —
  don't flip the app's default theme without revisiting this rationale.

See [Expo/React Native app](/openwiki/projects/expo-app.md) for how the app wires and consumes this
package, `packages/DESIGN-SYSTEM.md` for the full token/component reference (colour roles, spacing,
elevation, motion, and every component's props), and `frontend/mcm-app/README.md`'s "Design-system
compliance & sanctioned deviations" section for the full R1-R7 rule table and deviation catalogue.
