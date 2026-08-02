# Feature Specification: Movie Assistant Enhancements & Fixes

**Feature Branch**: `047-movie-assistant-enhancements`

**Created**: 2026-08-02

**Status**: Draft

**Input**: User description: `docs/proposals/PRD-MovieAssistantMoreEnhancements.md` — "More Movie Assistant Enhancements": (1) a way to cancel out of a web search result card, (2) capture media formats and rip quality when a movie is added as owned, (3) the import assistant loops forever on a title with a trailing comma-word, (4) "navigate to &lt;collection name&gt;" fails with a generic error, (5) importing a 2,000+ row spreadsheet hangs.

## Clarifications

### Session 2026-08-02

- Q: Where should the new media-format / ripped / rip-quality follow-up questions apply? → A: Every assistant-mediated add — wherever the assistant already asks "Do you own this?" — not only adds started from a web search result card.
- Q: How should the member select multiple media formats (and multiple rip qualities)? → A: A toggle list with a Done action — tap each option on/off, then confirm once; the whole selection is submitted in a single exchange.
- Q: What should happen when a 2,000+ row import needs more write operations than the per-user agent rate allowance permits? → A: An approved bulk import runs under its own allowance, sized so 2,000 rows finish inside the 10-minute target; the per-user allowance for ordinary interactive commands is unchanged.
- Q: What happens if a large import is interrupted part-way (connection drops, app closed, session expires)? → A: Rows already applied stay applied; the member is told the import ended early and how far it got, and re-uploading the same file finishes the job without creating duplicates.
- Q: How should import progress be presented to the member? → A: A single progress line in the conversation that updates in place as rows are processed, and becomes the final report when the import ends.

## User Scenarios & Testing *(mandatory)*

Three defects and two enhancements, each independently shippable. Priorities put restoring broken behaviour ahead of new capability.

### User Story 1 - Open a collection by name from the assistant (Priority: P1)

A member types "navigate to Sci-Fi" (or any collection name) in the assistant dock and expects the app to open that collection. Today the assistant replies "Sorry — I couldn't complete that just now. Please try again." — behaviour that used to work and stopped working as the member's library grew.

**Why this priority**: A previously working, frequently used capability is broken outright, and the generic failure message gives the member nothing to act on. It also fails hardest for members with the largest libraries — exactly the people who most need navigation help.

**Independent Test**: With an account holding several collections and at least one collection containing thousands of movies, type "navigate to &lt;collection name&gt;" in the assistant dock and confirm the app opens that collection's screen. Delivers value on its own with no other story implemented.

**Acceptance Scenarios**:

1. **Given** a member with a collection named "Sci-Fi" containing 2,500 movies, **When** they ask the assistant to "navigate to Sci-Fi", **Then** the app opens the Sci-Fi collection screen and the assistant confirms it opened that collection.
2. **Given** a member with several collections, **When** they ask to navigate to a collection whose name matches none of theirs, **Then** the assistant asks which collection they meant and offers their collections as choices — it does not reply with a generic failure.
3. **Given** a member who names a movie rather than a collection ("take me to Dune"), **When** that movie exists in exactly one of their collections, **Then** the app opens that movie's detail screen.
4. **Given** a member whose library is large, **When** they issue a navigation request, **Then** the assistant answers within the expected response time and never returns the generic failure message for a request it could have resolved.
5. **Given** the assistant genuinely cannot resolve a navigation request, **When** it replies, **Then** the reply says what it could not find and what the member can do next — not an undifferentiated "couldn't complete that".

---

### User Story 2 - Answer an import sorting question once and move on (Priority: P2)

A member imports a spreadsheet containing "Three Billboards Outside Ebbing, Missouri " (note the trailing space). The assistant correctly asks how the title should be sorted, but whatever the member answers it asks the same question again, forever, and the import never proceeds.

**Why this priority**: The loop makes spreadsheet import unusable for any sheet containing such a title, and there is no way out of it short of abandoning the conversation. It gates Story 3 in practice, because a large sheet is very likely to contain at least one such title.

**Independent Test**: Import a small spreadsheet containing a title with a trailing comma-word and trailing whitespace, answer the sorting question once (once by tapping a button, once by typing the answer), and confirm the assistant accepts the answer, moves to the next question or the import preview, and never re-asks that title.

**Acceptance Scenarios**:

