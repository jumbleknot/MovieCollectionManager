# Contract — Machine-checkable DS compliance rules

Enforced by `frontend/mcm-app/tests/unit/design-system-compliance.test.ts` (the RED→GREEN driver) over `frontend/mcm-app/src/**` (excluding `bff-server`/`bff-api`/tests/`__mocks__`).

## R1 — No hardcoded colour (SC-001)

FAIL if any non-allowlisted colour literal appears in app source:
- patterns: `#[0-9a-fA-F]{3,8}` in a style/colour context, `rgb(`, `rgba(`, `hsl(`.
- allowlist: `transparent`; `outlineStyle:'none'`; any entry explicitly added to `contracts/sanctioned-deviations.md` § colour-utility allowlist with a justifying comment.

## R2 — On-scale fonts (SC-002)

FAIL if any numeric `fontSize` is not in `{11,12,14,16,18,22,24,28,32,36,45,57}`.

## R3 — Declared font family (SC-002)

WARN/FAIL (best-effort) if a text style sets `fontSize`/`fontWeight` but no `fontFamily` resolving to Outfit/Inter (`'Outfit'`/`'Outfit-*'`/`'Inter'`/`'Inter-*'` or Tamagui `$heading`/`$body`).

## R4 — No bespoke buttons (SC-003)

FAIL if a `TouchableOpacity`/`Pressable` is styled as a button (has an `onPress` + button-like style: background + padding/borderRadius + a `Text` label) UNLESS the file/usage is in the sanctioned-deviation allowlist (radios, card/row press wrappers, dock toggle, removable list chips).

## R5 — No duplicated bespoke control style (SC-003)

FAIL if the same private button style block appears in more than one agent component (the triplicated pill style must be gone).

## R6 — No synthesized font weight (consistency follow-up)

FAIL if any numeric `fontWeight` is **> 700**. Both Outfit and Inter load faces 400/500/600/700 only; an `800`/`900` weight has no real face and is synthesized by the renderer (a smell, and inconsistent across platforms). Use the heaviest loaded face (700). Exempt with `ds-exempt(R6)`.

## R7 — No re-invented DS surface (consistency follow-up)

FAIL if app source renders a raw `<Modal>` — the DS `Dialog` is the canonical confirmation/alert surface. Full-screen *form* modals (a different pattern — e.g. the home-screen create/edit collection `pageSheet`) are exempt with `ds-exempt(R7): <reason>` at the call site. (SearchBar/Snackbar re-inventions are tracked as triage, not yet scan-enforced — see sanctioned-deviations.md.)

## Output

On failure the test prints a per-violation list `file:line — rule — snippet`, so the migration can be driven to GREEN file-by-file. The allowlist lives beside the test and is derived from `contracts/sanctioned-deviations.md`.
