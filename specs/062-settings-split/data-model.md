# Phase 1 Data Model: Settings destination with sub-navigation

**Feature**: `062-settings-split` | **Date**: 2026-08-23

This feature persists nothing. It introduces no BFF route, no mc-service endpoint, and no database
change. The two structures below are in-memory and compile-time: a navigation registry, and a
string vocabulary the BFF enforces.

---

## 1. Settings area registry

The single source of truth for the sub-navigation. Declared once in
`src/components/settings/settings-nav.tsx` and mapped onto the design system's `TabItem`.

| Field | Type | Notes |
| --- | --- | --- |
| `key` | `'index' \| 'assistant' \| 'backups' \| 'admin'` | Matches the route file name under `settings/` |
| `label` | `string` | User-facing: `Profile`, `Movie Assistant`, `Backups`, `Admin` |
| `href` | route path | `/(app)/settings`, `…/assistant`, `…/backups`, `…/admin` |
| `testID` | `string` | `settings-nav-<key>`; an exempt external contract (see the UI contract) |
| `adminOnly` | `boolean` | `true` for `admin` only |

### The rows

| key | label | href | testID | adminOnly |
| --- | --- | --- | --- | --- |
| `index` | Profile | `/(app)/settings` | `settings-nav-profile` | no |
| `assistant` | Movie Assistant | `/(app)/settings/assistant` | `settings-nav-assistant` | no |
| `backups` | Backups | `/(app)/settings/backups` | `settings-nav-backups` | no |
| `admin` | Admin | `/(app)/settings/admin` | `settings-nav-admin` | **yes** |

### Rules

- **Visibility**: a row with `adminOnly` is filtered out unless `isAdmin(user)`. This is
  presentation only — never the access control (see the enforcement rule below).
- **Active row**: derived from `usePathname()`. The `index` row is active only on the exact group
  path, so it does not also light up on `…/assistant`. `NavigationBar` already gets this wrong for
  nested paths via `startsWith`; the sub-navigation must not copy that shape.
- **Enforcement**: filtering the registry has no security effect. `settings/admin.tsx` carries
  `ProtectedRoute requiredRole="mc-admin"` independently, and that is what refuses a direct visit.
- **Extension point**: backlog item #236 replaces the `backups` screen body. It touches **no** row
  in this table — that is the property FR/SC-006 asks this feature to demonstrate.

---

## 2. Screen-label vocabulary

The structural label a screen reports through `useReportUiState`, carried to the assistant so it
can resolve references like "this collection". It is **not free text**: the BFF reduces anything
unrecognised to `unknown` at its single sanitization point.

### Vocabulary after this change

| Label | Reported by | `nav_depth` | Status |
| --- | --- | --- | --- |
| `home` | `(app)/home.tsx` | 0 | unchanged |
| `collection` | `collections/[collectionId]/index.tsx` | 1 | unchanged |
| `movie-detail` | `collections/[collectionId]/movies/[movieId].tsx` | 2 | unchanged |
| `settings` | `settings/index.tsx` | 0 | **new** |
| `settings-assistant` | `settings/assistant.tsx` | 1 | **new** |
| `settings-backups` | `settings/backups.tsx` | 1 | **new** |
| `settings-admin` | `settings/admin.tsx` | 1 | **new** |
| `profile` | — | — | **retired** (nothing ever reported it) |
| `admin-settings` | — | — | **retired** (was reported but never allowlisted) |

### Where each part lives

| Concern | File | Change |
| --- | --- | --- |
| Enforcement allowlist | `src/bff-server/ui-state-sanitizer.ts` → `ALLOWED_SCREENS` | Replace `'profile'` with the four `settings*` labels |
| Client-side type hint | `src/hooks/use-ui-state.tsx` → `UiSnapshot.current_screen` | Widen the union to match |
| Consumer | `agents/movie-assistant/src/nodes/organizer.py` → `_COLLECTION_SCREENS` | **No change** — reads only `collection` and `movie-detail` |

### Rules

- **Allowlist is authoritative.** The union type in `use-ui-state.tsx` is a developer hint and ends
  in `| string`; it constrains nothing at runtime. A label added to the type but not the allowlist
  silently becomes `unknown` — which is exactly how `admin-settings` drifted.
- **Structural only.** No user-entered value, id, or free text may ride this channel. Unchanged by
  this feature; restated because the vocabulary is being edited.
- **A settings label resolves nothing.** None of the four labels appears in `_COLLECTION_SCREENS`,
  so the assistant has no collection or movie in view while the user is in settings and must
  clarify rather than act on a stale target. That is the correct behaviour and is asserted, not
  assumed.

---

## 3. What is deliberately absent

- **No backup entity.** The Backups area is a placeholder with no schedule, destination, format, or
  history. Item #236 introduces that model.
- **No settings persistence.** Which area the user last visited is not remembered; the address is
  the state.
- **No change to app settings.** The self-registration toggle keeps its existing shape, its
  existing `/bff-api/admin/settings` route, and its existing `useAppSettings` hook.
