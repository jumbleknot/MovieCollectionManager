# Feature Specification: Post-Agent Enhancements

**Feature Branch**: `013-post-agent-enhancements`

**Created**: 2026-06-11

**Status**: Draft

**Input**: User description: "docs\PRD-PostAgentEnhancements.md"

## Clarifications

### Session 2026-06-11

- Q: Which fields can the user sort the collection's movie list by? → A: Any of the movie-list's displayed columns (e.g., Title, Year, plus other shown columns), each ascending/descending.
- Q: Does the chosen sort order persist across app restarts? → A: No — screen/session-scoped only; resets to the default (title→year, ascending) on a fresh open of the collection or app restart.
- Q: How many disambiguation candidates are shown as buttons, and what happens when there are more? → A: Show up to 5 candidate buttons; when more valid matches exist (e.g., "Star Wars" returning 10+), provide an elegant affordance to reach the additional matches so the user can still pick any valid option beyond the first 5 (no valid match is unreachable).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Sort movies in a collection (Priority: P1)

A user viewing a collection sees the movies presented in a meaningful, predictable order rather than in the order they happened to be added. By default the list is ordered by movie title, and where titles match, by year. The user can change the sort order, and the new order is reflected immediately in the list. Sorting works together with filtering: when a filter is active, only the filtered movies are shown and they remain sorted by the chosen order.

**Why this priority**: This is the most universally felt change — every user who opens any collection encounters the list ordering on every visit. A predictable default order (title, then year) makes a collection scannable and is the foundation the count line (Story 2) and filtering build on. It delivers standalone value even if no other story ships.

**Independent Test**: Open a collection containing several movies added in a non-alphabetical order; confirm the list displays sorted by title then year by default. Change the sort order and confirm the list re-orders accordingly. Apply a filter and confirm the filtered subset is still presented in the chosen sort order.

**Acceptance Scenarios**:

1. **Given** a collection whose movies were added in a non-alphabetical sequence, **When** the user opens the collection, **Then** the movies are displayed ordered by title ascending, with ties broken by year ascending.
2. **Given** a collection open with the default sort, **When** the user changes the sort order, **Then** the movie list reloads and is displayed in the newly selected order.
3. **Given** a collection with an active filter and a chosen sort order, **When** the filtered results render, **Then** the visible (filtered) movies appear in the chosen sort order.
4. **Given** a chosen non-default sort order, **When** the user changes or clears the active filter, **Then** the sort order is preserved and re-applied to the new result set.

---

### User Story 2 - See how many movies are in a collection (Priority: P2)

A user viewing a collection can see at a glance how many movies it contains. When the user applies a filter, the count communicates both how many movies match the filter and the total in the collection, shown as `[filtered count]/[total count]`. This count stays accurate as the list changes — after adding a movie, deleting a movie, or any list refresh, the displayed numbers update to reflect the current state.

**Why this priority**: A count gives the user immediate orientation ("how big is this collection?", "did my filter narrow it down?") and confirms that add/delete actions took effect. It depends on the same list-loading path as Story 1 and is low-effort, high-clarity polish, but it is not as foundational as the ordering itself.

**Independent Test**: Open a collection and confirm the total movie count is shown. Apply a filter and confirm the line shows `[matches]/[total]`. Add a movie and confirm the count increases; delete a movie and confirm it decreases; clear the filter and confirm the line returns to the total.

**Acceptance Scenarios**:

1. **Given** a collection with N movies and no filter applied, **When** the collection screen renders, **Then** an information line shows the total count N.
2. **Given** a collection with N movies, **When** the user applies a filter that matches M movies, **Then** the information line shows `M/N`.
3. **Given** a collection screen is showing a count, **When** a movie is added to the collection, **Then** the information line updates to reflect the new total without requiring the user to leave and re-open the screen.
4. **Given** a collection screen is showing a count, **When** a movie is deleted from the collection, **Then** the information line updates to reflect the reduced count.
5. **Given** a filtered count `M/N` is shown, **When** the user clears the filter, **Then** the information line returns to showing the total N.

---

### User Story 3 - Jump to a movie's details from an assistant card (Priority: P2)

After asking the assistant about a movie that exists in the user's collection, the assistant shows a movie card. The user can click (or tap) that card to be taken directly to that movie's detail screen, without having to manually navigate to the collection and find the movie.