1. **Given** a sheet row titled `Three Billboards Outside Ebbing, Missouri ` (with trailing whitespace), **When** the assistant asks how it should be sorted and the member taps one of the offered options, **Then** the answer is accepted and the assistant proceeds to the next unresolved question or the import preview.
2. **Given** the same question, **When** the member types the title back without the trailing whitespace, **Then** the answer is accepted — leading and trailing whitespace never affects whether an answer matches.
3. **Given** a title the member has already answered for, **When** the assistant continues collecting decisions for the same import, **Then** it never asks about that title again.
4. **Given** a member's reply that matches none of the offered options, **When** the assistant re-asks, **Then** the re-ask makes clear the reply was not understood and offers a way to abandon the import; it does not repeat the identical question indefinitely.
5. **Given** an imported title with leading or trailing whitespace, **When** the movie is created, **Then** the stored title has the surrounding whitespace removed.
6. **Given** a sheet with several distinct ambiguous titles, **When** the assistant collects decisions, **Then** it asks about each distinct ambiguous title exactly once and shows how many decisions remain.

---

### User Story 3 - Import a large spreadsheet to completion (Priority: P3)

A member imports a 2,000+ row spreadsheet (the "Movies" tab of their library export). Today the import hangs — no preview, no progress, no report, no error.

**Why this priority**: Bulk import is the primary way members get an existing library into the product, and it fails at exactly the size that makes it worth doing. It is ranked below Story 2 only because a large import cannot succeed while the questioning loop is unfixed.

**Independent Test**: Upload a spreadsheet whose "Movies" tab holds 2,000+ rows, walk through the questions and preview, approve, and confirm every eligible row is created or updated and a final report is shown.

**Acceptance Scenarios**:

1. **Given** a spreadsheet tab with 2,000+ rows, **When** the member uploads it, **Then** the assistant produces an import preview showing the create/update/skip counts rather than stalling with no response.
2. **Given** an approved import of 2,000+ rows, **When** the import runs, **Then** a single progress line in the conversation advances in place (for example "1,200 of 2,300 processed") and is replaced by the final report when the import completes.
3. **Given** an import of up to 5,000 rows in a single file, **When** it is approved, **Then** it completes successfully.
4. **Given** a file that exceeds the supported per-import size, **When** the member uploads it, **Then** the assistant says up front that the file is too large and how to proceed, rather than starting an import it cannot finish.
5. **Given** an import that fails part-way, **When** it stops, **Then** the report states how many rows were applied, how many were not, and why — the member is never left without an outcome.
6. **Given** a large import is running, **When** the member sends another message, **Then** the assistant remains responsive and the running import is not corrupted.

---

### User Story 4 - Record how I own a movie when adding it (Priority: P4)

A member asks the assistant to add a movie to a collection — whether by choosing "Add to collection" on a web search result or by typing "add Inception to Favorites". The assistant asks "Do you own this?". If they answer no, the movie is added as not owned (unchanged). If they answer yes, the assistant should go on to ask which media formats they own it on, whether it is ripped, and — if ripped — at what quality, before adding it. Today the "yes" answer only sets the owned flag; the member must then open the movie and edit it to record any of this.

**Why this priority**: A genuine enhancement rather than a fix, and the information can already be entered by editing the movie afterwards. Valuable because it removes a tedious second pass over every newly added owned movie.

**Independent Test**: Add a movie through the assistant, answer "yes" to the ownership question, select one or more media formats, answer the ripped question, select rip qualities where applicable, approve the add, and confirm the created movie carries exactly those values and the app lands on the new movie's detail screen. Repeat starting from a web search result card and from a typed add command — both must behave identically.

**Acceptance Scenarios**:

1. **Given** the assistant asks "Do you own …?", **When** the member answers no, **Then** the movie is added as not owned with no media formats and no rip quality, and the member lands on its detail screen — exactly as today.
2. **Given** the assistant asks "Do you own …?", **When** the member answers yes, **Then** the assistant offers the supported media formats as a toggle list with a confirm action, and more than one can be turned on before confirming.
3. **Given** the member has toggled two formats on and one back off, **When** they confirm the selection, **Then** only the two still-selected formats are carried forward and the assistant asks whether the movie is ripped.
4. **Given** the ripped question, **When** the member answers no, **Then** the movie is added as owned with the selected formats, not ripped, and no rip quality.
5. **Given** the ripped question, **When** the member answers yes, **Then** the assistant offers the supported rip qualities as a toggle list with a confirm action, and more than one can be turned on before confirming.
6. **Given** all ownership answers are collected, **When** the member approves the add, **Then** the created movie carries exactly the owned flag, media formats, ripped flag and rip qualities they chose, and the app navigates to the new movie's detail screen.
7. **Given** the member is part-way through the ownership questions, **When** they abandon the flow or ask for something unrelated, **Then** no movie is added and the pending add is discarded.
8. **Given** the member answers yes to owning but selects no media formats, **When** they continue, **Then** the movie is still added as owned with no formats recorded — the selection is not compulsory.

