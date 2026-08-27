# UI Contract: Settings destination with sub-navigation

**Feature**: `062-settings-split` | **Date**: 2026-08-23

The app exposes no new network interface in this feature. Its external contract is the **navigable
and automatable UI surface**: addresses, stable selectors, and the screen labels that cross into the
assistant. This document is that contract.

`testID` values are a **stable external contract** and are therefore exempt from the constitution's
behaviour-descriptive-identifier rule, per its explicit carve-out for stable E2E selectors. Each
renamed selector must carry a comment at its definition saying so.

---

## 1. Routes

| Address | Renders | Guard | Reports |
| --- | --- | --- | --- |
| `/(app)/settings` | Profile area | `(app)` `AuthGuard` (mc-user) | `settings`, depth 0 |
| `/(app)/settings/assistant` | Movie Assistant area | `(app)` `AuthGuard` (mc-user) | `settings-assistant`, depth 1 |
| `/(app)/settings/backups` | Backups placeholder | `(app)` `AuthGuard` (mc-user) | `settings-backups`, depth 1 |
| `/(app)/settings/admin` | Admin area | `(app)` `AuthGuard` **+ `ProtectedRoute` mc-admin** | `settings-admin`, depth 1 |
| `/(app)/profile` | — | — | **REMOVED** → unmatched route |
| `/(app)/admin/settings` | — | — | **REMOVED** → unmatched route |

Every address must resolve on a cold load (direct URL on web, deep link on native), not only via
in-app navigation.

---

## 2. Selector inventory

### Renamed — every occurrence must be updated in the same change

| Before | After | Where it lives now |
| --- | --- | --- |
| `nav-profile` | `nav-settings` | `components/navigation-bar.tsx` |
| `profile-screen` | `settings-profile-screen` | `screens/settings/profile-settings-screen.tsx` |
| `profile-loading` | `settings-profile-loading` | same |
| `profile-screen-empty` | `settings-profile-empty` | same |

### Removed

| Selector | Why |
| --- | --- |
| `profile-admin-settings-card` | The card it identified is deleted; the sub-navigation entry replaces it |

### New

| Selector | Element |
| --- | --- |
| `settings-nav` | The sub-navigation container |
| `settings-nav-profile` | Profile entry |
| `settings-nav-assistant` | Movie Assistant entry |
| `settings-nav-backups` | Backups entry |
| `settings-nav-admin` | Admin entry — **absent from the DOM entirely** for a non-admin, not merely hidden |
| `settings-assistant-screen` | Movie Assistant area container |
| `settings-backups-screen` | Backups placeholder container |

### Unchanged — must still resolve after the move

`admin-settings-screen`, and the whole `assistant-config-*` family
(`assistant-config`, `-loading`, `-banner`, `-enabled-toggle`, `-provider-*`, `-ollama-url-input`,
`-anthropic-key-input`, `-tmdb-key-input`, `-cost-limit-input`, `-test-results`, `-save`,
`assistant-test-connection`), plus `profile-email-verified` and the rest of `ProfileDisplay`.
Moving a component between screens must not change what it renders.

**Rendering requirement.** Every selector above must reach a React Native host node, so it becomes
`data-testid` on web and `id` on native. A `testID` placed on a Tamagui component is silently
dropped on React Native Web — the trap already documented in `admin-settings-card.tsx` for the
design system's `Card`, and the reason `Tabs` gains a host-node `testID` in this feature.

---

## 3. Visibility versus enforcement

Two independent checks, asserted independently. Neither substitutes for the other.

| Actor | Sees `settings-nav-admin` | Direct visit to `/(app)/settings/admin` |
| --- | --- | --- |
| `mc-admin` | yes | renders `admin-settings-screen` |
| `mc-user` | **no** — absent from the DOM | **refused** by `ProtectedRoute` |
| unauthenticated | n/a | refused by `(app)` `AuthGuard` before role is considered |

The non-admin direct-visit case is the one that matters: it must pass with the sub-navigation entry
never having been rendered. A test that only checks the entry's absence tests nothing about access.

---

## 4. Screen-label contract with the assistant

Client reports → BFF sanitizes (sole point) → gateway consumes.

- **Allowlist** (`bff-server/ui-state-sanitizer.ts`): gains `settings`, `settings-assistant`,
  `settings-backups`, `settings-admin`; loses `profile`.
- **Fallback**: unchanged — any label outside the allowlist becomes `unknown`. Asserted, so the
  channel cannot be widened by accident.
- **Gateway**: no change. `_COLLECTION_SCREENS` remains `{"collection", "movie-detail"}`, so no
  settings label resolves a "this" target and the assistant clarifies instead.
- **Payload shape**: unchanged — `current_screen`, `collection_id`, `movie_id`,
  `active_filter_keys`, `nav_depth`, and nothing else.

---

## 5. Accessibility contract

- Each sub-navigation entry: `accessibilityRole="menuitem"` with
  `accessibilityState={{ selected }}`, and `aria-current="page"` on the active entry.
  These are list semantics, not tab semantics — the sub-navigation is a vertical list, and a
  `tab` role would misdescribe it to assistive technology.
- The container: a labelled menu (`accessibilityRole="menu"` + an accessible name), so
  assistive technology announces it as one named group.
- **Every entry must be fully within the viewport at 320px wide.** This is a contract, not a
  styling preference: the previous horizontal row rendered, was locatable and navigated
  correctly while its last entry sat off-screen, so no existing assertion caught it.
- Focus is visible on keyboard traversal on web.
- The row remains usable when its entries exceed the viewport width — five entries for an admin on
  a phone is the sizing case that must be checked, not four.
