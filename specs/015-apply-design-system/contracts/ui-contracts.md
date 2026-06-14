# UI Contracts: Apply MCM Cinema Design System

This feature exposes no new API. Its "contracts" are the **client-side invariants** the re-skin must
not break. Three contracts: (1) Stable-Selector, (2) Theme-Persistence, (3) Screen → DS-Component
map.

---

## Contract 1 — Stable-Selector (LOAD-BEARING, FR-018 / SC-002)

Every `testID` / `accessibilityLabel` the Playwright (web) and Maestro (mobile) suites assert on
MUST survive the re-skin **verbatim** (same value, same element semantics — a pressable stays
pressable, a text node stays a text node). DS components must **forward** `testID` /
`accessibilityLabel` / `accessibilityRole` / `accessibilityState` to their underlying node; where a
DS component can't, wrap it in a layout-neutral `<View testID=…>`.

> On web, React Native Web renders `testID` → `data-testid` (the Playwright locator attribute).
> These are persisted external contract identifiers — exempt from behavior-descriptive-identifier
> renaming.

**Authoritative list** (regenerate with
`rg -o 'testID=["'"'"']([a-z0-9-]+)["'"'"']' frontend/mcm-app/src`; excludes `*/unit-tests/*`):

| Surface (file) | Stable `testID`s that MUST be preserved |
|---|---|
| Login (`screens/auth/login-screen`) | `login-screen`, `login-verified-banner`, `login-error-banner`, `btn-login-with-keycloak`, `login-loading`, `link-create-account` |
| Register (`register-form`) | `register-form-error`, `input-username`, `input-email`, `input-password`, `btn-create-account`; `password-strength-indicator` |
| Email verification (`screens/auth/email-verification-screen`) | `email-verification-screen`, `resent-success`, `resent-error`, `btn-resend-verification` |
| Profile (`screens/auth/profile-screen`, `profile-display`) | `profile-loading`, `profile-screen-empty`, `profile-screen`, `profile-display`, `profile-email-verified`, `profile-roles`, `profile-status`, `btn-logout` |
| Logout dialog (`logout-confirmation-dialog`) | `logout-dialog`, `btn-logout-cancel`, `btn-logout-confirm` |
| Home / collections (`screens/home/home-screen`, `collection-list(.native)`, `collection-card`) | `home-route`, `home-screen-loading`, `home-screen-create-button`, `home-screen-error`, `home-screen-create-modal`, `home-screen-edit-modal`, `collection-list`, `collection-list-empty-state`, `collection-card`, `collection-card-default-badge`, `collection-card-description`, `collection-card-action-open`, `collection-card-action-edit`, `collection-card-action-set-default`, `collection-card-action-delete` |
| Collection form (`collection-form`) | `collection-form-name-input`, `collection-form-name-error`, `collection-form-description-input`, `collection-form-cancel-button`, `collection-form-submit-button` |
| Delete dialog (`delete-confirmation-dialog`) | `delete-dialog`, `delete-dialog-cancel-button`, `delete-dialog-confirm-button` |
| Collection screen (`screens/collections/collection-screen`) | `collection-screen-name`, `collection-screen-add-movie` |
| Movie list (`movie-list`, `movie-list-item`, `movie-count-line`) | `movie-list-header`, `movie-list-empty`, `movie-list-container`, `movie-list-item-row`, `movie-list-item-title`, `movie-list-item-year`, `movie-list-item-language`, `movie-list-item-owned`, `movie-list-item-ripped`, `movie-list-item-childrens`, `movie-list-item-genres`, `movie-list-item-rated`, `movie-list-item-runtime`, `movie-list-item-directors`, `movie-list-item-actors`, `movie-count-line` |
| Search / filter / sort / columns (`movie-search-bar`, `movie-filter-panel`, `movie-sort-control`, `column-selector`) | `movie-search-input`, `movie-search-clear`, `movie-filter-panel`, `filter-clear-button`, `movie-sort-control`, `sort-dir-toggle` |
| Movie detail (`movie-detail`, `screens/movies/movie-detail-screen`) | `movie-detail-screen-loading`, `movie-detail-screen-empty`, `movie-detail-back-button`, `movie-detail-title`, `movie-detail-year`, `movie-detail-content-type`, `movie-detail-language`, `movie-detail-owned`, `movie-detail-owned-media`, `movie-detail-ripped`, `movie-detail-rip-quality`, `movie-detail-childrens`, `movie-detail-genres`, `movie-detail-rated`, `movie-detail-directors`, `movie-detail-actors`, `movie-detail-runtime`, `movie-detail-release-date`, `movie-detail-outline`, `movie-detail-plot`, `movie-detail-original-title`, `movie-detail-movie-set`, `movie-detail-tags`, `movie-detail-external-ids`, `movie-detail-edit-button`, `movie-detail-delete-button` |
| Add/edit movie (`new-movie-screen`, `movie-form`) | `new-movie-screen`, and all `movie-form-*` fields/errors/buttons (title/year/content-type/language/owned/owned-media/ripped/rip-quality/childrens/rated/original-title/release-date/runtime/movie-set/outline/plot/director(+add)/directors-list/actor(+add)/actors-list/genre(+add)/genres-list/tag(+add)/tags-list/external-ids-section/ext-id-system/unique/url(+add)/server-error/cancel/submit) |
| Navigation (`navigation-bar`) | `navigation-bar` |
| Auth guard (`auth-guard`) | `auth-guard-loading` |
| Assistant dock (`agent/assistant-dock`) | `assistant-dock`, `assistant-dock-toggle`, `assistant-dock-panel`, `assistant-dock-messages`, `assistant-dock-input`, `assistant-dock-send` |
| Assistant rich UI (`agent/*`) | `approval-request`, `approval-reject`, `approval-approve`, `render-movie-card(+ -poster/-title/-year/-genres/-overview/-source/-url/-add)`, `render-collection-summary(+ -name/-count/-role)`, `import-preview(+ -tabs/-ignored/-ignored-hint/-total/-cancel/-approve)`, `import-report(+ -summary/-toggle/-detail/-skipped/-failed)`, `request-import-file(+ -cancelled/-choose/-cancel/-error)`, `disambiguation-options`, `disambig-more`, `selection-options`, `selection-more`, `assistant-ui-action-download` |

