# Feature Specification: Spreadsheet Import & Export (Movie Assistant)

**Feature Branch**: `014-spreadsheet-import-export`

**Created**: 2026-06-13

**Status**: Draft

**Input**: User description: "Movie assistant import and export collections from/to spreadsheet, plus make movie language optional" (see `docs/PRD-ImportExportSpreadsheet.md`)

## Clarifications

### Session 2026-06-13

- Q: How should a confirmed import behave if a single movie write fails part-way through? → A: Best-effort per movie — continue past failures and report failed rows in the result summary (not all-or-nothing).
- Q: Is there an upper bound on import size, and how are large imports processed? → A: No fixed cap — process the import in chunks with visible progress, ending in a single result summary.
- Q: At the import preview, what can the user exclude before confirming? → A: Whole tabs may be excluded; individual movies cannot (tab-level granularity only).
- Q: Which sorting articles qualify for title normalization? → A: English only — "The", "A", "An"; anything else falls to the FR-015 uncertainty prompt.
- Q: What file format does export produce? → A: A single multi-tab spreadsheet workbook (.xlsx) only; CSV export is out of scope.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Make movie language optional (Priority: P1)

A user adds a movie to a collection without knowing or caring about its spoken language. The system accepts the movie and stores it with no language value, rather than blocking the save.

**Why this priority**: This is a small, self-contained change to the existing application and is a prerequisite enabler for spreadsheet import — imported rows frequently have no language column, and today a movie cannot be saved without one. Shipping it first unblocks import of language-less data and delivers immediate value on its own.

**Independent Test**: Add a movie via the form leaving the language field blank, save successfully, and confirm the movie appears in the collection and displays gracefully (with a neutral placeholder) everywhere a language is normally shown.

**Acceptance Scenarios**:

1. **Given** the add-movie form, **When** the user fills in title/year/content type but leaves language blank and submits, **Then** the movie is created and no "language required" error is shown.
2. **Given** an existing movie with a language, **When** the user edits it and clears the language, **Then** the change is saved and the movie now shows no language.
3. **Given** a collection containing movies with and without a language, **When** the user sorts or filters by language, **Then** movies without a language are grouped/handled consistently and never cause an error.
4. **Given** an existing movie that already has a language, **When** no change is made, **Then** its language is preserved (no regression for existing data).

---

### User Story 2 - Import a spreadsheet into matching collections (Priority: P1)

A user has a spreadsheet of movies and wants the movie assistant to load it into their collections. They select the file; the assistant figures out which tabs hold movie data, which collection each tab belongs to, what each column means, cleans up titles and multi-value fields, shows a preview of what will change, and on confirmation creates new movies and updates existing ones without losing existing data.

**Why this priority**: This is the headline capability of the feature and the primary user value — getting existing movie data into the app in bulk. The happy path (tabs whose names exactly match one collection, clearly-named columns) is independently valuable and testable.

**Independent Test**: Import the provided sample spreadsheet (`docs/test-data/sample-movies.xlsx`) where each tab name exactly matches an existing collection and columns are clearly named; confirm the preview, and verify the correct movies are created in the correct collections with multi-value fields split and titles normalized.

**Acceptance Scenarios**:

1. **Given** a selected spreadsheet, **When** the assistant inspects it, **Then** only tabs containing at least Title, Year, and Content Type are considered for import and all other tabs are ignored.
2. **Given** a tab whose name exactly matches exactly one existing collection, **When** import proceeds, **Then** that tab's movies are targeted at that collection without asking the user to choose.
3. **Given** a column whose header and values clearly correspond to a movie attribute, **When** mapping columns, **Then** it is auto-mapped; columns with no plausible correspondence are ignored and not imported.
4. **Given** a title stored with a trailing sorting article (e.g., "Matrix, The"), **When** it is imported, **Then** it is stored with the article moved to the front (e.g., "The Matrix").
5. **Given** a multi-value column using a delimiter (e.g., "Sci-Fi|Action"), **When** it is imported into a multi-value attribute (Genre, Directors, Tags), **Then** each delimited value is stored as a separate value.
6. **Given** a movie in the import that does not already exist in the target collection, **When** import is confirmed, **Then** it is created as a new movie.
7. **Given** a movie in the import that already exists in the target collection, **When** import is confirmed, **Then** only the attributes supplied by the import are updated and no existing attribute is blanked out where the import provides no value.
8. **Given** all resolutions are complete, **When** import is ready, **Then** the assistant shows a preview (what will be created vs. updated, and into which collections) and applies nothing until the user confirms.
9. **Given** the user confirms the preview, **When** the import runs, **Then** a result summary reports counts of movies created, updated, skipped, and failed.
10. **Given** the preview lists multiple tabs, **When** the user excludes a tab and confirms, **Then** the excluded tab's movies are not written and are reported as skipped, while the remaining tabs are applied.

