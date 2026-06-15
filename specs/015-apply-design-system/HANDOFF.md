# Feature 015 — Apply MCM Cinema Design System · HANDOFF

**Branch:** `015-apply-design-system` · **Last updated:** 2026-06-14

Read this first, then `plan.md`, `research.md`, `contracts/ui-contracts.md`. Project memory also
carries the durable gotchas: `project_mcm_015_design_system.md`.

---

## TL;DR — where we are

UI-only re-skin of `mcm-app` (web + Android) onto the prebuilt `packages/design-system/` (Tamagui
v1 / MD3, dark-first). **Foundation + DS hardening + the first re-skinned component are done and
committed.** The remaining work is mechanical re-skinning of ~6 more US1 components, then US2–US4 +
audits + APK — BUT there is **one environment blocker you must route around** (Metro dev web E2E
OOMs; use the dev-container path — see below).

### Commits on the branch (all tsc-clean + unit-green)

| Commit | What |
|---|---|
| `855df86` | Foundation: `packages/*` in workspace, `@mcm/design-system` as `workspace:*`, Tamagui v1.144 (runtime), `use-theme` hook (device-local dark/light), `TamaguiProvider`+`ThemeProvider` in `src/app/_layout.tsx`, fonts (Outfit/Inter), DS Nx project + jest. |
| `1dc68ee` | **DS hardened strict-clean (255→0 TS6 errors)** + `collection-card.tsx` re-skinned + `src/test-support/render.tsx` test helper. |
| `22666aa` | Lean Tamagui imports (`@tamagui/core`+`@tamagui/stacks`, dropped the heavy `tamagui` meta-package) + `@tamagui/babel-plugin`. |

Also: constitution amended to **v2.3.0** (Design System principle + Tamagui stack entry) — committed
separately (check `git log .specify/memory/constitution.md`). Spec/plan/tasks/analyze committed by the
speckit hooks (`7c94701`, `2afdbd8`).

### Status vs tasks.md

Phase 1 (T001–T004) + Phase 2 (T005–T010) **DONE**. **Phase 3 / US1 (T014–T021) DONE + web-E2E
green** (collections 19/19 + movies 61/61, dev-container; selector guard 194/194; unit 1035/1035;
tsc 0; lint clean — commit `3453431`). The app-side US1 re-skin is complete: app chrome,
collection-card, home + collection-list(.native), movie-list(.native) + movie-list-item (mismatch),
collection-screen.

**Phase 4 / US2 (T024–T031) DONE + web-E2E green** (auth + movies + collections = **101/101**,
dev-container; selector guard 194/194; unit 1035/1035; commit `979c71b`). Forms/inputs/dialogs/auth/
movie-detail all re-skinned. **Pattern note:** most US2 surfaces were *restyled in place* with a
`makeStyles(theme)` token conversion (+ DS `Button` where the destructive/loading-spinner-testID
constraints allowed) rather than swapping to DS `TextField`/`Dialog` wholesale — because (a) the
`NoAutoFillInput` password-manager suppression is a project design decision, (b) DS `Dialog` can't
forward the `delete-dialog`/`logout-dialog` testIDs, and (c) destructive buttons need error/onError
tokens DS `Button` doesn't expose. This satisfies "apply the design system" via tokens + DS Button.

**DS Button got a real a11y fix in US2** (T022): it now emits `role="button"` + `aria-disabled` to
the DOM on web (Tamagui translates `accessibilityLabel`→`aria-label` but NOT
`accessibilityRole`/`accessibilityState`), so a loading button is observable as disabled. Required
both the role AND aria-disabled for Playwright `toBeDisabled()`.

Still open: **T011–T013 / T022–T023** dedicated per-DS-component RED→GREEN tests (components are
type-hardened + render-proven via consumers, not via their own `*.test.tsx`). **US3 assistant**
(T032–T035), **US4 theme toggle** (T036–T039), **Polish** (T040–T048) remain. Manual visual +
Android pass deferred to checkpoint / T041 APK + T044 audit.

---

## 🚨 #1 THING TO KNOW — Metro dev web E2E is dead; use the dev-container (PROVEN working)

