# UI contract: testIDs and accessibility

The web E2E (Playwright, `data-testid`), the mobile flows (Maestro, `id:`) and the unit tests depend on these
IDs. **Existing IDs keep their meaning**. They are only reachable once the view options are open.

## New: view-options dock (collection screen)

| testID | Element | Contract |
|---|---|---|
| `view-options-toggle` | the docked bar | always rendered on the collection screen; `role=button`; `accessibilityState.expanded` mirrors open; label `View options` or `View options, N filters active` |
| `view-options-active-count` | badge inside the bar | rendered only when N > 0; its text is N |
| `view-options-panel` | the drop-down overlay | rendered only while open; overlays the list; scrolls internally |
| `view-options-close` | close button inside the panel | closes and returns focus to `view-options-toggle` |

**Close paths:** `view-options-close`, pressing `view-options-toggle` again, Android Back, and web Escape.
None of them navigates.

## Existing IDs, now inside `view-options-panel`

`column-toggle-{key}`, `movie-sort-control`, `sort-field-{key}`, `sort-dir-toggle`, `movie-filter-panel`,
`filter-section-{key}`, `filter-chip-{key}-{value}`, `filter-clear-button`.

## Unchanged, outside the dock

`collection-screen-name`, the search bar's IDs, `collection-screen-add-movie`, the count line, and the list.

## Assistant (unchanged IDs, new layout contract)

| testID | Contract added by this feature |
|---|---|
| `assistant-dock` | its bottom offset is `16 + keyboardHeight` while the on-screen keyboard is shown (native) |
| `assistant-dock-panel` | its height is ≤ the visible area above the keyboard minus the toggle and margins; it is never above the top safe inset |
| `assistant-dock-input`, `assistant-dock-send` | fully visible while the keyboard is shown |

Opening `assistant-dock-toggle` while `view-options-panel` is open closes the view options, and the reverse
also holds.
