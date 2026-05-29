# Feature Specification: Manage Movie Collection

**Feature Branch**: `002-manage-movie-collection`

**Created**: 2026-05-19

**Status**: Draft

**Input**: `docs/PRD-ManageMovieCollection.md`

## Clarifications

### Session 2026-05-22

- Q: Is editing an existing movie collection's name and/or description in scope? → A: Yes — users can edit a collection's name and optional description.
- Q: Should the USA rating field accept only a fixed list of values, or any free-text value? → A: Controlled vocabulary — G, PG, PG-13, R, NC-17, NR (Not Rated), Unrated.
- Q: How should the movie browse list handle large collections (up to 10,000 movies)? → A: Infinite scroll — load an initial batch on collection open, load more automatically as the user scrolls toward the end of the list.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Manage Movie Collections (Priority: P1)

A logged-in user can create, browse, load, set as default, edit (rename and update description), and delete their own movie collections from the home screen. This is the foundational capability — everything else in the feature depends on a collection existing first.

**Why this priority**: Without at least one collection, no other capability in this feature is accessible. This story delivers a working home screen with the complete collection lifecycle.

**Independent Test**: Can be fully tested by creating a collection, setting it as default, then deleting it — all without adding any movies — and verifying the home screen responds correctly at each step.

**Acceptance Scenarios**:

1. **Given** a user is logged in with no collections, **When** they view the home screen, **Then** they see an empty state with an option to create their first collection.
2. **Given** a user is on the home screen, **When** they create a new collection with a name, **Then** the collection is saved and appears in their collection list.
3. **Given** a user already has a collection named "Sci-Fi", **When** they attempt to create another collection also named "Sci-Fi", **Then** the system rejects the duplicate name with a clear message.
4. **Given** a user has multiple collections, **When** they set one as default, **Then** that collection is marked as default and any previously default collection loses its default status.
5. **Given** a user has a default collection set, **When** they log in, **Then** the app navigates directly to that default collection without requiring them to select it (FR-009, fires once per login).
6. **Given** a user has no default collection, **When** they log in, **Then** they see the home screen showing their collection list.
7. **Given** a user selects a collection to delete, **When** the system warns them that all data including movies will be permanently lost and they confirm, **Then** the collection and all its movies are deleted.
8. **Given** a user selects a collection to delete, **When** the warning is shown and they cancel, **Then** no deletion occurs and the collection remains intact.
9. **Given** a user has a collection, **When** they edit it and submit a new name or updated description, **Then** the changes are saved and immediately reflected in the collection list.
10. **Given** a user is editing a collection's name, **When** they submit a name that matches another collection they own (case-insensitive), **Then** the system rejects the change with a clear message and the original name is preserved.
11. **Given** a user has a default collection and has already been auto-navigated there after login, **When** they tap "My Collections" in the navigation bar, **Then** the app shows the collection list screen without auto-redirecting to the default collection again.
12. **Given** a user is on any screen in the app, **When** they view the navigation bar, **Then** the navigation link that returns them to the collection list is labelled "My Collections".
13. **Given** a user is on a collection screen, **When** they navigate back to the home screen (e.g., via the "My Collections" navigation link), **Then** the collection list is refreshed and displays current data without showing an error state.

---

### User Story 2 — Add and Edit Movies in a Collection (Priority: P2)

