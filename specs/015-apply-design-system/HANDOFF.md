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

Phase 1 (T001–T004) + Phase 2 (T005–T010) **DONE**. Phase 3 (US1): **T015 collection-card
re-skinned** (the exemplar). The DS type-hardening spans the *intent* of T011–T013 but **without**
the per-component RED→GREEN unit tests those tasks asked for (only a Button smoke + testID-forward
test exist). ~6 US1 app components + US2–US4 remain.

---

## 🚨 #1 THING TO KNOW — Metro dev web E2E is dead; use the dev-container

**Metro's *dev* web bundler cannot build this app + Tamagui on this machine.** Confirmed across 8 GB
heap, `@tamagui/babel-plugin`, AND lean imports — the **client** bundle OOMs (exit 134) every time an
E2E navigates to a route that bundles a DS component. The server bundle compiles fine (~44 s); the
client JS bundle (CopilotKit + reanimated + Tamagui + app) is just too big for Metro DEV (which
doesn't tree-shake). The auth E2E passed 31/31 only because it never hits a DS-component route.

**DO NOT keep retrying `pnpm nx e2e mcm-app` against Metro** — it will OOM. **Validate web E2E via the
dev-container** (`expo export` = production-mode, tree-shaken, memory-bounded — the repo's canonical
deterministic E2E):

```bash
pnpm nx docker-build mcm-app                 # builds mcm-bff:latest incl. expo export (prod, tree-shaken)
docker compose --profile bff-dev up -d       # dev BFF on :8082
E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app -- tests/e2e/web/collections.spec.ts
```

**FIRST UNVERIFIED ASSUMPTION to check in the new session:** does `pnpm nx docker-build mcm-app`
(the `expo export` inside it) succeed without OOM? Prod export tree-shakes and the Dockerfile can set
`NODE_OPTIONS`, so it *should*, but it has not been run since the Tamagui changes. If the export also
OOMs, bump `NODE_OPTIONS=--max-old-space-size=8192` in the build step. This is the gating unknown for
all web-E2E validation of the feature.

(Stop-gap proof that re-skins work without web E2E: `tsc --noEmit` + the unit tests, which render
real Tamagui via `@/test-support/render`. `collection-card` is proven this way — 40 unit tests — but
NOT yet web-E2E'd.)

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

1. **Verify the dev-container web-E2E path works** (the gating unknown): `pnpm nx docker-build
   mcm-app` (watch for OOM in `expo export`; add `NODE_OPTIONS=--max-old-space-size=8192` to the
   build if needed) → `docker compose --profile bff-dev up -d` → `E2E_BFF_TARGET=dev-container pnpm
   nx e2e mcm-app -- tests/e2e/web/collections.spec.ts`. This validates `collection-card` end-to-end
   and confirms the validation path for the whole feature.
2. **Finish US1 re-skin** (tasks T014, T016–T021), same pattern as `collection-card`:
   `collection-list(.native)`, `home-screen`, `movie-list` (web data table in the **default**
   `movie-list.tsx` + `movie-list.native.tsx` card list — see research R7), `movie-list-item`
   (+ media≠quality orange `FormatBadge`), app chrome (`navigation-bar` + `(app)/_layout` AppBar),
   `collection-screen`. Re-skin each, fix its unit test's render import, keep tsc 0 + selector guard,
   then dev-container E2E for `collections.spec.ts` + `movies.spec.ts`.
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