**Why this priority**: This closes a frustrating dead-end in the assistant experience — the assistant surfaces the right movie but the user then has to find it again by hand. Making the card actionable turns a read-only answer into a navigation shortcut. It is high-value but narrower in reach than the collection-screen stories.

**Independent Test**: Ask the assistant about a movie that exists in a collection so it renders a movie card, then click/tap the card and confirm the app navigates to that movie's detail screen.

**Acceptance Scenarios**:

1. **Given** the assistant has rendered a movie card for a movie that exists in the user's collection, **When** the user clicks/taps the card, **Then** the app navigates to that movie's detail screen.
2. **Given** the user has navigated to a movie detail screen from an assistant card, **When** the detail screen loads, **Then** it shows the details for the same movie represented by the card.

---

### User Story 4 - Pick a match from assistant disambiguation buttons (Priority: P3)

When the user asks the assistant to look up a movie and there are multiple potential matches, the assistant presents the candidate matches as selectable buttons. The user clicks/taps the button for the intended match instead of having to retype the exact title (or other distinguishing detail) to disambiguate.

**Why this priority**: It removes friction from a common multi-turn interaction (ambiguous look-ups) and reduces user error from mistyping. It builds on the existing disambiguation flow, so it is an enhancement to an already-working path rather than net-new capability.

**Independent Test**: Ask the assistant to look up a movie whose title matches multiple candidates; confirm the candidates render as clickable buttons; click one and confirm the assistant proceeds with that specific match (the same outcome as if the user had typed it).

**Acceptance Scenarios**:

1. **Given** an assistant look-up that returns multiple potential matches, **When** the assistant presents the result, **Then** each candidate match (up to 5) is shown as a distinct selectable button.
2. **Given** disambiguation buttons are shown, **When** the user clicks/taps one candidate's button, **Then** the assistant proceeds using that candidate as the chosen match.
3. **Given** disambiguation buttons are shown, **When** the user selects a candidate, **Then** the outcome is equivalent to the user having typed that candidate's distinguishing detail.
4. **Given** a look-up returns more than 5 valid matches (e.g., "Star Wars"), **When** the assistant presents the result, **Then** the first 5 are shown as buttons and an affordance is available to reach the remaining valid matches so the user can still select one beyond the first 5.

---

### User Story 5 - TMDB external link saved with scraped movies (Priority: P3)

When the assistant scrapes a movie's details from the external movie database and adds it to the user's library, it records an external link to that movie's page on the external database, formatted as a well-formed URL (pattern: `https://www.themoviedb.org/movie/[id]`). The user can later open that link from the movie's detail screen to view the source page.

**Why this priority**: It improves the completeness and traceability of assistant-added records, letting users get back to the authoritative source. It is valuable data hygiene but does not change a core interaction flow, so it ranks below the navigation and ordering work.

**Independent Test**: Ask the assistant to look up and add a movie sourced from the external database; open the added movie's detail screen and confirm an external ID entry is present whose URL follows the `https://www.themoviedb.org/movie/[id]` pattern and opens the correct source page.

**Acceptance Scenarios**:

1. **Given** the assistant scrapes a movie from the external movie database and adds it to a collection, **When** the movie record is saved, **Then** it includes an external ID entry with a URL of the form `https://www.themoviedb.org/movie/[id]` using that movie's identifier.
2. **Given** an assistant-added movie with a TMDB external link, **When** the user opens the external link from the movie detail screen, **Then** it opens the corresponding source page for that movie.

---

### User Story 6 - Ask the assistant to navigate to a movie's details (Priority: P3)

The user can ask the assistant to navigate them to a specific movie's detail page, not only to a collection. The assistant resolves the requested movie and takes the user to that movie's detail screen.

**Why this priority**: It extends an existing, working navigation capability (navigate-to-collection) to a finer-grained target, completing the assistant's navigation coverage. It is an incremental extension rather than a new surface, so it sits with the other P3 enhancements.

**Independent Test**: Ask the assistant to navigate to a specific movie that exists in the user's collection; confirm the app navigates to that movie's detail screen.

**Acceptance Scenarios**:

1. **Given** a movie that exists in one of the user's collections, **When** the user asks the assistant to navigate to that movie, **Then** the app navigates to that movie's detail screen.
2. **Given** a navigation request naming a movie that does not uniquely resolve, **When** the assistant cannot determine a single target, **Then** the assistant asks the user to clarify rather than navigating to an incorrect movie.