---

### User Story 5 - Back out of a web search result (Priority: P5)

A member searches for a movie, chooses "search the web", picks a version, and is shown that movie's card. The card's only action is "Add to collection". If it is the wrong film, or they have changed their mind, there is no way to dismiss it and end the search.

**Why this priority**: A small usability gap with an existing workaround (type "exit", or simply start a new request), so it is the lowest-value item — but it is also the cheapest to deliver.

**Independent Test**: Run a web search, pick a result, use the cancel action on the resulting card, and confirm the search ends with an acknowledgement and no movie is added.

**Acceptance Scenarios**:

1. **Given** a web search result card, **When** it is shown, **Then** it offers both "Add to collection" and a cancel action.
2. **Given** a web search result card, **When** the member cancels, **Then** the assistant confirms the search has ended, no movie is added, and the card no longer invites an add.
3. **Given** the member has cancelled, **When** they send their next message, **Then** it is treated as a fresh request with no leftover search context.
4. **Given** a web search result card, **When** the member chooses "Add to collection", **Then** the existing add flow runs unchanged.

---

### Edge Cases

- A collection name that is a substring of another ("Sci-Fi" and "Sci-Fi Classics") — the assistant must ask which was meant rather than silently opening the wrong one.
- A member with no collections at all issuing a navigation request.
- An import spreadsheet where every row's title carries trailing whitespace.
- A title whose final comma is followed by several words ("Crouching Tiger, Hidden Dragon") — a real title comma that must not be treated as a sorting word.
- An ambiguous-title question the member answers with something matching neither option.
- A large import where the connection drops or the session expires mid-run — the applied rows survive and the member is told where it stopped.
- A member re-uploading the same file after an interrupted import, expecting only the outstanding rows to be created.
- A large import containing rows that duplicate movies already in the target collection.
- A member answering "yes" to owned, selecting formats, then answering "yes" to ripped but selecting no rip qualities.
- A member re-answering an earlier ownership question after having moved on.
- Two question flows (import and ownership) overlapping in the same conversation.

## Requirements *(mandatory)*

### Functional Requirements

**Navigation (Story 1)**

- **FR-001**: The assistant MUST open the named collection when a member asks to navigate to a collection they own, regardless of how many movies that collection holds.
- **FR-002**: The assistant MUST resolve a navigation request without reading the full contents of the member's collections; a request naming a collection MUST NOT be made slower or less reliable by the size of that collection.
- **FR-003**: The assistant MUST answer a navigation request within the same response-time expectation as other assistant requests, for libraries up to 10,000 movies.
- **FR-004**: When a navigation target cannot be resolved, the assistant MUST say what it could not find and offer the member's collections as choices, instead of the generic "couldn't complete that" reply.
- **FR-005**: The generic degraded reply MUST be reserved for genuine provider/system failures, and MUST NOT be the observable outcome of an ordinary large-library navigation request.

**Import questioning (Story 2)**

- **FR-006**: The assistant MUST match a member's answer to an import question ignoring leading and trailing whitespace and letter case on both the answer and the offered options.
- **FR-007**: The assistant MUST record a resolved import decision so that the same question is never asked twice within one import.
- **FR-008**: The assistant MUST ask about every distinct ambiguous title in the sheet exactly once, and MUST indicate how many decisions remain.
- **FR-009**: When a member's reply matches none of the offered options, the assistant MUST say the reply was not understood, re-offer the options, and offer a way to abandon the import.
- **FR-010**: After two consecutive replies that resolve nothing, the assistant MUST offer an explicit way out of the import alongside the re-offered options; it MUST NOT re-ask the identical question a third time without that escape present.
- **FR-011**: The system MUST trim leading and trailing whitespace from every imported text value before matching against existing movies and before storing.
- **FR-012**: A title whose final comma is followed by more than one word MUST be treated as a genuine title comma and MUST NOT raise a sorting question.

**Large imports (Story 3)**

