# Phase 1 Data Model: Apply MCM Cinema Design System

This is a UI-only feature. **No backend entity, MongoDB collection, BFF route, or API contract
changes.** The only new persisted state is a device-local UI preference. The "entities" below are
client-side view-models / state shapes, not domain data.

---

## Theme Preference (NEW — device-local UI state)

The user's chosen appearance. Owned entirely by the client; never sent to the BFF or backend.

| Field | Type | Values | Default | Notes |
|---|---|---|---|---|
| `theme` | enum (string) | `'dark'` \| `'light'` | `'dark'` | The two and only modes (no system-follow — clarified). |

- **Storage**: `@react-native-async-storage/async-storage`, key **`mcm.theme`** (a persisted
  storage key — exempt from behavior-descriptive-identifier renaming, annotated in code).
- **Scope**: per device/browser. Web → backed by `localStorage` (survives reload); native →
  survives app relaunch. Not synced across devices.
- **Lifecycle**:
  1. First launch / no stored value → resolve to `'dark'`.
  2. User toggles via the AppBar/profile theme control → state flips, new value written to storage.
  3. Subsequent launches/reloads → read storage; apply stored value (falls back to `'dark'` on any
     read error or unrecognized value).
- **Validation**: any value other than the two literals is treated as `'dark'` (defensive default).
- **Provider binding**: drives `TamaguiProvider`'s active theme (`light`/`dark` theme keys defined
  in `packages/design-system/theme/`).

### State transitions

```text
            ┌──────────────── toggle ───────────────┐
            ▼                                        │
        [ dark ]  ──────────── toggle ──────────▶ [ light ]
            ▲                                        │
            └──────────── toggle ────────────────────┘

  start → read(mcm.theme) → 'light' ? [light] : [dark]   (default/any-error → dark)
```

---

## UI View-Models touched by the re-skin (unchanged shapes, restyled rendering)

These already exist; the re-skin changes how they are *rendered* (DS components), not their data.
Listed so tasks can map screen → data without implying new fields.

| View-model | Source | Used by (restyled surface) |
|---|---|---|
| `CollectionSummary` | `@/types/collection` | `collection-card` → DS `CollectionCard`; home grid |
| `Movie` (list/detail) | `@/types/*` | `movie-list(.web/.native)`, `movie-list-item` → DS data table / `MovieCard`; `movie-detail` |
| Filter / sort / column-visibility state | existing hooks/components | `movie-filter-panel`, `movie-sort-control`, `column-selector` → DS `Chip`/`Switch`/`Tabs` |
| Form field + validation state | `movie-form`, `collection-form`, `register-form` | → DS `TextField`/`Button` (floating label, supporting/error text) |
| Assistant message / approval / thinking state | `src/components/agent/*`, `use-assistant` | assistant dock → DS `AssistantAvatar`/`ChatBubble`/`ApprovalBubble`/`Snackbar`/composer |

### Media↔Quality mismatch highlight (derived, no new field)

A movie row's **media format** and **rip quality** are existing fields. The orange highlight is a
**derived presentation rule** computed in pure code at render time: `highlight = media !== quality`
(matching values stay neutral). No data is stored for this; it mirrors the mock-up's `fmtPair`
logic and the DS `FormatBadge` `highlight` prop. (FR-010, SC-007.)

---

## Explicitly NOT changed

- No new BFF API routes, mc-service endpoints, MongoDB fields, or Keycloak config.
- No change to `Session`, auth tokens, or any persisted backend data.
- No change to the existing movie/collection/auth request & response contracts.
