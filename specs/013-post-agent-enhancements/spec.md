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

### Session 2026-06-12 (Increment 2 — post-testing bug fixes & enhancements)

- Q: Should the unified search workflow REPLACE today's separate "find"/"navigate" behaviors for all search-style prompts, or only engage for ambiguous/unspecified cases? → A: Replace — every search-style prompt (search / open / navigate to / go to / show me / look up / find / a bare movie title) routes into ONE search workflow with a single resolution path.
- Q: When the workflow runs a web (TMDB) search returning several results, how are they presented? → A: As selectable result buttons (cap 5 + "view more"); selecting one shows that movie's read-only TMDB preview card (carrying the clickable themoviedb.org link).
- Q: Is the search workflow strictly read-only, or can the web preview card add to a collection? → A: The web preview card includes an "add to collection" action that enters the existing approval-gated (HITL) add flow; the workflow itself never writes without that explicit, approved action.

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
5. **Given** the user previously changed the sort order, **When** they leave and re-open the collection screen (a fresh open), **Then** the list is presented in the default title→year order again (the chosen order is session-scoped, not a stored preference).

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

### User Story 7 - Unified assistant search workflow (Priority: P1) 🎯 Increment 2

Any search-style prompt — "search X", "open X", "navigate to X", "go to X", "show me X", "look up X", "find X", or a bare movie title — starts a single conversational search workflow. The workflow resolves which collection to search, asks the user to choose when the target is ambiguous, presents matches as selectable buttons (never auto-picking), and can fall back to a web (TMDB) search. This replaces the previously separate "find" and "navigate-to-movie" behaviors with one consistent path, and fixes the two bugs found in testing (a generic "my collection" reference that was not resolved, and a multi-match request that silently opened the first result).

**Why this priority**: It is the foundation of the assistant's search experience and directly fixes two reported defects (Bug 1, Bug 2). Every other Increment-2 story builds on or feeds into it.

**Independent Test**: From any app state, ask "show me Avatar in my collection" (no collection named) and confirm the assistant searches the right single collection (current / default / only) or offers a choice — never sums across all collections; then ask for a title that matches several movies and confirm the assistant offers selectable buttons rather than opening the first match.

**Acceptance Scenarios**:

1. **(Bug 1)** **Given** the user is viewing a collection (or has a default, or has exactly one collection) and types "show me a movie in my collection" without naming a collection, **When** the workflow resolves the target, **Then** it searches that single resolved collection — current-screen collection if on one, else the default collection, else the only collection — and never reports an aggregate across all collections.
2. **(Bug 2)** **Given** a collection search returns more than one matching movie, **When** the results come back, **Then** the assistant presents the matches as selectable buttons (cap 5 + "view more") and does NOT navigate to the first match automatically.
3. **Given** the prompt names a collection, **When** the workflow runs, **Then** it searches that named collection.
4. **Given** the user has zero collections, **When** any search prompt is given, **Then** the workflow searches the web (TMDB) directly.
5. **Given** the user is not on a collection screen, has no default, and has more than one collection, **When** a search prompt is given, **Then** the assistant shows scope buttons: "search a collection" and "search the web".
6. **Given** the user chose "search a collection", **When** prompted, **Then** the assistant shows collection-name buttons (cap 5 + "view more") and searches the one the user selects.
7. **Given** a collection search returns no results, **When** the result comes back, **Then** the assistant states no match was found and shows control buttons: "search another collection", "search the web", "exit search".
8. **Given** a collection search returns one or more results, **When** the result comes back, **Then** the assistant shows the result buttons (cap 5 + "view more") plus "search another collection", "search the web", "exit search".
9. **Given** result buttons are shown, **When** the user selects an owned movie, **Then** the app navigates to that movie's detail screen.
10. **Given** the user chose "search the web", **When** the TMDB search returns results, **Then** the assistant shows result buttons (cap 5 + "view more"); selecting one shows that movie's read-only TMDB preview card.
11. **Given** the user selects "exit search", **When** activated, **Then** the assistant leaves the search workflow without navigating or writing anything.

---

### User Story 8 - Article-insensitive movie search (Priority: P2) 🎯 Increment 2

When the user searches for a movie, leading articles ("a", "an", "the") must not break the match: the assistant must not inject an article the user did not type, and a title is found whether or not the user (or the stored record) includes a leading article. This fixes Bug 3, where "secret of nimh" failed to match the stored "The Secret of NIMH".