A logged-in user can add new movies to a collection they own, then view and edit the full details of any movie. Movies have both required attributes (title, year, content type, language, ownership status, rip status, children's flag) and a rich set of optional attributes (cast, plot, external IDs, genres, tags, etc.).  A movie is uniquely defined by title, year, and content type.

**Why this priority**: A collection without movies has limited value. This story enables the core data-entry workflow and allows users to maintain accurate, detailed records of their movie library.

**Independent Test**: Can be fully tested by opening a collection, adding a movie with all required attributes, editing one of its optional attributes, and confirming the changes persist.

**Acceptance Scenarios**:

1. **Given** a user is viewing a collection, **When** they choose to add a new movie, **Then** they are presented with a movie details form requiring title, year, content type, language, owned, ripped, and children's flag.
2. **Given** a user is completing the new movie form, **When** they submit with all required attributes filled in, **Then** the movie is saved to the collection.
3. **Given** a user is completing the new movie form, **When** they submit with one or more required attributes missing, **Then** the system rejects the submission with a clear validation message identifying the missing fields.
4. **Given** a movie collection already has a movie with title of "Crash", year of "1999", and content type of "Movie", **When** they attempt to create another movie with title of "Crash", year of "1999", and content type of "Movie", **Then** the system rejects the duplicate movie with a clear message.
5. **Given** a user is adding a movie, **When** they provide optional attributes (e.g., plot, director, genre), **Then** those attributes are also saved with the movie.
6. **Given** a user is adding a movie, **When** they add one or more external identifiers (e.g., an IMDB ID), **Then** each identifier is stored with its system name, unique ID, and optional URL.
7. **Given** a movie exists in a collection, **When** a user opens it and edits any attribute, **Then** the updated values are saved and reflected immediately.
8. **Given** a user edits a movie's content type, **When** they select a value not in the allowed list (Movie, Series, Concert), **Then** the system rejects the invalid value.
9. **Given** a user edits a movie's owned media or rip quality, **When** they select a value not in the allowed list (DVD, Blu-Ray, Blu-Ray 3D, UHD Blu-Ray), **Then** the system rejects the invalid value.

---

### User Story 3 — Browse, Search, and Filter Movies (Priority: P3)

A logged-in user can browse all movies in a collection, choosing which columns to display, and can narrow the list using free-text search across multiple movie fields or by selecting from available filter values.

**Why this priority**: As collections grow, browsing without search and filter becomes impractical. This story makes collections genuinely usable for large libraries.

**Independent Test**: Can be fully tested by populating a collection with several movies of varying attributes, then verifying that search, column selection, and filter controls each produce the expected subset.

**Acceptance Scenarios**:

1. **Given** a user is viewing a collection, **When** the movie list loads, **Then** it displays by default: title, year, content type, owned, owned media, ripped, and rip quality for each movie.
2. **Given** a user is viewing the movie list, **When** the list is displayed (with or without movies), **Then** a column header row is visible above the list showing the label for each currently visible column.
3. **Given** a user is viewing the movie list, **When** they choose additional columns to show, **Then** those columns appear in the list and the column header updates accordingly, without requiring a page reload.
4. **Given** a user is viewing the movie list, **When** they choose to remove columns to show, **Then** those columns disappear from the list and the column header updates accordingly, without requiring a page reload.
5. **Given** a user types a search term in the search box, **When** the term matches text in a movie's title, original title, director, actor, movie set, tag, outline, or plot, **Then** only matching movies are shown.
6. **Given** a user types a search term immediately after opening a collection, **When** the initial movie list is still loading, **Then** the search result must not be overwritten by the background load — the search result is shown when both operations complete.
7. **Given** a user applies a content type filter selecting "Series", **When** the filter is active, **Then** only movies with content type "Series" are shown.
8. **Given** a user applies a decade filter selecting "1980s", **When** the filter is active, **Then** only movies with a year between 1980 and 1989 inclusive are shown.
9. **Given** a user applies multiple filters simultaneously (e.g., genre "Action" and owned "Yes"), **When** both are active, **Then** only movies matching all active filters are shown.
10. **Given** a user applies a filter for a value derived from the collection (e.g., a genre), **When** the collection contains no movies with that genre, **Then** the filter option does not appear.

---

### User Story 4 — Remove Movies from a Collection (Priority: P4)

A logged-in user can permanently remove a movie from a collection, but only after explicitly confirming they understand the data cannot be recovered.

**Why this priority**: Data hygiene is important but comes after the ability to add and view data. The confirmation gate protects against accidental data loss.

**Independent Test**: Can be fully tested by adding a movie, initiating deletion, verifying the warning appears, confirming deletion, and verifying the movie no longer appears in the collection.

**Acceptance Scenarios**:

1. **Given** a user is viewing a movie's details, **When** they choose to remove the movie, **Then** the system displays a warning stating the movie and all its data will be permanently and unrecoverably lost.
2. **Given** the removal warning is displayed, **When** the user confirms, **Then** the movie is permanently deleted from the collection.
3. **Given** the removal warning is displayed, **When** the user cancels, **Then** the movie is not deleted and the user returns to the movie details screen.

---

### Edge Cases

- A user attempts to name a new collection identically to an existing collection they own (different case, e.g., "sci-fi" vs "Sci-Fi"): system must reject duplicates regardless of case.
- A user deletes their only default collection: the app must return to the home screen with no default set.
- A user sets a new default while already having a default: the previous default is silently demoted without requiring a separate step.
- A user attempts to create a new movie identically to an existing movie in the same collection (different case, e.g., "crash" vs "Crash"): system must reject duplicates regardless of case.
- A movie's `decade` filter value is derived at query time from the `year` field.
- A collection with zero movies is valid and must display an appropriate empty state; the column header row must still be visible above the empty state.
- A movie's `owned` flag is false but `ownedMedia` has values: the system should not allow this and throw validation error.
- External identifiers with the same `externalIdSystem` and `externalIdUniqueId` combination must not be duplicated on a single movie.
- A user types a search term immediately after navigating to the collection screen (before the initial movie fetch resolves): the search result, not the initial batch, must be displayed after both fetches complete.
- A user navigates from a collection screen back to the home screen via the navigation bar: the home screen must refresh its collection list so newly created or modified collections are visible.

---

## Requirements *(mandatory)*

### Functional Requirements

**Access Control**

- **FR-001**: System MUST require a valid authenticated session to access any movie collection screen or data.
- **FR-002**: System MUST ensure each user can only read and modify movie collections they created; no cross-user access is permitted.

**Movie Collection Lifecycle**

- **FR-003**: Users MUST be able to create a new movie collection by providing a name (required, max 50 characters) and an optional description.
- **FR-003a**: Users MUST be able to edit an existing movie collection's name (max 50 characters) and optional description.
- **FR-004**: System MUST reject creation or renaming of a movie collection if the user already owns a collection with the same name (case-insensitive comparison).
- **FR-005**: Users MUST be able to set exactly one of their collections as the default collection at any time.
- **FR-006**: System MUST automatically remove the default designation from the previously default collection when a new one is set as default.
- **FR-007**: Users MUST be able to have no default collection (the default flag is optional).
- **FR-008**: Users MUST be able to permanently delete a movie collection, but only after confirming a warning that the collection and all its movies will be unrecoverably lost.

**Home Screen Behaviour**

- **FR-009**: System MUST navigate a user directly to their default collection upon login when one is set.
- **FR-010**: System MUST show the home screen (collection list) upon login when no default collection is set.
- **FR-010a**: System MUST refresh the collection list every time the home screen gains focus (including after navigating back from a collection screen), so that changes made elsewhere are reflected without requiring a manual reload.

**Movie Lifecycle**

- **FR-011**: Users MUST be able to add a movie to a collection with the following required attributes: title, year (4-digit), content type (one of: Movie, Series, Concert), primary language, owned (yes/no), ripped (yes/no), children's (yes/no).
- **FR-012**: System MUST default ripped, children's, and default collection flag to "No" when not explicitly specified.
- **FR-013**: Users MUST be able to provide any of the following optional movie attributes: original title, release date (YYYY-MM-DD), outline, plot, runtime (minutes), USA rating (one of: G, PG, PG-13, R, NC-17, NR, Unrated), one or more directors, one or more actors, movie set name, one or more tags, one or more genres, one or more owned media types (DVD, Blu-Ray, Blu-Ray 3D, UHD Blu-Ray), one or more rip quality values (DVD, Blu-Ray, Blu-Ray 3D, UHD Blu-Ray), and one or more external identifiers.
- **FR-014**: Each external identifier MUST include a system name (e.g., IMDB, TMDB) and a unique ID within that system, with an optional URL to the movie in that external system.
- **FR-014a**: When an external identifier includes a URL, the system MUST render it as a tappable/clickable link that opens in a new browser tab on web and in the device's default browser on native mobile.
- **FR-015**: Users MUST be able to edit any attribute of an existing movie.
- **FR-016**: System MUST validate all movie attributes on save: required fields must be present, content type must be one of the allowed values, USA rating must be one of the allowed values (G, PG, PG-13, R, NC-17, NR, Unrated) when provided, owned media and rip quality must each be from the allowed values list, owned media values must be empty when the owned flag is set to No, and rip quality values must be empty when the ripped flag is set to No.
- **FR-016a**: System MUST reject creation of a movie in a collection when a movie with the same title, year, and content type (case-insensitive) already exists in that collection.
- **FR-017**: Users MUST be able to permanently delete a movie from a collection, but only after confirming a warning that the movie and all its data will be unrecoverably lost.

**Browsing**

- **FR-018**: System MUST display movies in a collection in a list showing by default: title, year, content type, owned, owned media, ripped, and rip quality.
- **FR-018a**: System MUST use infinite scroll for the movie browse list: an initial batch of movies is loaded when a collection is opened, and additional movies are fetched automatically as the user scrolls toward the end of the list. Search and filter operations reset and reload from the beginning of the matching result set.
- **FR-018b**: System MUST display a column header row above the movie browse list at all times, including when the list is empty, showing the label for each currently visible column.
- **FR-019**: Users MUST be able to add or remove movie attributes as display columns in the browse list.
- **FR-019a**: The user's column visibility selection MUST be persisted per-device across sessions and across all collections. On subsequent visits (same or different collection), the same column set must be restored automatically; the factory default (FR-018) applies only on first use before any preference has been saved. Each device retains its own preference independently — this is by design, as users may prefer different column layouts on different screen sizes (e.g., fewer columns on a phone, more on a desktop browser).
- **FR-020**: System MUST allow users to view the full details of any movie by selecting it from the browse list.

**Search and Filter**

- **FR-021**: Users MUST be able to perform a free-text search across a movie's title, original title, director names, actor names, movie set, tags, outline, and plot.
- **FR-022**: Users MUST be able to filter the movie list by any combination of the following: content type (Movie, Series, Concert), genre (values present in the collection), children's (Yes/No), USA rating (values present in the collection), language (values present in the collection), decade (derived from the movie's required year attribute), owned (Yes/No), owned media type (DVD, Blu-Ray, Blu-Ray 3D, UHD Blu-Ray), ripped (Yes/No), rip quality (DVD, Blu-Ray, Blu-Ray 3D, UHD Blu-Ray).
- **FR-023**: System MUST derive decade filter options from the year attribute of movies in the collection (e.g., "1980s" matches all movies with year 1980–1989 inclusive).
- **FR-024**: Filter options for genre, rating, and language MUST reflect only values present in the currently loaded collection; unpopulated values MUST NOT appear as filter options.
- **FR-025**: Search and filter MUST be combinable — a user may apply a text search and one or more filters simultaneously, and results must satisfy all active constraints.
- **FR-025a**: Search and filter operations MUST be race-condition safe: if the user triggers a new search or filter while a previous fetch is still in flight, the result of the most recent operation MUST be displayed and stale results from prior operations MUST be discarded.