---

### Edge Cases

- **Empty collection**: The information line shows a total of 0, and the sort controls remain usable (no movies to order).
- **Filter matches nothing**: The information line shows `0/[total]`, and the (empty) list is shown without error.
- **Ties in sort**: When two movies share both title and year, the order between them is stable and deterministic across reloads.
- **Sort + filter interaction**: Changing the filter does not reset the chosen sort order, and changing the sort order does not clear the active filter.
- **Assistant card for a movie not in any collection** (e.g., a look-up result that was never added): clicking such a card either has no navigation target or the behavior is clearly defined so the user is not taken to a broken screen. *(See Assumptions.)*
- **Disambiguation with many candidates**: Up to 5 candidate buttons are shown; when more valid matches exist (e.g., "Star Wars"), an overflow affordance keeps every valid candidate reachable rather than overflowing the interface or hiding valid options.
- **Navigate to a movie that doesn't exist or is ambiguous**: The assistant asks for clarification or reports it could not find the movie instead of navigating to the wrong place.
- **External database movie missing an identifier**: If a scraped movie has no usable external identifier, no malformed external link is saved.

## Requirements *(mandatory)*

### Functional Requirements

#### Collection sorting (Story 1)

- **FR-001**: The collection view MUST load and display movies according to a sort order rather than insertion/added order.
- **FR-002**: The default sort order MUST be by movie title ascending, with ties broken by year ascending.
- **FR-003**: Users MUST be able to change the sort order applied to the collection's movie list. The selectable sort fields MUST be any of the columns currently displayed in the movie list (e.g., Title, Year, and any other shown columns), and the user MUST be able to choose ascending or descending direction for the chosen field.
- **FR-004**: When the sort order changes, the movie list MUST reload and re-render in the newly selected order.
- **FR-005**: Sorting MUST be applied to the data as served by the backend service (i.e., the ordered result is produced server-side), not only re-ordered after the fact on a single page of already-loaded data.
- **FR-006**: Sorting and filtering MUST work in conjunction: when a filter is active, the filtered subset MUST be returned/displayed in the chosen sort order.
- **FR-007**: Changing or clearing the active filter MUST preserve the user's chosen sort order within the current view.
- **FR-007a**: The chosen sort order is scoped to the current view/session and MUST reset to the default (title ascending, then year ascending) on a fresh open of the collection screen or an app restart; it is NOT persisted as a stored user preference.

#### Collection count information line (Story 2)

- **FR-008**: The collection view MUST display the number of movies in the collection.
- **FR-009**: When a filter is active, the information line MUST display the filtered result count and the total collection count in the form `[filtered count]/[total count]`.
- **FR-010**: When no filter is active, the information line MUST display the total collection count.
- **FR-011**: The information line MUST update whenever the displayed list refreshes, including after a movie is added, after a movie is deleted, and after a filter is applied or cleared.

#### Clickable assistant movie card (Story 3)

- **FR-012**: A movie card rendered by the assistant for a movie that exists in the user's collection MUST be actionable (clickable/tappable).
- **FR-013**: Activating an assistant movie card MUST navigate the user to the detail screen of the movie that card represents.

#### Assistant disambiguation buttons (Story 4)

- **FR-014**: When an assistant look-up yields multiple potential matches, the assistant MUST present the candidate matches as individually selectable buttons, showing up to 5 candidates (the most relevant first).
- **FR-014a**: When more than 5 valid matches exist, the assistant MUST provide an affordance to reach the additional matches (e.g., a "show more" action or equivalent) such that any valid candidate remains selectable — no valid match may be permanently hidden by the cap.
- **FR-015**: Selecting a candidate button MUST cause the assistant to proceed using that candidate as the chosen match, equivalent to the user having typed that candidate's distinguishing detail.

#### TMDB external link on scraped movies (Story 5)

- **FR-016**: When the assistant adds a movie scraped from the external movie database, the saved record MUST include an external ID entry containing a URL formed from the pattern `https://www.themoviedb.org/movie/[id]`, where `[id]` is that movie's external-database identifier.
- **FR-017**: The saved external link MUST be a well-formed URL that, when opened, resolves to the corresponding movie's source page.
- **FR-018**: If a scraped movie has no usable external identifier, the system MUST NOT save a malformed or placeholder external link.

#### Assistant navigation to a movie (Story 6)