**Metro's *dev* web bundler cannot build this app + Tamagui on this machine.** Confirmed across 8 GB
heap, `@tamagui/babel-plugin`, AND lean imports — the **client** bundle OOMs (exit 134) every time an
E2E navigates to a route that bundles a DS component. **DO NOT keep retrying `pnpm nx e2e mcm-app`
against Metro** — it will OOM.

**The dev-container path is now PROVEN end-to-end (US1, 2026-06-15).** `expo export` is
production-mode (tree-shaken, memory-bounded) and does **NOT** OOM (~32 s, no `NODE_OPTIONS` bump
needed). The gating unknown is resolved.

> **Dockerfile fix that unblocked it (committed):** the Dockerfile predated 015 and never copied
> `packages/*`, so the in-Docker `pnpm install --frozen-lockfile` failed with
> `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND` for `@mcm/design-system`. Both build stages now
> `COPY packages/design-system/ ...` (the DS `main` is `index.ts`, consumed as source — Metro/export
> transpiles it and `pnpm deploy --prod` materializes it). Don't remove these copies.

Canonical web-E2E loop for any 015 re-skin (rebuild the image after EVERY source change — the
container serves the prebuilt bundle, so a stale image silently tests old code):

```bash
pnpm nx docker-build mcm-app                              # rebuild incl. expo export (~prod)
docker compose --profile bff-dev up -d mcm-bff-dev        # recreate dev BFF on :8082 with new image
E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app -- tests/e2e/web/<spec>.spec.ts
```

US1 result: **collections.spec.ts 19/19 + movies.spec.ts 61/61 green** (dev-container).