**Acceptance gate**: after re-skinning any surface, the diff of the regen command above must show
**no removed `testID`s** for that surface, and the surface's E2E spec(s) must pass unchanged.

---

## Contract 2 — Theme-Persistence

| Aspect | Value |
|---|---|
| Mechanism | `@react-native-async-storage/async-storage` |
| Key | `mcm.theme` (persisted external key — rename-exempt, annotated in code) |
| Values | `'dark'` \| `'light'` |
| Default (no/unreadable/unknown value) | `'dark'` |
| Read timing | once on app mount (in `use-theme`); applied after async resolve |
| Write timing | on user toggle, synchronously updating state then persisting |
| Web persistence | survives page reload (localStorage-backed) |
| Native persistence | survives app relaunch |
| Backend involvement | **none** (no BFF/profile/Redis) |
| Provider binding | sets `TamaguiProvider` active theme (`dark`/`light` theme keys) |

**Acceptance**: SC-003 — launch=dark; toggle to light persists across reload (web) and relaunch
(mobile) in 100% of attempts.

---

## Contract 3 — Screen → DS-Component map

What each existing surface adopts from `@mcm/design-system`. Props/behaviour identical; only
rendering changes. (DS components per `packages/DESIGN-SYSTEM.md`.)

| Existing surface | DS component(s) adopted | Platform notes |
|---|---|---|
| App chrome (top bar, wordmark, theme toggle, profile avatar) | `AppBar`, `IconButton`, theme-toggle control | Web top app bar per mock-up; native AppBar variant |
| `navigation-bar` | `NavigationBar` (or AppBar nav links on web) | Web = nav links; native = bottom `NavigationBar` |
| `collection-card` + home grid | `CollectionCard`, `Card` | Grid on web/tablet, list on phone |
| `movie-list` | **web**: DS data-table surface (`MovieCard` data-table styling, toolbar count + orange "Add movie", Outfit headers, primary bottom-border, hover rows) · **native**: `MovieCard` compact list | `movie-list.web.tsx` / `movie-list.native.tsx`, identical props/selectors (R7) |
| `movie-list-item` | `MovieCard` (compact) / table row | mismatch → orange `FormatBadge` (`highlight`) |
| `movie-detail` | `Card`, `Chip`, `StarRating`, `FormatBadge`, `Button`/`IconButton` | external-id links keep existing `openUrl` behaviour |
| `movie-form`, `collection-form` | `TextField` (filled/outlined, floating label, supporting/error), `Switch`, `Chip` (tags/genres), `Button` variants | content-type picker keeps radio behaviour (Picker Fabric-crash history) |
| `movie-search-bar` | `SearchBar` | pill, full radius |
| `movie-filter-panel` | `Chip`/`ChipGroup` (filter), `Switch` | |
| `movie-sort-control` | `Chip` (sort by) + direction `IconButton` | |
| `column-selector` | `Switch` grid | web-only feature (unchanged scope) |
| `delete-confirmation-dialog`, `logout-confirmation-dialog` | `Dialog` (scrim) + `Button` | |
| `register-form`, login/profile/verification screens | `TextField`, `Button`, `Card`, `Badge` | register page keeps password-manager autofill (NOT `NoAutoFillInput`) |
| `password-strength-indicator` | DS progress/`Badge` styling | |
| `agent/assistant-dock` + `agent/*` | `AssistantAvatar` (Grumpy Robot, thinking anim), `ChatBubble`, `ApprovalBubble`, `Snackbar`, composer | needs `react-native-svg`; index-prefixed dock keys preserved |
| Snackbars / toasts / loading | `Snackbar` + `useSnackbar`, DS loading | feedback per constitution |

**Orange-accent budget (FR-006 / SC-005)**: per screen, orange only on ≤3–4 sanctioned elements —
rating stars, Grumpy Robot avatar, the single "Add movie" CTA, and media↔quality mismatch badges.
Everything else uses Cinematic-Blue primary / neutral surfaces.
