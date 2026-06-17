# Contract — Sanctioned deviations (preserved, documented)

These intentional departures from the default DS pattern are PRESERVED by this feature and form the compliance-scan allowlist. Each must remain unchanged (FR-015 / SC-008).

> **Enforcement mechanism.** The static scan (`tests/unit/design-system-compliance.test.ts`)
> recognises a `// ds-exempt(R<n>): <reason>` comment on a flagged line (or the immediately
> preceding non-blank line) and skips it for that rule. `ds-exempt(all)` exempts every rule. The
> sanctioned sites below carry such an annotation at the call site (single source of truth: a
> deviation needs BOTH a catalogue entry here AND a site annotation).

## Controls

| # | Deviation | Where | Rationale | Scan handling |
|---|-----------|-------|-----------|---------------|
| 1 | `NoAutoFillInput` instead of DS `TextField` | all form text inputs except `register-form` | password-manager autofill suppression (project decision) | not a button/colour — not scanned |
| 2 | Radio-button selectors instead of native picker | `movie-form` content-type + USA-rating | `@react-native-picker/picker` crashes on Android new arch | `ds-exempt(R4)` at the 3 radio sites |
| 3 | Whole-card / whole-row press wrapper | `collection-card`, native movie cards, `movie-list-item` row, `render-movie-card` card, nav links | tap-to-navigate affordance, not a button (no button-fill style → not flagged by R4) | auto-excluded by R4's button discriminator |
| 4 | Assistant dock custom toggle (bottom-LEFT) | `assistant-dock` | a bottom-right control intercepts form Save buttons (015 regression); frozen testID/behaviour | plain-object styles (not `StyleSheet.create`) → not flagged; behaviour frozen |
| 5 | Removable list chips | `movie-form` directors/actors/genres/tags | DS has no removable-chip variant yet → DS backlog, out of scope here | bare `×` press (no button fill) → not flagged by R4 |

### Intentional control conventions (consistency follow-up)

These are deliberate, documented differences — *intentional* differentiation, not drift:

- **Destructive emphasis is two-tier (by surface density).** A **standalone** destructive action on a
  detail surface or dialog uses **`Button … danger`** filled-red (`movie-detail` Delete,
  delete/logout dialog confirm) — it's the prominent primary on a 2-action surface. An **inline**
  destructive action inside a **dense multi-action row** uses **`Button variant="outlined" … danger`**
  red-outline (`collection-card` Delete, sitting beside Open/Edit/Set-default) — a solid-red button
  among 3 outlined siblings would be visually unbalanced. Both are the error palette; only the
  emphasis (fill vs outline) changes with context. Size also tracks surface: `md` on detail screens,
  `sm` in card action rows.
- **Filter chips are single-select "choice chips" per category** (`movie-filter-panel`). Each
  category (Type/Owned/Media/Ripped/Quality/Genre/Decade/Language/Rated) holds ONE active value —
  picking another replaces it; re-tapping clears it. They render as DS `Chip type="filter"` (an MD3
  choice-chip pattern, single-select) intentionally — radios in a horizontally-scrolling filter bar
  read worse. This is distinct from the **multi-value** form fields (owned-media, rip-quality) which
  use the same chip for genuine multi-select, and from single-value FORM INPUTS which use radios.
  (A future feature could make filtering genuinely multi-value per category; until then it is
  single-select by design.)

## Colour-utility allowlist (R1)

- `'transparent'` — non-colour utility (a word, not matched by the hex/rgb/hsl scan).
- `outlineStyle: 'none'` — web focus-ring suppression (not a colour).
- The dialog scrim overlays derive their tint from `theme.scrim?.val` (no literal fallback), so
  R1 needs **no** hardcoded-colour exemptions — every colour now flows through a theme token.
- Any additional literal MUST be added here with a one-line justification AND a `ds-exempt(R1)`
  annotation at the call site.

## Accent / typography

| Deviation | Rationale |
|-----------|-----------|
| Orange (`tertiary`) accent on media↔quality mismatch + collection CTA pill + count + `AssistantAvatar` | FR-010 / SC-005 sanctioned sparing orange |
| Orange (`tertiary`) for the **medium** password-strength step (weak → `error`, medium → `tertiary`, strong → `success`) | semantic weak/medium/strong meter; the only amber in the MD3 set is `tertiary`; AA-safe on the form surface |
| Web data-table title `14` vs native card title `16` (and table vs card density) | R7 platform-appropriate density — sizes still on-scale |
| Decorative email-verification ✉ icon at `57` (an MD3 scale step) with `fontFamily:'Inter'` | a single decorative glyph; snapped onto the scale so R2 stays clean (the emoji renders from the system emoji font regardless of family) |

## Surfaces (R7) — re-invented vs sanctioned

| Surface | Status | Where | Rationale |
|---|---|---|---|
| Confirmation dialogs | **Adopted DS `Dialog`** | `delete-/logout-confirmation-dialog.tsx` | consistency follow-up — replaced the bespoke `Modal` shells |
| "Default" status pill | **Adopted DS `Badge`** (new `inline` mode) | `collection-card.tsx` | consistency follow-up — replaced the ad-hoc primary pill |
| Full-screen create/edit form modal | **Sanctioned** `ds-exempt(R7)` | `home-screen.tsx` (`pageSheet` Modal) | a full-screen form, NOT a centered DS `Dialog` confirmation |
| Search bar | **Triage** (not yet adopted) | `movie-search-bar.tsx` | wraps `NoAutoFillInput` for password-manager suppression — DS `SearchBar` adoption needs that hook first |
| Status banners | **Triage** (not yet adopted) | auth/home/form error+success banners | these are *persistent inline* notices, not transient `Snackbar` toasts — adopt only if behaviour changes |

## Typography weights (R6)

Outfit + Inter load faces 400/500/600/700 only. Headings use `Outfit-Bold`/700 (RN) or `$heading`+weight (Tamagui); card titles use 600 (`Outfit-SemiBold`). No `fontWeight > 700` (synthesized).

## Rule

Anything NOT listed here MUST comply with the design system. Adding a new deviation requires a one-line rationale here + a `ds-exempt(R<n>)` comment at the site.
