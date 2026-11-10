# Data model: Docked view options and keyboard-safe assistant

This feature is presentation-only. There are no new domain entities, no API change and no new persisted
state. The client-side state below is all that is added.

## OpenPanel (client state, in memory, not persisted)

| Field | Type | Notes |
|---|---|---|
| `openPanel` | `'assistant' \| 'view-options' \| null` | at most one overlay open (FR-015) |

**Transitions**

```text
null ──open('view-options')──▶ view-options ──close / toggle / Back / Escape──▶ null
null ──open('assistant')─────▶ assistant    ──toggle──────────────────────────▶ null
view-options ──open('assistant')──▶ assistant      (the view options re-dock)
assistant ──open('view-options')──▶ view-options   (the assistant docks)
leaving the collection screen while view-options is open ──▶ null   (FR-004: docked on next visit)
```

The assistant's lazy-load sub-states (`loading`, `failed`, `Panel`) stay local to `AssistantDock`. Only
open versus closed moves into the context.

## ActiveFilterCount (derived, never stored)

`count(v in Object.values(filters) where v !== undefined && v !== '')`. This is the same predicate
`MovieFilterPanel` uses for `hasActiveFilters`, and it is extracted so the two cannot drift. It drives the
badge and the accessibility label (FR-008, FR-016).

## KeyboardInset (client state, in memory)

| Field | Type | Notes |
|---|---|---|
| `height` | `number` (dp) | 0 when hidden and always 0 on web; set from the keyboard show/hide events |

## Unchanged

Column visibility, sort field and direction, and filters keep their current owners
(`useColumnVisibility`, `useMovies`) and their current persistence.