---

### User Story 3 - Export selected collections to a spreadsheet (Priority: P2)

A user wants a spreadsheet copy of one or more of their collections. They ask the assistant to export, pick which collections to include, and receive a single spreadsheet with one tab per collection.

**Why this priority**: A clean, lower-risk slice that delivers standalone value (backup, sharing, offline editing) and complements import, but is less urgent than getting data in. It does not depend on the import stories.

**Independent Test**: Request an export, select two collections from the multi-select, and verify the produced spreadsheet has one correctly-named tab per selected collection, each movie attribute in its own column, and multi-value attributes pipe-delimited.

**Acceptance Scenarios**:

1. **Given** the user requests an export, **When** prompted, **Then** they are shown a multi-select of their collections to include.
2. **Given** the user selects two or more collections, **When** the export is produced, **Then** the spreadsheet contains a separate tab for each selected collection.
3. **Given** a collection is exported, **When** the tab is produced, **Then** every movie attribute (excluding collection-level and user/ownership information) appears as its own column.
4. **Given** a movie with multiple values for an attribute (Genre, Directors, Tags), **When** exported, **Then** those values appear in a single column as a pipe-delimited string (e.g., "Sci-Fi|Action").
5. **Given** the export is produced, **When** it completes, **Then** the user can save/download the spreadsheet file.

---

### User Story 4 - Guided clarification when import is ambiguous (Priority: P3)

When the assistant cannot confidently resolve part of an import, it asks the user instead of guessing or failing — which collection an unmatched tab belongs to, whether a medium-confidence column maps to an attribute, and whether an uncertain trailing word is really a sorting article. Every choice is offered as a selectable button.

**Why this priority**: Extends the import happy path (US2) to handle the messy real-world cases. Valuable but not required for an MVP import of well-formed data; it layers on top of US2.

**Independent Test**: Import a spreadsheet containing a tab whose name matches zero collections, a column with an ambiguous header, and a title with an uncertain trailing word; confirm the assistant prompts for each via buttons and applies the user's choices correctly.

**Acceptance Scenarios**:

1. **Given** a tab whose name matches zero existing collections or more than one, **When** import reaches that tab, **Then** the assistant prompts the user to choose the target collection for that tab.
2. **Given** a column whose mapping to an attribute is only medium-confidence, **When** mapping columns, **Then** the assistant asks the user to confirm the mapping rather than auto-applying or silently dropping it.
3. **Given** a title where it is unclear whether a trailing word is a sorting article, **When** normalizing the title, **Then** the assistant asks the user how to interpret it.
4. **Given** any of these prompts, **When** the user is asked to choose, **Then** the choices are presented as disambiguation buttons (consistent with the existing assistant interaction style), not as free-text instructions.

---

### Edge Cases

- **CSV files** have no tabs: a CSV is treated as a single sheet and must still meet the Title/Year/Content Type minimum; collection targeting falls back to the per-import collection prompt since there is no tab name to match (or matches by the file name if it equals a collection name).
- **A tab with no eligible movie data** (missing one of Title/Year/Content Type) is silently ignored and reported as skipped in the summary.
- **An empty file, a corrupt/unreadable file, or an unsupported file type** is rejected with a clear message and no partial import.
- **A row missing a required value** (e.g., no title or no year) within an otherwise-eligible tab is skipped and counted, rather than failing the whole import.
- **A duplicate-within-the-import** (the same movie appears twice in one tab) is resolved deterministically (last value wins) and reported.
- **Movie language absent** in the import: the movie is created/updated without a language (depends on US1).
- **Very large files**: there is no fixed size cap; the import is processed in chunks with visible progress so it remains responsive rather than appearing to hang, and produces one final summary.
- **Export of a collection with zero movies**: produces an empty (header-only) tab rather than omitting the collection.
- **Export of an attribute with no value** on a given movie: the cell is left blank, not filled with a placeholder.
- **A movie title that legitimately contains a comma** (not a sorting article, e.g., "Goodbye, Lenin!"): the assistant must not wrongly "correct" it — handled via the uncertainty prompt (US4).

## Requirements *(mandatory)*

### Functional Requirements

#### Optional language (US1)