**Form Input Security**

- **FR-026**: All user-facing form inputs in the movie collection feature (collection name/description, movie title, year, plot, etc.) MUST suppress password manager autofill (Dashlane, LastPass, 1Password, Bitwarden) via a shared wrapper component. The sole exception is the user registration form, which must permit password manager interaction.
- **FR-026a**: For form fields whose placeholder, `aria-label` (React Native `accessibilityLabel`), or visible label text contains a keyword that Chrome uses as an autofill signal (personal-name keywords such as "name", "director", "actor"; identifier keywords such as "id", "identifier"), the autofill wrapper MUST suppress Chrome's native autofill heuristic by: (a) setting a non-standard HTML `name` attribute value via the `webName` prop that does not itself contain any autofill-triggering keyword, AND (b) ensuring the placeholder and `accessibilityLabel` text do not contain those keywords. Affected fields: collection name input, director entry, actor entry, external ID system input, external ID unique-ID input.

### Key Entities

- **Movie Collection**: A named grouping of movies owned by a single user. Attributes: unique identifier (system-generated), name, optional description, default flag. A user may own zero or more collections. Names must be unique per user (case-insensitive).
- **Movie**: A record within a movie collection representing a single movie. Has required attributes (title, year, content type, language, owned, ripped, children's flag) and many optional attributes (see FR-013). A movie belongs to exactly one collection. Within a collection, the combination of title, year, and content type must be unique (case-insensitive).
- **External Identifier**: A reference to a movie in an external system (e.g., IMDB, TMDB). Composed of system name, unique ID, and optional URL. A movie may have zero or more external identifiers.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user who is not authenticated cannot access any movie collection data; any direct navigation attempt redirects to the login screen.
- **SC-002**: A logged-in user can only see and interact with collections they created; no other user's collections are visible or accessible under any navigation path.
- **SC-003**: After login with a default collection set, the app lands on that collection's movie list without any additional navigation step required from the user.
- **SC-004**: After login with no default collection, the home screen showing the user's collection list is displayed within 3 seconds.
- **SC-005**: A user can create a new movie collection and add their first movie with all required attributes in under 3 minutes from the home screen.
- **SC-006**: A user can browse, search, and filter a collection of up to 10,000 movies; the initial batch of movies loads within 3 seconds of opening a collection, and search and filter results are returned within 3 seconds of entering search terms or selecting filter values.
- **SC-007**: All destructive operations (delete collection, delete movie) require an explicit user confirmation step; no deletion occurs without confirmation.
- **SC-008**: Attempting to create two collections with the same name (regardless of case) results in a clear error message and no duplicate is created.
- **SC-009**: Setting a collection as default results in exactly one default collection existing; any previous default is automatically removed.
- **SC-010**: A movie's full details, including all optional attributes, can be viewed, added, and edited without data loss across sessions.
- **SC-011**: A user can independently filter the movie list by decade, and only movies with a year value within the selected decade are returned (e.g., selecting "1980s" returns only movies with year 1980–1989).
- **SC-012**: Attempting to add a movie with the same title, year, and content type (regardless of case) as an existing movie in the same collection results in a clear error message and no duplicate is created.

---

## Assumptions

- Users are already authenticated via the existing login system implemented in feature 001-user-login; no new authentication mechanism is required.
- A user must hold the `mc-user` or `mc-admin` role (established in the previous feature) to access movie collections; unauthenticated or role-less users are redirected to login.
- Movie sharing between users is explicitly out of scope for this feature and will be addressed in a future feature.
- Loading movie metadata automatically from external sources (IMDB, TMDB, etc.) is explicitly out of scope; all movie attributes are entered manually by the user.
- Content type valid values are fixed: Movie, Series, Concert. No user-defined content types are supported in this feature.
- Physical media and rip quality valid values are fixed: DVD, Blu-Ray, Blu-Ray 3D, UHD Blu-Ray.
- The `decade` filter is derived from the movie's required `year` attribute (4-digit integer); because `year` is required, all movies in a collection are eligible to appear under a decade filter.
- A movie's `title` is the owner's preferred title for the movie (typically their primary language); `originalTitle` should be provided when the movie's original release title differs from the owner's preferred title.
- The system handles collections of up to 10,000 movies per user without degraded performance; collections beyond this size are not explicitly designed for in this feature.
- The movie browse list uses infinite scroll; the specific initial batch size and subsequent page size are implementation details deferred to the planning phase.
- USA rating valid values are fixed: G, PG, PG-13, R, NC-17, NR, Unrated. No user-defined rating values are supported in this feature.
- The MCM Architecture constraints (as referenced in the PRD) apply to this feature's implementation, including the BFF pattern, Keycloak authentication, and microservice boundaries.