- **FR-019**: The assistant's navigation capability MUST support navigating to a specific movie's detail screen, in addition to navigating to a collection.
- **FR-020**: When a navigation request does not uniquely resolve to a single movie, the assistant MUST ask the user to clarify (or report that it could not find the movie) rather than navigating to an incorrect movie.

### Key Entities *(include if feature involves data)*

- **Collection**: A named grouping of movies owned by a user. Relevant attributes for this feature: total number of movies it contains; the movies belonging to it.
- **Movie**: A record within a collection. Relevant attributes for this feature: title, year (used for default ordering), the set of external IDs/links, and an identity that supports navigation to its detail screen.
- **External ID / link**: An entry on a movie that records an outside reference, including a label/source and a URL (e.g., the external movie database link `https://www.themoviedb.org/movie/[id]`).
- **Sort order selection**: The user's chosen ordering for a collection's movie list (default: title then year), applied in conjunction with any active filter.
- **Filter selection**: The user's active filtering criteria for a collection's movie list, applied together with the sort order and reflected in the count information line.
- **Assistant movie card**: A visual representation the assistant renders for a specific movie, which can act as a navigation target to that movie's detail screen.
- **Assistant match candidate**: One of several potential movies returned by an ambiguous look-up, presentable as a selectable button.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: On opening any non-empty collection, 100% of the time the movie list is presented in the default title-then-year order before the user takes any action.
- **SC-002**: After a user changes the sort order, the list is re-presented in the newly chosen order with no further user action, and the chosen order is retained when the user applies, changes, or clears a filter within that view.
- **SC-003**: When a filter is active, the count information line correctly reflects `[filtered count]/[total count]` for every filter change, matching the actual number of visible movies and the actual collection size.
- **SC-004**: The count information line reflects the correct total within one refresh cycle after a movie is added or deleted, with no stale count remaining visible.
- **SC-005**: A user who receives an assistant movie card for an in-collection movie can reach that movie's detail screen in a single click/tap.
- **SC-006**: For an ambiguous assistant look-up, the user can select the intended match in a single click/tap without typing any disambiguating text, and the assistant proceeds with the selected match. When more than 5 valid matches exist, the user can still reach and select any valid match via the overflow affordance.
- **SC-007**: 100% of movies added by the assistant from the external movie database that have a usable identifier carry an external link matching the `https://www.themoviedb.org/movie/[id]` pattern that opens the correct source page.
- **SC-008**: A user can reach a specific movie's detail screen by asking the assistant to navigate to it, for any movie that uniquely resolves within their collections.
- **SC-009**: All new behaviors above are demonstrated on both supported client platforms (web and mobile) via the project's end-to-end tests.

## Assumptions

- **Platform parity**: These enhancements apply to both supported clients (web and mobile), consistent with the project's cross-client testing requirement. Where an interaction is described as "click," the mobile equivalent is "tap."
- **Sortable fields (Story 1)**: Resolved in Clarifications — the user may sort by any column currently displayed in the movie list, each ascending or descending. The default order remains title then year, ascending.
- **Sort persistence**: Resolved in Clarifications — the chosen sort order is scoped to the current view/session (surviving filter changes and list refreshes) and resets to the default on a fresh collection open or app restart; it is not stored as a user preference.
- **Default sort tie-breaking**: After title and year, a stable deterministic tie-breaker is applied so repeated loads return the same order.
- **Filtering is pre-existing**: The collection movie list already supports filtering; this feature ensures sort and the count line operate correctly in conjunction with that existing filtering, rather than introducing filtering.
- **Assistant card scope (Story 3)**: The clickable-card behavior targets cards the assistant renders for movies that exist in the user's collection (the PRD scenario). Cards for look-up-only results not yet in any collection are out of scope for navigation; activating such a card does not navigate to a movie detail screen.
- **External database identity (Story 5)**: The external movie database referenced is TMDB, and each scraped movie exposes a numeric/string identifier sufficient to build the `https://www.themoviedb.org/movie/[id]` URL.
- **Navigation resolution (Story 6)**: "Navigate to a movie" relies on the assistant resolving a user-named movie to a single movie within the user's collections; ambiguous or unfound requests result in a clarification prompt rather than a guess.
- **Existing assistant infrastructure**: This feature extends the existing conversational assistant, its movie-card rendering, its disambiguation flow, and its navigation capability rather than building any of them from scratch.
