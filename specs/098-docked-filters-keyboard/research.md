# Research: Docked view options and keyboard-safe assistant

All findings are from the code at `origin/main` `0ab6a2f1`, unless marked **to confirm**.

## R1. Why the keyboard covers the assistant

**Finding.** `AssistantDock` ([assistant-dock.tsx](../../frontend/mcm-app/src/components/agent/assistant-dock.tsx))
is `position: absolute; left: 16; bottom: 16`. The panel inside it
([assistant-panel.tsx](../../frontend/mcm-app/src/components/agent/assistant-panel.tsx), `styles.panel`) has a
fixed `width: 320, height: 420`, and the input row is its last child. No code in `src/` uses `Keyboard`,
`KeyboardAvoidingView` or a keyboard library. `app.json` sets no `softwareKeyboardLayoutMode`.

On SDK 58 / React Native 0.88, Android runs edge-to-edge. In that mode the window is not resized for the
IME, so a view pinned to the window's bottom edge stays behind the keyboard. **To confirm** in T001 by
reproducing on the emulator before any fix. That run is the Verify RED.

**Decision.** Add a small `useKeyboardInset()` hook built on React Native's `Keyboard` API
(`keyboardDidShow`/`keyboardDidHide` on Android, `keyboardWillShow`/`keyboardWillHide` on iOS). It returns the
keyboard height, and 0 on web or when the keyboard is hidden. The dock adds that height to its `bottom`
offset. The panel's height becomes
`min(420, windowHeight − keyboardHeight − topSafeInset − toggleHeight − margins)`, so on a small phone it
shrinks instead of running off the top (FR-013). When the inset changes, the existing scroll-to-latest
callback runs again (FR-012).

**Rationale.** It needs no new native dependency, so there is no prebuild change and no extra cost for the
mobile CI build. It does not touch the web entry chunk beyond a few hundred bytes. Its behaviour is
explicit and unit-testable by emitting `Keyboard` events.

**Alternatives rejected.**
- `KeyboardAvoidingView`: built for in-flow content. Around an absolutely positioned overlay under Android
  edge-to-edge its `padding`/`height` behaviours are unreliable, and its `behavior` differs per platform
  with no single correct value.
- `react-native-keyboard-controller`: the most capable option, but it is a new native module for one input
  field. It also needs a rebuilt development client and adds to the dependency-audit surface.
- `softwareKeyboardLayoutMode: "resize"`: edge-to-edge does not honour it, and it would change every
  screen's layout, not just the dock's.

## R2. How "one panel open at a time" (FR-015) crosses two components

**Finding.** The dock's `open` is local `useState`. The dock is mounted in `src/app/(app)/_layout.tsx`, and the
collection screen renders under the same layout. `use-ui-state.tsx` is the existing pattern for a small
layout-level context.

**Decision.** Add an `OpenPanelProvider` context in `src/hooks/use-open-panel.tsx`. It holds
`openPanel: 'assistant' | 'view-options' | null` and is mounted in `(app)/_layout.tsx` around the stack and
the dock. Each control derives `open` from it, so opening one closes the other.

**Constraint.** The provider module must import nothing from the assistant runtime. Feature 077's
`bundle-budget` gate fails if `@copilotkit/*` reaches the entry chunk, and this file is in that chunk.

**Alternatives rejected.** A module-level event emitter also works, but it is hidden global state and
unit tests would have to reset it. Lifting state into the screen fails because the dock lives in the
layout, not in any screen.

## R3. Where the drop-down renders

**Decision.** In `collection-screen.tsx`, the `ColumnSelector`, `MovieSortControl` and `MovieFilterPanel`
block is replaced by a new `ViewOptionsDock` bar. The count row and the list are wrapped in one `flex: 1`
container. When the bar is open, a `ViewOptionsPanel` renders `position: absolute; top: 0; left: 0;
right: 0` inside that container, with a raised `zIndex`/elevation and design-system surface and elevation
tokens. Its maximum height is the container's height, and its content sits in a `ScrollView` (FR-005a).
The list is never re-laid-out, so its scroll position is kept.

The three existing components are reused unchanged inside the panel. The filter panel already scrolls
internally.

**Alternatives rejected.** A `Modal` covers the bar it drops from and the search row, and on web it moves
focus to a portal outside the screen. An inline accordion was rejected in clarify (Q4).

## R4. Re-docking and Android Back (FR-007)

**Decision.** While the panel is open, register a `BackHandler` listener (native only) that closes it and
returns `true`, so the router does not pop. On web, Escape closes it. Both are removed on close. This is the
first `BackHandler` use in `src/`.

## R5. Accessibility (FR-016)

**Decision.** The bar is an `accessibilityRole="button"` with `accessibilityState={{ expanded }}` and the
label `View options` (plus `, N filters active` when filters are set). It shows the active count with the
design-system `Badge`. The bar itself is at least 44 pt tall, which is the touch target. On open, focus moves to the panel's first heading.
On close, it moves back to the bar: `AccessibilityInfo.setAccessibilityFocus` on native, and `.focus()` on
the web ref. The panel has an explicit `Close view options` button.

## R6. Tests that select columns, sort or filters today (FR-017, SC-005)

| Suite | References | Change |
|---|---|---|
| `tests/e2e/web/movies.spec.ts` | 26 | open the bar first, through one helper, `openViewOptions(page)` |
| `tests/e2e/mobile/movie-sort.yaml` | 7 | add a `tapOn: view-options-toggle` step |
| `tests/e2e/mobile/movie-browse.yaml`, `movie-count.yaml`, `movie-search-filter.yaml` | 2 each | same |
| `src/screens/collections/collection-screen.test.tsx` | — | press the bar before asserting on controls |
| `column-selector.test.tsx`, `movie-filter-panel.test.tsx` | — | unchanged (components unchanged) |

The assistant flows (`tests/e2e/mobile/assistant-*.yaml`, `tests/e2e/web/assistant*.spec.ts`) keep their
testIDs. Story 2 adds one Android flow that types with the keyboard up and asserts the input and send
button are visible.

## R7. Persistence unchanged (FR-009)

`useColumnVisibility`, the sort state and the filter state keep their current owners and storage. The
dock passes the same props through, so docking and undocking are pure presentation. The open state is
**not** persisted: FR-004 requires the panel to start docked on every visit.