**Why this priority**: A correctness fix that makes the search workflow (US7) usable for the very common case of titles beginning with an article.

**Independent Test**: With "The Secret of NIMH" in a collection, ask "show me secret of nimh in this collection" and confirm the assistant finds it (and does not respond about "The Secret of NIMH" not being present).

**Acceptance Scenarios**:

1. **(Bug 3a)** **Given** the user types a title without a leading article, **When** the assistant searches, **Then** it does NOT prepend an article the user did not type.
2. **(Bug 3b)** **Given** a stored title begins with a leading article and the user's query omits it (or vice-versa), **When** the assistant searches, **Then** the match succeeds (leading "a"/"an"/"the" is ignored on both sides).

---

### User Story 9 - Article-insensitive title sort (Priority: P2) 🎯 Increment 2

The collection's title sort must ignore leading articles so a title like "The Matrix" sorts under "M", not "T", matching common library/catalogue conventions. This refines the Story-1 sort.

**Why this priority**: A polish/correctness refinement to the shipped sort (Story 1); independent and low-risk.

**Independent Test**: In a collection containing "The Matrix", "Avatar", and "Zodiac", open the collection (default title sort) and confirm "The Matrix" orders between "Avatar" and "Zodiac" (by "Matrix"), not after "Zodiac".

**Acceptance Scenarios**:

1. **Given** the collection is sorted by title (default or chosen), **When** the list is ordered, **Then** a leading article ("a"/"an"/"the") on a title is ignored for ordering purposes.
2. **Given** article-insensitive title ordering, **When** the list is paginated, **Then** the ordering remains globally correct and stable across page boundaries.

---

### User Story 10 - Clickable TMDB link on the assistant web-search card (Priority: P3) 🎯 Increment 2

When the assistant shows a TMDB preview card for a movie found via a web search (US7), that card carries a clickable link to the movie's TMDB page, following the exact same rule and pattern as the link saved when a movie is added to a collection (Story 5). This lets the user review the movie on TMDB before deciding to add it.

**Why this priority**: A small, self-contained enhancement that reuses the Story-5 link pattern on a read surface; valuable but not blocking.

**Independent Test**: Run a web search via the assistant, open the resulting preview card, and confirm it shows a clickable `https://www.themoviedb.org/movie/[id]` link that opens the correct TMDB page.

**Acceptance Scenarios**:

1. **Given** the assistant renders a TMDB preview card from a web search, **When** the card is displayed, **Then** it carries a clickable `https://www.themoviedb.org/movie/[id]` link for that movie's TMDB identifier.
2. **Given** the preview card's link, **When** the user activates it, **Then** the correct TMDB movie page opens.

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
- **(Increment 2) Generic "my collection" reference**: An unqualified collection reference resolves to a single collection (current → default → only) or prompts for a choice — it is never treated as "all collections".
- **(Increment 2) Multiple movies share a search prefix**: When several titles match (e.g., two "Avatar…" entries), the workflow offers result buttons rather than opening the first.
- **(Increment 2) Title with a leading article**: A query that omits the article ("secret of nimh") still finds the stored "The Secret of NIMH", and vice-versa.
- **(Increment 2) Web search with many results**: TMDB results are capped at 5 buttons with a "view more" affordance, mirroring the look-up disambiguation cap.
- **(Increment 2) Web result is not owned**: Selecting a web result shows a read-only preview card (no detail screen to navigate to); adding it requires the explicit, approval-gated add action.
- **(Increment 2) User abandons the search**: "exit search" cleanly ends the workflow with no navigation or write; a subsequent search prompt starts fresh.

## Requirements *(mandatory)*

### Functional Requirements

#### Collection sorting (Story 1)

- **FR-001**: The collection view MUST load and display movies according to a sort order rather than insertion/added order.
- **FR-002**: The default sort order MUST be by movie title ascending, with ties broken by year ascending.
- **FR-003**: Users MUST be able to change the sort order applied to the collection's movie list. The selectable sort fields MUST be the single-valued columns currently displayed in the movie list (e.g., Title, Year, and other scalar shown columns), and the user MUST be able to choose ascending or descending direction for the chosen field. Columns whose value is a list (e.g., genres, directors, cast, owned-media, rip-quality) have no single well-defined ordering key and are therefore NOT offered as sort fields.
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

#### Unified assistant search workflow (Story 7 — Increment 2)

