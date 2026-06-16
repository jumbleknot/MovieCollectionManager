# Contract — Sanctioned deviations (preserved, documented)

These intentional departures from the default DS pattern are PRESERVED by this feature and form the compliance-scan allowlist. Each must remain unchanged (FR-015 / SC-008).

## Controls

| # | Deviation | Where | Rationale |
|---|-----------|-------|-----------|
| 1 | `NoAutoFillInput` instead of DS `TextField` | all form text inputs except `register-form` | password-manager autofill suppression (project decision) |
| 2 | Radio-button selectors instead of native picker | `movie-form` content-type + USA-rating | `@react-native-picker/picker` crashes on Android new arch |
| 3 | Whole-card / whole-row press wrapper | `collection-card`, native movie cards, `movie-list-item` row | tap-to-navigate affordance, not a button |
| 4 | Assistant dock custom toggle (bottom-LEFT) | `assistant-dock` | a bottom-right control intercepts form Save buttons (015 regression); frozen testID/behaviour |
| 5 | Removable list chips | `movie-form` directors/actors/genres/tags | DS has no removable-chip variant yet → DS backlog, out of scope here |

## Colour-utility allowlist (R1)

- `'transparent'` — non-colour utility.
- `outlineStyle: 'none'` — web focus-ring suppression (not a colour).
- Any additional literal MUST be added here with a one-line justification AND annotated at the call site.

## Accent / typography

| Deviation | Rationale |
|-----------|-----------|
| Orange (`tertiary`) accent on media↔quality mismatch + collection CTA pill + count + `AssistantAvatar` | FR-010 / SC-005 sanctioned sparing orange |
| Web data-table title `14` vs native card title `16` (and table vs card density) | R7 platform-appropriate density — sizes still on-scale |

## Rule

Anything NOT listed here MUST comply with the design system. Adding a new deviation requires a one-line rationale here + a justifying comment at the site.
