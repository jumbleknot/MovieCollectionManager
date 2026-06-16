# Phase 0 Research — Design-System Consistency Remediation

No `NEEDS CLARIFICATION` remained from the spec (scope + success-token decision were confirmed). This records the design decisions that shape the plan.

## D1 — The new `success` colour role (tones + AA)

**Decision**: Add `success` the same way every existing semantic role is defined — a green tonal ramp in `palette.ts`, then role mappings in `colors.ts` (light + dark), `theme.ts`, and the `tamagui.config.ts` colour-token map. Roles: `success`, `onSuccess`, `successContainer`, `onSuccessContainer` (mirrors `primary`/`tertiary`/`error`).

Anchor tones (final values verified by the DS contrast test + axe scan — tune the ramp if any assertion fails):

| Role | Light | Dark | Used for |
|------|-------|------|----------|
| `success` | `#1B6E2E` (dark green) | `#7FD98C` (light green) | "Yes"/verified TEXT on a surface (AA ≥4.5:1) |
| `onSuccess` | `#FFFFFF` | `#06270D` | text/icon ON a success-filled element |
| `successContainer` | `#B7F0BE` | `#1B5E20` | success banner/badge background |
| `onSuccessContainer` | `#06270D` | `#B7F0BE` | text on the container |

**Rationale**: a single hue cannot meet AA on both a near-white and a near-black surface (the exact problem that forced the hand-patched movie-detail green in 015), so the role is theme-split like all the others — dark green on light, light green on dark. **Alternatives rejected**: (a) one fixed green everywhere — fails AA on one theme; (b) reuse `tertiary` (orange) — wrong semantics; (c) per-site `isLightSurface()` luminance branch (the 015 stopgap) — duplicates theme logic at call sites instead of centralising it in the token.

**Consumers**: email-verification "verified" banner + text, sign-in verified banner, movie-detail Owned/Ripped "Yes" — all switch from literals to `$success`/`successContainer`.

## D2 — Font faces vs declared weights (FR-008)

**Finding**: the DS loads Outfit at 400/500/600/700 but **Inter only at 400/500**. Any Inter text declared `fontWeight 600/700` (e.g. form labels at 600) currently **synthesizes** bold — and the nav wordmark uses Outfit `800` which has no face at all.

**Decision**: (a) add **Inter-SemiBold (600)** and **Inter-Bold (700)** faces to the DS `interFont` definition and the app `useFonts` map, so the existing MD3 label/title weights render real faces; (b) change the nav wordmark `800 → 700` (Outfit-Bold is loaded). **Rationale**: prefer real faces over synthesized weights for crispness and cross-platform parity; capping every weight at 500 would visibly flatten the type hierarchy. **Alternative rejected**: drop all 600/700 to 500 — loses intended emphasis.

## D3 — Off-scale font-size mapping

| Found | → Snap to | Role |
|-------|-----------|------|
| `17` (collection-card title) | `16` | title-medium |
| `17` (login/create-account button labels) | (removed — DS Button sets its own size) | — |
| `20` (collection-screen name, home modal titles, collection-list empty headings) | `22` | title-large / headline |
| `26` (profile heading) | `24` | headline-small |
| `10` (agent micro-labels) | `11` | label-small |

## D4 — Unified "section/column header" treatment (FR-012)

**Decision**: one header-label style across the web movie table and the native list — **Inter (label) · 12 · weight 500 · colour `primary` · letterSpacing 0.5**, over the existing 2dp `primary` bottom border. **Rationale**: the primary-accent header reads as a column header and matches the app's primary-accent convention (column toggle, active chips); weight 500 is the heaviest **loaded** Inter face after D2 keeps it real (the old `800`/`700` synthesized). **Alternative rejected**: neutral `onSurfaceVariant` header — less distinctive and inconsistent with the rest of the app's accenting.

## D5 — Bespoke-button migration + agent de-duplication (FR-009/FR-011)

**Decision**: replace every bespoke `TouchableOpacity`/`Pressable` styled as a button with DS `Button` (variants), `IconButton`, or `Chip`, preserving each `testID` via `...rest` forwarding. The agent layer's pill style — copy-pasted across `approval-request`, `import-preview`, `request-import-file` — collapses to DS `Button` (filled/outlined) using the DS `loading` prop for the "Uploading…/Applying…" disabled state. **`approval-request`** additionally evaluates the DS `ApprovalBubble` (which already models title/description/approve/reject/loading/done); adopt it if it can carry the existing testIDs, else use plain DS `Button`s. **Rationale**: one button implementation, zero duplication; the DS already ships everything needed. **Constraint**: keep the assistant dock bottom-LEFT (a bottom-right control intercepts form Save buttons — documented 015 regression).

## D6 — Dead-literal removal is behaviour-neutral

**Finding**: home-screen, collection-screen, movie-detail-screen, and `(app)/_layout.tsx` declare hex in their StyleSheets that is **shadowed at the JSX site by an inline `theme.*` override**, so it never renders. **Decision**: delete the dead hex (keep the inline token). **Rationale**: the declared style should equal the rendered colour; the literal is a trap (a future edit removing the inline override would resurrect the wrong colour). This is a maintainability/correctness cleanup with no visible change — verified by the unchanged screenshots/contrast scan.

## D7 — Test strategy (TDD driver)

**Decision**: a new **static DS-compliance Jest scan** (`tests/unit/design-system-compliance.test.ts`) is the RED→GREEN instrument. It asserts, over `frontend/mcm-app/src`:
1. **No hardcoded colour** — no `#rgb`/`#rrggbb`/`#rrggbbaa`/`rgb()`/`rgba()` in app source, except an explicit allowlist (`transparent`, and any justified entry).
2. **On-scale fonts** — every numeric `fontSize` ∈ {11,12,14,16,18,22,24,28,32,36,45,57}.
3. **Declared font family** — text styles declare Outfit/Inter (no implicit system fallback) — best-effort heuristic.
4. **No bespoke buttons** — flag `TouchableOpacity`/`Pressable` used as a button outside the sanctioned-deviation allowlist (radios, card/row press wrappers, dock toggle).

Plus: a **DS unit token test** (success roles present + axe-style AA contrast check on both themes), the existing **Playwright a11y/contrast/responsive/font-fallback** audits (extended to assert the verified/"Yes" success colour), the **194-testID selector baseline**, and the **dev-container web-E2E** regression. **Rationale**: the static scan makes SC-001/002/003 measurable and verifiable-RED before the migration; it doubles as a permanent guard against re-introduction. **Alternative rejected**: an ESLint custom rule — heavier to author and the scan gives a clearer per-violation failure list.

## D8 — Gate path (Metro OOM constraint)

**Decision**: web E2E only via the **dev-container** (`pnpm nx docker-build mcm-app` → `docker compose --profile bff-dev up -d --force-recreate mcm-bff-dev` → `E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app`); rebuild the image after each app-source change. Unit/DS/static-scan run on Metro/Jest normally. Mobile (Maestro) is **not** a gate here (issue #16). **Rationale**: the Metro web bundler OOMs with Tamagui on this machine (documented 015 constraint); the production `expo export` in the container does not.
