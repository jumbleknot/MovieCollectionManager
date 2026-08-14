# Contract — `get_movie_details` gains the film's US certification

**Server**: `web-api-mcp` (outbound-only, TMDB) · **Tool**: `get_movie_details(source_id)`
**Extends**: `specs/012-multi-agent-mvp/contracts/web-api-mcp-tools.md`
**Requirements**: FR-001 … FR-006, FR-002a

## Request

One request, unchanged in count. The existing `/movie/{id}` call carries an additional
`append_to_response=release_dates` parameter so the certification arrives with the details
(FR-002a). No second call is made, and there is therefore no state in which the details resolved but
the certification did not.

## Response — `EnrichedMovieCandidate`

```jsonc
{
  "source": "tmdb",
  "sourceId": "tmdb:412117",
  "title": "The Secret Life of Pets 2",
  "year": 2019,
  "overview": "…",
  "genres": ["Animation", "Comedy", "Family"],
  "posterUrl": "https://image.tmdb.org/t/p/w500/…",
  "language": "English",
  "rated": "PG"        // NEW — validated certification, or null
}
```

`rated` is the only addition. Every other field keeps its current meaning and shape.

## Extraction rules

Applied to the US entry of the appended release-dates data, in order:

1. Consider only US entries.
2. Take the **first non-empty** certification string in the order the source publishes them
   (FR-003a). Do not combine entries, do not prefer a release type, do not take the most
   restrictive.
3. Accept it only if it is one of `G`, `PG`, `PG-13`, `R`, `NC-17`, `NR`, `Unrated` (FR-003).
   These are the values the product stores and exchanges — there is **no** `PG13`/`NC17` form at any
   boundary (research R1).
4. Anything else — no US entry, an empty string, an unrecognised value — yields `null` (FR-004,
   FR-006). Never a guess, never a substituted `NR`, and never a failed add.

`NR` therefore appears only when the source itself published `NR` (FR-005).

## Behaviour table

| Source state | `rated` |
|---|---|
| US entry, certification `PG` | `"PG"` |
| US entry, certification `PG-13` | `"PG-13"` |
| US entry, certification `NR` | `"NR"` |
| Several US entries: `""`, then `PG`, then `PG-13` | `"PG"` (first non-empty) |
| US entry with `""` only | `null` |
| No US entry at all | `null` |
| US entry with `TV-14` (outside the vocabulary) | `null` |
| The request fails | unchanged from today — the error propagates and the add fails; the tool does **not** return a candidate with a blank rating |

## Downstream

`to_movie_payload` (`agents/movie-assistant/src/proposals.py:167`) writes the candidate's value to
the add payload's `rated` key. The key is always present — `"rated": null` when unknown — because
`CreateMovieDto` requires it (research R5).

Callers that never obtain a candidate from this tool — spreadsheet import, organize/update — are
unaffected (FR-007).

## Verification

- **Merge-blocking**: unit tests under `mcp-servers/web-api-mcp/tests/unit/`, driving the tool
  through a stubbed httpx transport over every row of the table above. Permitted at this tier by
  §Test Type Integrity; the same stub under `tests/integration/` would violate it.
- **Live shape**: an assertion added to `mcp-servers/web-api-mcp/tests/integration/test_tmdb.py`,
  which runs against real TMDB. It runs neither in CI nor in this devcontainer (research R3/R4), so
  it must be executed by hand on a host with TMDB egress before the feature is called done.
