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

## Source shape (measured live 2026-08-14)

```jsonc
{ "id": 412117, "title": "The Secret Life of Pets 2",
  "release_dates": { "results": [
    { "iso_3166_1": "US", "release_dates": [
        { "certification": "PG", "type": 3, "release_date": "2019-06-07T00:00:00.000Z", "note": "" },
        { "certification": "PG", "type": 5, "release_date": "2019-08-27T00:00:00.000Z", "note": "" } ] } ] } }
```

## Behaviour table

Every row below is a **real film**, measured against live TMDB on 2026-08-14 — not an invented shape.

| TMDB id | Film | US certifications, published order | `rated` |
|---|---|---|---|
| 412117 | The Secret Life of Pets 2 | `PG`, `PG` | `"PG"` |
| 603 | The Matrix | `R`, `R`, `""` | `"R"` |
| 396535 | Train to Busan | `NR`, `NR` | `"NR"` — the source really says not-rated (FR-005) |
| 152747 | All Is Lost | `""`, `PG-13`, `PG-13` | `"PG-13"` — **the first entry is empty** |
| 986280 | Fallen Leaves | seven `""`, then `NR`, `NR` | `"NR"` — same trap, seven deep |
| 411397 | Agnes | `""` only | `null` |
| 1245424 | Nightless Night | *no US block at all* | `null` |
| — | any value outside the vocabulary (e.g. `TV-14`) | — | `null` (FR-006) |
| — | the request fails | — | unchanged from today: the error propagates and the add fails. The tool does **not** return a candidate with a blank rating |

Rows 4 and 5 are the reason FR-003a says *first non-empty* rather than *first*: a naive
`us[0]["release_dates"][0]["certification"]` returns `""` for both films and silently loses a real
`PG-13`/`NR`. This is not a hypothetical edge case — it is the second and fifth film checked.

## Downstream

`to_movie_payload` (`agents/movie-assistant/src/proposals.py:167`) writes the candidate's value to
the add payload's `rated` key. The key is always present — `"rated": null` when unknown — because
`CreateMovieDto` requires it (research R5).

Callers that never obtain a candidate from this tool — spreadsheet import, organize/update — are
unaffected (FR-007).

## Verification

Both tiers block a merge, and they cover different things:

- **Unit** — `mcp-servers/web-api-mcp/tests/unit/`, driving the tool through a stubbed httpx
  transport over every row above, including the two shapes that need no network to be wrong.
  Permitted at this tier by §Test Type Integrity; the same stub under `tests/integration/` would
  violate it.
- **Integration** — `mcp-servers/web-api-mcp/tests/integration/test_tmdb.py`, against real TMDB.
  This is the only check that the shape above is still what TMDB returns. It runs in the dev
  container (TMDB allowlisted — research R4a) and in CI (web-api-mcp enrolled with skip-escalation —
  research R4b). A skip is a failure there, because a clean skip on an absent key is
  indistinguishable from a pass.

Pin the live assertions to the stable, high-traffic films (412117, 603, 396535, 152747). The
low-traffic rows (411397, 1245424) prove the `null` cases but their TMDB records are editable by
anyone, so they belong in the unit fixtures rather than in a live assertion that could drift.