- **FR-021**: Any search-style prompt — "search …", "open …", "navigate to …", "go to …", "show me …", "look up …", "find …", or a bare movie title — MUST enter a single assistant search workflow. This workflow REPLACES the previously separate find-in-collection and navigate-to-movie behaviors as the resolution path for such prompts.
- **FR-022**: When the prompt names a collection, the workflow MUST search that named collection.
- **FR-023**: When the prompt does not name a collection, the workflow MUST resolve the target collection in this order: (a) if the user has no collections → search the web; (b) if the user is currently viewing a collection → search that collection; (c) else if a default collection exists → search the default; (d) else if exactly one collection exists → search that one; (e) else (more than one, no current, no default) → present scope buttons "search a collection" and "search the web".
- **FR-024**: When the user selects "search a collection", the workflow MUST present the user's collection names as selectable buttons, capped at 5 with a "view more" affordance to reach the rest, and MUST search the collection the user selects.
- **FR-025**: When a collection search returns no results, the workflow MUST state that no match was found and present control buttons: "search another collection", "search the web", and "exit search".
- **FR-026**: When a collection search returns one or more results, the workflow MUST present the matching movies as selectable buttons (capped at 5 with a "view more" affordance) alongside the control buttons "search another collection", "search the web", and "exit search". The workflow MUST NOT auto-select or navigate to the first match.
- **FR-027**: When the user selects a movie that exists in a collection, the workflow MUST navigate the user to that movie's detail screen.
- **FR-028**: When the user selects "search the web", the workflow MUST search the external movie database (TMDB) and present the results as selectable buttons (capped at 5 with a "view more" affordance); selecting one MUST show that movie's read-only TMDB preview card.
- **FR-029**: When the user selects "search another collection", the workflow MUST present the collection-name buttons again (FR-024) and search the newly selected collection.
- **FR-030**: When the user selects "exit search", the workflow MUST leave the search workflow without navigating or writing anything.
- **FR-031**: The TMDB preview card shown for a web result MUST offer an "add to collection" action that enters the existing approval-gated (human-in-the-loop) add flow; the search workflow MUST NOT persist any movie without that explicit, approved action.

#### Article-insensitive movie search (Story 8 — Increment 2)

- **FR-032**: The assistant MUST NOT inject a leading article ("a", "an", "the") into a search term the user did not type.
- **FR-033**: Movie-title matching within the search workflow MUST ignore a leading article ("a"/"an"/"the") on either the query or the stored title, so a title is found whether or not either side includes the article.

#### Article-insensitive title sort (Story 9 — Increment 2)

- **FR-034**: When the collection's movie list is sorted by title (default or user-chosen), a leading article ("a"/"an"/"the") MUST be ignored for ordering purposes (e.g., "The Matrix" orders by "Matrix").
- **FR-035**: Article-insensitive title ordering MUST remain globally correct and stable across pagination boundaries.

#### Clickable TMDB link on the web-search card (Story 10 — Increment 2)

- **FR-036**: A TMDB preview card the assistant shows for a web-search result MUST carry a clickable link of the form `https://www.themoviedb.org/movie/[id]`, formed by the same rule and pattern as the link saved when a movie is added to a collection (FR-016), and MUST omit the link when no usable identifier exists (per FR-018).
- **FR-037**: Activating the preview card's link MUST open the corresponding TMDB movie page.

### Key Entities *(include if feature involves data)*