- **FR-001**: System MUST allow a movie to be created with no language value.
- **FR-002**: System MUST allow a movie's language to be cleared (set to no value) on edit.
- **FR-003**: System MUST preserve the language of existing movies that already have one (no data loss or backfill required).
- **FR-004**: System MUST display, sort, and filter movies that have no language without error, representing the absence consistently (e.g., a neutral "—"/"Unknown" treatment in lists and filters).
- **FR-005**: The add/edit movie form MUST NOT block submission solely because language is empty.

#### Import (US2, US4)

- **FR-006**: Users MUST be able to browse for and select a file to import; supported formats are CSV and spreadsheet (multi-tab) files.
- **FR-007**: System MUST inspect each tab/sheet of the selected file and determine whether it contains movie data.
- **FR-008**: System MUST treat a tab as eligible for import only if it contains at least Title, Year, and Content Type; ineligible tabs MUST be ignored.
- **FR-009**: For each eligible tab, if the tab name exactly matches exactly one existing collection name, System MUST target that collection without prompting.
- **FR-010**: If an eligible tab name matches zero collections or more than one collection, System MUST prompt the user to select the target collection for that tab.
- **FR-011**: System MUST determine each column's meaning from a combination of column header and column values, mapping a column to a movie attribute only on a high-confidence match.
- **FR-012**: For medium-confidence column matches, System MUST ask the user to confirm the mapping before importing that column.
- **FR-013**: For low-confidence column matches, System MUST ignore the column (do not map, do not import it).
- **FR-014**: System MUST detect titles stored with a trailing sorting article and normalize them to leading-article form (e.g., "Matrix, The" → "The Matrix"; "Beautiful Day in the Neighborhood, A" → "A Beautiful Day in the Neighborhood"). The recognized articles are the English articles "The", "A", and "An" (matched as a trailing ", The" / ", A" / ", An"); any other trailing word is treated as uncertain and handled per FR-015.
- **FR-015**: When it is unclear whether a trailing word is a sorting article, System MUST ask the user how to interpret it rather than guessing.
- **FR-016**: For attributes that allow multiple values (e.g., Genre, Directors, Tags), System MUST split delimited cell content (e.g., on "|") into separate values.
- **FR-017**: For each movie in the import, System MUST determine whether the movie already exists in the target collection.
- **FR-018**: If the movie does not exist in the target collection, System MUST create it as a new movie.
- **FR-019**: If the movie already exists in the target collection, System MUST update only the attributes provided by the import and MUST NOT blank out any existing attribute for which the import supplies no value.
- **FR-020**: After all resolutions are complete and before any data is written, System MUST present a preview of the pending changes (movies to be created vs. updated, and target collections) and MUST NOT apply changes until the user explicitly confirms.
- **FR-020a**: At the preview, System MUST allow the user to exclude one or more whole tabs from the import before confirming; excluded tabs are not written and are reported as skipped. Excluding individual movies is out of scope (tab-level granularity only).
- **FR-021**: After a confirmed import, System MUST report a summary including counts of movies created, updated, skipped, and failed (with reason categories for skips and failures).
- **FR-021a**: During the write phase, System MUST apply each movie independently (best-effort): a single movie failing MUST NOT abort the import; remaining movies continue to be applied and the failure is reported in the result summary.
- **FR-021b**: System MUST NOT impose a fixed maximum import size; large imports MUST be processed in chunks with visible progress to the user, converging on a single result summary when complete (no apparent hang).
- **FR-022**: System MUST reject empty, corrupt, unreadable, or unsupported files with a clear message and perform no partial import.

#### Export (US3)

- **FR-023**: Users MUST be able to request an export of their collections through the movie assistant.
- **FR-024**: System MUST present a multi-select choice of the user's collections to export.
- **FR-025**: System MUST export each selected collection into a separate tab within a single multi-tab spreadsheet workbook (`.xlsx`), with the tab named for the collection. CSV export is out of scope (it cannot represent multiple tabs).
- **FR-026**: System MUST export all movie attributes except collection-level and user/ownership information, each attribute in its own column.
- **FR-027**: System MUST export multi-value attributes (e.g., Genre, Directors, Tags) as a single pipe-delimited column (e.g., "Sci-Fi|Action").
- **FR-028**: System MUST allow the user to save/download the produced spreadsheet.

#### Interaction & access (all)

- **FR-029**: Any choice presented to the user during import or export MUST be offered as a disambiguation button, consistent with the existing assistant interaction style.
- **FR-030**: Import and export MUST operate only on collections the requesting user is authorized to read/modify, applying the same access rules as the rest of the application.
- **FR-031**: An import that creates or updates movies MUST cause the affected on-screen collection/movie lists to reflect the changes once the import completes.