> **Durable nested-pressable bug (fixed in collection-card):** a DS `Button`/pressable nested inside
> a pressable card wrapper bubbles its press on web (Tamagui `onPress` → DOM click bubbles to the
> wrapper's `onClick`). collection-card's action buttons were navigating away (firing the card's
> `onOpen`) on Set-default/Edit/Delete. Fix = `e.stopPropagation()` in each nested action's `onPress`.
> Watch for this on any re-skin that nests interactive DS components inside a pressable surface.

> **Durable jest platform resolution:** jest-expo resolves the `.native.tsx` variant. After adding
> `movie-list.native.tsx`, the shared `movie-list.test.tsx` started loading the native card list (no
> per-column header) — so web-table-header assertions had to move to the web E2E (`movie-list-header`).
> When you add a `.native` override, re-check the shared unit test resolves the variant you expect.

(Stop-gap proof without web E2E remains: `tsc --noEmit` + unit tests rendering real Tamagui via
`@/test-support/render`.)

---

## How to re-skin a component (the established pattern)

The mandate: **restyle in place, preserve every `testID`, prop, and interaction** (FR-002 no
behaviour change, FR-018 selectors). Do NOT adopt the DS domain components' divergent UX wholesale.
`collection-card.tsx` is the worked exemplar — copy its approach.

1. Import layout/primitives leanly: `import { Text, useTheme } from '@tamagui/core'`,
   `import { XStack, YStack } from '@tamagui/stacks'`, and DS components from `@mcm/design-system`
   (e.g. `Button`). **NEVER `from 'tamagui'`** (pulls the heavy meta-package → OOM).
2. Keep the component's structure + every `testID`/`accessibilityLabel`/`accessibilityRole`. Tamagui
   forwards `testID` to the DOM (`data-testid` on web) automatically — verified.
3. Style with theme tokens via `theme.<role>?.val` (note the `?.` — Tamagui theme values are
   optionally typed) or `$token` strings. Use numeric spacing/radius (e.g. `padding={16}`,
   `borderRadius={12}`) like the DS components do.
4. **Its unit test must import `render` from `@/test-support/render`** (wraps `TamaguiProvider`), or
   `useTheme()` throws "must be used within…". Repoint the test's `@testing-library/react-native`
   import.
5. Verify: `cd frontend/mcm-app && pnpm exec tsc --noEmit` (must stay 0) →
   `pnpm nx test mcm-app -- --testPathPattern <comp>` → selector guard (below) → eventually the
   dev-container web E2E for the touched story.

### Selector-preservation guard (run after each re-skin)
```bash
# regenerate and diff against the committed baseline — ZERO removed testIDs allowed
# baseline: specs/015-apply-design-system/contracts/selectors-baseline.txt (194 testIDs)
```
Use PowerShell to regen (rg is proxied to grep here and mangles `-o`):
`Get-ChildItem -Recurse frontend/mcm-app/src -Include *.tsx | ? {$_.FullName -notmatch 'unit-tests'} | Select-String 'testID="([a-z0-9-]+)"' -AllMatches | % {$_.Matches} | % {$_.Groups[1].Value} | Sort-Object -Unique`

---

## Durable gotchas (all already applied in the committed code — don't re-discover)

- **Pin Tamagui v1** (`^1.144.0`). `expo install tamagui` pulls breaking v2; the DS is v1-authored.
- **DS strict-clean fixes** (TS 6.0.3 is the repo's TS): `theme.X.val`→`theme.X?.val`; `elevation`
  is invalid in `pressStyle`/`hoverStyle` and on base `Stack` → use `style={{elevation:n}}` (`YStack`
  accepts it directly); RN `ScrollView` `flex`→`style`; RN 0.85 changed `TextInput` onFocus/onBlur
  event types → derive handler type from `TextInputProps['onFocus']`; the `createTamagui` ↔
  `TamaguiCustomConfig` ↔ `typeof config` type circularity is avoided by **omitting** the module
  augmentation (`packages/design-system/tamagui-types.d.ts` is an intentional no-op; documented
  tradeoff = less token autocomplete, no runtime effect).
- **DS jest config** uses the 2-pattern pnpm `transformIgnorePatterns` (+ `@tamagui|tamagui`).
- **babel.config.js** has `@tamagui/babel-plugin` **excluded under `NODE_ENV=test`** so the unit
  suite renders Tamagui at runtime unchanged; worklets plugin stays LAST. `.tamagui/` is gitignored.
- **`movie-detail-screen.test.tsx` flakes** in the full unit run (worker memory pressure from the
  Tamagui-heavy suites) but passes 12/12 in isolation — not a regression. If it bugs you, consider
  `maxWorkers` in the unit run.

---

## Next steps (ordered) for the fresh session

1. ~~Verify the dev-container web-E2E path~~ **DONE** — proven green (US1). Always rebuild the image
   + recreate `mcm-bff-dev` before each dev-container E2E run.
2. ~~Finish US1 re-skin~~ **DONE + E2E green** (commit `3453431`). Pattern for the rest, same as US1:
   re-skin in place → import `useTheme`/DS components leanly (NEVER `from 'tamagui'`) → repoint the
   unit test's render import to `@/test-support/render` → `tsc 0` + selector guard 194/194 → rebuild
   image + dev-container E2E for the touched story.
3. **US2 forms** (T022–T031), **US3 assistant** (T032–T035), **US4 theme toggle** (T036–T039),
   **Polish** (T040–T048: a11y/48dp audit, responsive/dock audit, orange-accent audit, font-fallback,
   bundle/TTI, APK rebuild via CI, full E2E, docs).
4. **DS per-component unit tests** (T011–T013 intent) if you want the RED→GREEN coverage the tasks
   specified — currently only type-hardened + smoke.
5. **APK rebuild** before any mobile E2E (`react-native-svg` + new deps are native): CI
   `gh workflow run android-apk.yml --ref 015-apply-design-system`. **Also verify the babel-plugin +
   v1 Tamagui don't break the Android build** (not yet checked — do it via CI early).

---

## Quick reference

- Re-skin exemplar: `frontend/mcm-app/src/components/collection-card.tsx`
- Test helper: `frontend/mcm-app/src/test-support/render.tsx`
- Theme hook: `frontend/mcm-app/src/hooks/use-theme.tsx` (key `mcm.theme`, dark default)
- Tamagui config: `packages/design-system/tamagui.config.ts` (+ no-op `tamagui-types.d.ts`)
- Selector baseline: `specs/015-apply-design-system/contracts/selectors-baseline.txt`
- Screen→DS-component map + stable-selector contract: `contracts/ui-contracts.md`
- Verify commands: `pnpm exec tsc --noEmit` (from `frontend/mcm-app`); `pnpm nx test mcm-app`;
  `pnpm nx test design-system`; web E2E via the **dev-container** only (above).
- Design source of truth: `packages/DESIGN-SYSTEM.md`, mock-up `docs/MCM-Redesign-Mockup.html`.