- **FR-013**: The system MUST successfully import a single file of up to 5,000 rows.
- **FR-014**: The system MUST show progress during an import large enough not to complete promptly, and that progress MUST advance as rows are processed.
- **FR-014a**: Progress MUST be shown as a single line in the conversation that updates in place — stating rows processed out of the total — and MUST NOT post a separate message per update.
- **FR-014b**: When the import ends, that same line MUST be replaced by the final report; the member MUST NOT be left with a stale progress figure as the last thing they see.
- **FR-015**: The system MUST reject a file exceeding the supported per-import size up front, stating the limit and advising the member to split the file.
- **FR-016**: An import that stops before finishing MUST report how many rows were applied, how many were not, and why.
- **FR-016a**: When an import is interrupted (connection lost, app closed, session expired), the rows already applied MUST remain applied — an interrupted import MUST NOT be rolled back.
- **FR-016b**: When the member next uses the assistant after an interrupted import, the assistant MUST tell them the import ended early and how many rows were applied, and MUST tell them that re-uploading the same file will finish it.
- **FR-017**: The assistant MUST remain responsive to the member while a large import is running.
- **FR-018**: Re-running an import that partially applied MUST NOT create duplicates of rows already applied.
- **FR-019**: The system MUST produce an import preview for a 2,000+ row sheet rather than stalling with no response.
- **FR-019a**: An approved bulk import MUST run under its own rate allowance, sized so that a 2,000-row import can complete within the target in SC-006. The allowance applied to ordinary interactive assistant commands MUST be unchanged, and the bulk allowance MUST remain scoped per authenticated member so one member's import cannot starve another's.
- **FR-019b**: If a bulk import is throttled despite its own allowance, it MUST wait and continue rather than failing, and the member MUST be told it is waiting rather than seeing progress silently stall.

**Ownership details on add (Story 4)**

- **FR-020**: When a member answers that they own a movie being added, the assistant MUST ask which media formats they own it on and MUST allow more than one to be chosen.
- **FR-020a**: The multi-valued selections (media formats, rip qualities) MUST be presented as a toggle list with an explicit confirm action: each option can be turned on and off, the member's current selection is visible before they confirm, and the whole selection is submitted in a single exchange.
- **FR-020b**: The toggle list MUST look and behave identically on web and Android, with no capability available on one and missing on the other.
- **FR-021**: The media formats offered MUST be exactly those the product supports for a movie's owned media.
- **FR-022**: After the media-format selection, the assistant MUST ask whether the movie is ripped.
- **FR-023**: When the member answers that the movie is ripped, the assistant MUST ask which rip qualities apply and MUST allow more than one to be chosen.
- **FR-024**: The rip qualities offered MUST be exactly those the product supports for a movie's rip quality.
- **FR-025**: When the member answers that they do not own the movie, the assistant MUST add it as not owned with no media formats and no rip quality, without asking any further ownership questions.
- **FR-026**: When the member answers that the movie is not ripped, the assistant MUST add it with no rip quality recorded.
- **FR-027**: The movie created MUST carry exactly the owned flag, media formats, ripped flag and rip qualities the member selected, and MUST satisfy the product's existing rules that media formats are recorded only for an owned movie and rip qualities only for a ripped one.
- **FR-028**: The ownership questions MUST be answerable without compulsion — selecting no media formats or no rip qualities MUST still allow the add to proceed.
- **FR-029**: Abandoning the ownership questions MUST discard the pending add and add nothing.
- **FR-030**: After a successful add, the member MUST be taken to the new movie's detail screen, unchanged from today.
- **FR-031**: These follow-up questions MUST apply to every assistant-mediated add — wherever the assistant asks whether the member owns the movie — regardless of whether the add started from a web search result card or a typed command, and MUST behave identically in both cases.
- **FR-031a**: Marking an already-existing movie as owned or ripped through other assistant commands, or through the movie edit screen, MUST be unchanged.

**Search cancellation (Story 5)**

- **FR-032**: A web search result card MUST offer a cancel action alongside "Add to collection".
- **FR-033**: Cancelling MUST end the search, acknowledge it to the member, and add nothing.
- **FR-034**: After cancelling, the member's next message MUST be handled as a fresh request with no leftover search context.
- **FR-035**: The cancel action MUST be reachable on both web and mobile.

**Cross-cutting**

- **FR-036**: All new single-answer prompts and actions MUST be operated by the same choose-or-type mechanism as the assistant's existing questions, so a member can answer either by selecting an offered option or by typing it. The multi-valued selections (FR-020a) MUST additionally accept a typed list of the options as an equivalent answer, so no step of these flows is reachable only by tapping.
- **FR-037**: Every write in these flows MUST remain behind the existing explicit-approval step; nothing here may write without the member confirming.
- **FR-038**: A member MUST never be shown, or able to act on, a collection or movie that is not theirs through any of these flows.