### Key Entities *(include if feature involves data)*

- **Import File**: A user-selected CSV or spreadsheet. A spreadsheet has one or more **Tabs**; a CSV is a single implicit tab.
- **Tab / Sheet**: A named grid of rows and columns within an import file. Eligible when it contains at least Title, Year, and Content Type. Its name is used to match a target Collection.
- **Column Mapping**: The resolved correspondence between an import column and a movie attribute, with a confidence level (high → auto, medium → confirm, low → ignore).
- **Movie**: The existing collection item. Gains the ability to have no language. Multi-value attributes (Genre, Directors, Tags) hold lists; matched against existing movies within a target collection for create-vs-update.
- **Collection**: The existing grouping of movies, owned by a user. Import targets one collection per tab; export produces one tab per collection.
- **Import Preview**: The pending, not-yet-applied set of create/update operations shown for confirmation.
- **Import Result Summary**: Post-import counts (created, updated, skipped + skip reasons).
- **Export Document**: The produced single spreadsheet containing one tab per selected collection.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can add a movie with no language in a single attempt with no validation error, and the movie is visible in its collection immediately afterward.
- **SC-002**: Importing the provided sample spreadsheet (`docs/test-data/sample-movies.xlsx`) results in 100% of eligible tabs' valid rows being created or updated in the correct collections, with zero existing attributes wrongly blanked.
- **SC-003**: For a spreadsheet whose tab names exactly match collections and whose columns are clearly named, the user completes the import (file selection → preview → confirm) without being asked any clarification question.
- **SC-004**: Every multi-value field in the sample data is round-trip faithful: exporting then re-importing a collection produces the same set of values for Genre, Directors, and Tags (order-independent).
- **SC-005**: Re-importing the same file a second time results in 0 newly-created movies and 0 unintended attribute changes (idempotent for unchanged data).
- **SC-006**: 100% of user choices during import/export are presented as selectable buttons (no step requires the user to type a free-text answer to proceed).
- **SC-007**: An ambiguous import (unmatched tab, medium-confidence column, uncertain article) is resolvable entirely through the offered buttons and completes successfully.
- **SC-008**: Exporting selected collections produces a single file with exactly one correctly-named tab per selected collection and one column per exported attribute, openable in common spreadsheet software.
- **SC-009**: No import writes any data before the user confirms the preview (verified by cancelling at the preview step leaving the collection unchanged).

## Assumptions

- **Platform scope**: Web is the MVP target for import and export (US1–US4 deliver on web). Mobile (Android) import/export is a planned follow-on and is **out of scope for this feature's MVP**; this is a documented, intentional deviation from the cross-client E2E parity principle, justified by the web-centric nature of file browse/download. US1 (optional language) applies to both web and mobile since it is a form/display change, not file I/O.
- **Commit model**: Import is preview-then-confirm — the assistant shows what will change and applies nothing until the user confirms.
- **Movie identity for create-vs-update**: A movie is considered to "already exist" in the target collection when its (normalized) title matches an existing movie in that collection, consistent with the application's existing case-insensitive per-collection title uniqueness. Year may be used as a tie-breaker when titles collide.
- **CSV handling**: A CSV is treated as a single sheet with no tab name; its target collection is resolved via the collection prompt (or by file name if it exactly matches one collection).
- **Supported formats**: Import accepts CSV and the spreadsheet format of the provided sample (`.xlsx`). Export produces a single `.xlsx` workbook only. Other proprietary formats are out of scope.
- **Delimiter**: The pipe character ("|") is the canonical multi-value delimiter for both import detection and export output; import may also recognize the same delimiter the sample data uses.
- **Required minimum on import**: Title, Year, and Content Type are the minimum to consider a tab/row importable; rows missing any of these are skipped and counted.
- **Attribute set**: Importable/exportable movie attributes are the existing movie attributes already modeled in the application (e.g., title, year, content type, language, genres, directors, actors, tags, rating, owned/ripped/childrens flags, owned media, rip quality, external IDs), excluding collection-level and user/ownership fields.
- **Assistant-driven**: Both import and export are initiated and guided through the existing movie assistant, reusing its disambiguation-button interaction pattern and its authorization model.
- **Existing infrastructure**: The feature reuses the existing collections/movies data store, the assistant gateway, and the access-control rules already in place; no new identity or storage system is introduced.
