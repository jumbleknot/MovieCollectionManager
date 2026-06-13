# Movie Assistant import and export collections from/to spreadsheet

- first a change to existing application, which should no longer require language as a mandatory field when adding or updating a movie - leveraging recommended approach B from analysis below (Analysis: Impact of no longer requiring `language` as a mandatory field)
- add a feature to enable the movie assistant to import and export collections from/to a spreadsheet
- enable the user to browse for files and select a csv file or spreadsheet to import.  the import needs to check each tab in the spreadsheet and decide if there is movie data to be imported.  a minimum of title, year, and content type must exist for the tab to be imported - a tab without the minimum fields is ignored.  if the name of the tab to be imported matches exactly 1 collection name, then the tab should be imported to the collection with the matching name.  if the tab matches 0 collection names or more than 1 collection name, then for each tab prompt the user to select which collection to import into.
- when importing a tab to a collection, use a combination of tab column names and values to determine what attributes exist in each column.  only map tab columns to movie attributes where there is a high confidence match.  ask the user to clarify if there is a medium confidence match.  ignore low confidence matches (don't match, don't import those columns).
- when importing the movie title, check for sorting articles that may have been placed at the end of the movie title to enable the data to sort in the spreadsheet as we want these articles back at the start of the title (e.g., "Matrix, The" should be imported as "The Matrix"; "Beautiful Day in the Neighborhood, A" should be imported as "A Beautiful Day in the Neighborhood").  if the assistant is unclear if it is a sorting article, ask the user.
- when importing attributes that allow multiple values (e.g., Genre, Directors, Tags), look for delimiters (e.g., "|") and add each delimited string as a separate value.
- each movie that is imported first needs to validate if the movie already exists. if the movie does not exist, add as a new movie.  if the movie does exist, only update attributes that are provided (i.e., do not blank out any existing attributes where the import does not provide a value).
- enable the user to export movie collections to a spreadsheet.  the user must be displayed with a multi-select choice of what collections to export.  any selected collections will be exported into separate tabs in the spreadsheet.  all movie attributes, with the exception of collection or user information, should be exported.  each attribute will export into its own column.  attributes that allow multiple values (e.g., Genre, Directors, Tags) should be put in 1 column as a pipe delimited string (e.g., "Sci-Fi|Action")
- any choice given to the user should be presented as a disambiguation button
- I have provided sample data to test this process in docs\test-data\sample-movies.xlsx

---

## Analysis: Impact of no longer requiring `language` as a mandatory field

### Where "mandatory" is actually enforced

Only **3 spots** make `language` mandatory; everything else just *carries* the field:

1. `backend/mc-service/src/application/commands/create_movie.rs:50-56` — `RequiredStringSpec` rejects empty `language` → `ValidationError` (cited as FR-022)
2. `backend/mc-service/src/application/commands/update_movie.rs:49-56` — same check
3. `frontend/mcm-app/src/components/movie-form.tsx:151` — `if (!language.trim()) e.language = 'Language is required.'`, plus the `Language *` label and error UI (`movie-form.tsx:308-320`)

### Two ways to do it — very different blast radius

**Option A — allow empty string (minimal).** Keep `language: String` everywhere; just delete the two `RequiredStringSpec` checks and the frontend validation. Language becomes `""`-tolerant. ~4 files, no type changes, no migration. Downside: you store empty strings rather than a true "unknown", and filter/sort treat `""` as a value.

**Option B — make it truly optional (`Option<String>` / `string | undefined`).** Type-correct but ripples through the whole Clean Architecture stack:

| Layer | File | Change |
| --- | --- | --- |
| Domain entity | `movie.rs:54,88,100` | `language: Option<String>`, constructor signature |
| DTOs (Create/Update/Response) | `movie_dto.rs:19,50,79` | `Option<String>` + `#[serde(default)]` so the field can be absent on the wire |
| Command handlers | `create_movie.rs` / `update_movie.rs` | drop the spec check |
| DAO | `movie_dao.rs:24,88` | `Option<String>` + serde default so **existing docs without it deserialize** |
| Filter-options query | `get_filter_options.rs` | the distinct-languages aggregation must skip null/missing or you get a stray empty entry |
| Frontend type | `collection.ts:89,116` | `language?: string` (Movie, CreateMovieRequest, UpdateMovieRequest) |
| Frontend display | movie-list-item, movie-detail, movie-list, column-selector, movie-sort-control | render a fallback (e.g. "—") when absent; sort must handle null |
| Filter panel | `movie-filter-panel.tsx` | language chip group must tolerate absent values |

### Things that are *not* affected / already handle it

- **Agent / MCP path already defaults**: `agents/movie-assistant/src/proposals.py:175` sends `candidate.language or "English"`, and TMDB enrichment (`mcp-servers/web-api-mcp/src/tools.py:47-57`) falls back to the raw code. So assistant-added movies never hit the required check today — you'd decide whether to keep the `"English"` default or pass null.
- **MongoDB text index** — `language` is *not* part of the text-search index (the `language_override` gotcha in CLAUDE.md is about preventing Mongo from misreading the field, unrelated to requiredness). Making it optional doesn't touch search.
- **The `language_filter` index** (`indexes.rs:131`) is fine with sparse/missing values.
- **Existing data**: every current movie has a language, so Option B needs **no backfill** — only a serde default so future writes can omit it.

### Process cost (this repo's rules)

- **SDD**: FR-022 explicitly lists language as required, so this is a spec change — `spec.md` / `plan.md` / `tasks.md` (and possibly the constitution rationale) must be updated, not just code.
- **TDD/tests**: the `create_movie_required_fields_rejects_empty_language` test (`create_movie.rs:442`) and the equivalent update-movie test must be inverted (now *accepts* empty/absent). Frontend `movie-form.test.tsx` language-required assertions flip. Golden cassettes and integration fixtures hardcode `"English"` but still send it, so they keep passing — no re-record needed.
- **Validation gate**: per the checklist, a full web E2E run is required even though most of this is backend.

### Recommendation

Option B is the correct model ("unknown language" ≠ empty string) and the agent layer already anticipates it, but it's a genuine cross-layer change with an SDD/spec update. Option A is a 4-file, same-day change if you just want the form to stop blocking. Which one depends on whether you want a real nullable field or just to drop the form requirement.