### Key Entities

- **Movie ownership details**: whether the member owns a movie, which media formats they own it on, whether it is ripped, and at which rip qualities. Media formats and rip qualities are each a multi-valued choice from the product's supported format list; formats are meaningful only for an owned movie and rip qualities only for a ripped one.
- **Import decision**: a member's answer to one import question (which collection a tab targets, what a column holds, or how a title should be sorted), keyed by the thing being asked about, recorded once and reused for the remainder of that import.
- **Import run**: one member-approved import of a spreadsheet — its total row count, how many rows have been processed, and its outcome (applied, skipped, failed) per row.
- **Search session**: the in-progress web/collection search a member is stepping through, which ends when they pick a result, cancel, or start something else.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of "navigate to &lt;collection name&gt;" requests naming a collection the member owns open that collection, including for libraries of 10,000 movies.
- **SC-002**: A navigation request returns an answer in under 5 seconds at the 95th percentile for libraries up to 10,000 movies.
- **SC-003**: The generic "couldn't complete that" reply no longer appears for any navigation request the assistant is able to resolve.
- **SC-004**: An import question, once answered, is never asked again — zero repeat questions across an import of a sheet containing at least ten distinct ambiguous titles.
- **SC-005**: A member can complete the question phase of an import containing a trailing-whitespace title in a finite, predictable number of exchanges — one per distinct ambiguous title, with no repeats.
- **SC-006**: A 2,000-row import completes end to end, with every eligible row created or updated, in under 10 minutes.
- **SC-007**: A 5,000-row import completes successfully.
- **SC-008**: During any import taking longer than 10 seconds, the member sees progress that advances at least every 10 seconds, and the whole import adds no more than one progress line to the conversation.
- **SC-009**: An import that cannot finish always ends with a report; the proportion of imports ending with no outcome at all is zero.
- **SC-010**: A member adding an owned movie can record its media formats, ripped status and rip qualities entirely within the assistant conversation, with no follow-up visit to the movie edit screen — at least halving the steps needed to record a fully specified owned movie.
- **SC-011**: 100% of movies created through the ownership question flow carry exactly the values the member selected.
- **SC-012**: A member can abandon a web search from the result card in a single action, on both web and mobile.

## Assumptions

- **Supported media formats and rip qualities** are the product's existing fixed set used everywhere else a movie's owned media and rip quality are recorded; this feature introduces no new format values.
- **Ownership follow-up scope**: the new media-format / ripped / rip-quality questions extend the existing "Do you own this?" question and therefore apply to every assistant-mediated add, however it was started (clarified 2026-08-02). Marking an already-existing movie as owned or ripped through other assistant commands or the movie edit screen is unchanged.
- **Selections are optional**: a member may answer "yes, I own it" and select no media formats, or "yes, it is ripped" and select no rip qualities. The add proceeds with what they gave.
- **Ambiguous-title questioning** keeps the current detection rule — a title whose final comma is followed by a single non-article word is ambiguous — and, per the product owner's decision, every distinct such title is asked about rather than defaulted. Titles ending in a comma followed by "The", "A" or "An" continue to be reordered automatically without asking.
- **Import size ceiling** is 5,000 rows in a single file. Files above that are refused up front with guidance to split them; supporting arbitrarily large files is out of scope.
- **Progress reporting** is a single in-place-updating line within the assistant conversation (clarified 2026-08-02). A background-job system that continues an import after the member disconnects, and automatic resume, remain out of scope — an interrupted import keeps what it applied and is finished by re-uploading the same file.
- **Bulk-import rate allowance**: an approved import runs under its own per-member allowance sized to the SC-006 target, separate from the allowance governing ordinary interactive assistant commands (clarified 2026-08-02). This is an additional, member-scoped budget, not a removal of rate limiting.
- **Cancellation from the search card** ends the search workflow; it does not remove the already-rendered card from the conversation history, which remains a record of what was shown.
- **The navigation failure is a scale problem**, not a permissions or routing problem — the same request succeeds for small libraries today. The fix is expected to be in how the target is resolved, not in what the member is allowed to reach.
- **Existing safeguards are retained**: every write stays behind the current explicit-approval step, every read stays scoped to the member's own data, and the assistant's existing audit and logging behaviour is unchanged.
- **No new client platforms**: all behaviour must work identically on web and Android, consistent with the rest of the assistant.
- **The reference test data** for the large-import story is the existing sample workbook referenced in the proposal (`docs/test-data/large-import-sample.xlsx`, "Movies" tab).