- **Collection**: A named grouping of movies owned by a user. Relevant attributes for this feature: total number of movies it contains; the movies belonging to it.
- **Movie**: A record within a collection. Relevant attributes for this feature: title, year (used for default ordering), the set of external IDs/links, and an identity that supports navigation to its detail screen.
- **External ID / link**: An entry on a movie that records an outside reference, including a label/source and a URL (e.g., the external movie database link `https://www.themoviedb.org/movie/[id]`).
- **Sort order selection**: The user's chosen ordering for a collection's movie list (default: title then year), applied in conjunction with any active filter.
- **Filter selection**: The user's active filtering criteria for a collection's movie list, applied together with the sort order and reflected in the count information line.
- **Assistant movie card**: A visual representation the assistant renders for a specific movie, which can act as a navigation target to that movie's detail screen.
- **Assistant match candidate**: One of several potential movies returned by an ambiguous look-up, presentable as a selectable button.
- **Search workflow state**: The in-progress assistant search interaction — the resolved (or pending) target collection, the current search scope (a specific collection vs the web), the results awaiting a pick, and the available control actions. Scoped to the conversation; carries no persisted state.
- **Search scope / control action**: A selectable, non-movie button the workflow offers — scope choices ("search a collection", "search the web") and controls ("search another collection", "exit search") — distinct from a movie-result button.
- **Web preview card**: A read-only assistant card for a TMDB web-search result, carrying the movie's display details, a clickable TMDB link, and an "add to collection" action that defers to the existing approval-gated add flow.

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
- **SC-010**: For a search prompt that does not name a collection, the assistant searches exactly one correctly-resolved collection (current → default → only) or offers an explicit choice — in 100% of cases it never silently aggregates across all collections (closes Bug 1).
- **SC-011**: For a search that matches more than one movie, the user is always offered selectable result buttons and is never auto-navigated to the first match (closes Bug 2).
- **SC-012**: A title stored with a leading article is found when the user omits it (and vice-versa), and the assistant never injects an article the user did not type — verified for at least the "The Secret of NIMH" / "secret of nimh" case (closes Bug 3).
- **SC-013**: When sorted by title, titles beginning with a leading article order by their first non-article word in 100% of cases (e.g., "The Matrix" sorts under "M").
- **SC-014**: 100% of assistant web-search preview cards for results with a usable identifier present a clickable `https://www.themoviedb.org/movie/[id]` link that opens the correct TMDB page.
- **SC-015**: From any starting state, a user can complete a search end-to-end via buttons alone — resolve/choose a collection, pick from results, or fall back to the web and open a preview — without typing a disambiguating follow-up, and can leave at any point via "exit search".

## Assumptions

- **Platform parity**: These enhancements apply to both supported clients (web and mobile), consistent with the project's cross-client testing requirement. Where an interaction is described as "click," the mobile equivalent is "tap."
- **Sortable fields (Story 1)**: Resolved in Clarifications — the user may sort by any **single-valued** column currently displayed in the movie list, each ascending or descending. List-valued columns (genres, directors, cast, owned-media, rip-quality) are excluded because they have no single well-defined ordering key. The default order remains title then year, ascending.
- **Sort persistence**: Resolved in Clarifications — the chosen sort order is scoped to the current view/session (surviving filter changes and list refreshes) and resets to the default on a fresh collection open or app restart; it is not stored as a user preference.
- **Default sort tie-breaking**: After title and year, a stable deterministic tie-breaker is applied so repeated loads return the same order.
- **Filtering is pre-existing**: The collection movie list already supports filtering; this feature ensures sort and the count line operate correctly in conjunction with that existing filtering, rather than introducing filtering.
- **Assistant card scope (Story 3)**: The clickable-card behavior targets cards the assistant renders for movies that exist in the user's collection (the PRD scenario). Cards for look-up-only results not yet in any collection are out of scope for navigation; activating such a card does not navigate to a movie detail screen.
- **External database identity (Story 5)**: The external movie database referenced is TMDB, and each scraped movie exposes a numeric/string identifier sufficient to build the `https://www.themoviedb.org/movie/[id]` URL.
- **Navigation resolution (Story 6)**: "Navigate to a movie" relies on the assistant resolving a user-named movie to a single movie within the user's collections; ambiguous or unfound requests result in a clarification prompt rather than a guess.
- **Existing assistant infrastructure**: This feature extends the existing conversational assistant, its movie-card rendering, its disambiguation flow, and its navigation capability rather than building any of them from scratch.
- **(Increment 2) Unified workflow replaces prior paths**: Per Clarifications, the Story-7 workflow becomes the single resolution path for all search-style prompts, superseding the previously separate find-in-collection and navigate-to-movie behaviors. Re-tuning the assistant's intent routing for this is expected and may require re-recording the model-decision regression fixtures; pure-code resolution is preferred wherever it avoids a re-record.
- **(Increment 2) "Current collection" source**: "The collection the user is currently in" is determined from the same on-screen context the assistant already uses to resolve "this collection".
- **(Increment 2) Web search + add reuse existing flows**: The web (TMDB) search reuses the existing external look-up capability, and the "add to collection" action on a web preview card reuses the existing approval-gated add flow rather than introducing a new write path.
- **(Increment 2) Article handling scope**: "Article" means a leading "a", "an", or "the" (case-insensitive) at the start of a title or query; mid-title occurrences are not stripped.
- **(Increment 2) Read-only navigation safety**: Navigating to an owned movie and showing a read-only web preview remain within the user's own access scope; the existing centralized access control still governs every underlying read and the approval-gated add.
