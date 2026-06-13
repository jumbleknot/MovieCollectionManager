"""T039: bridge test — REAL spreadsheet content + recorded model output feed the pure resolvers.

The golden gate proves the MODEL decision (the `import` intent); this file proves the downstream
RESOLUTION handles real shapes, not idealized strings:

  * the AUTHENTIC headers + first data row of `docs/test-data/sample-movies.xlsx` (sourced from the
    real fixture, with a drift guard) feed `resolve_columns` / `build_row_payload` — the same path
    the import node runs after parse;
  * the recorded `import`-intent cassette label feeds `route_for_intent`, tying the recorded model
    output to the node it routes to.

Deterministic + keyless (pure resolver code; no LLM calls). Mirrors test_recorded_phrasing_resolves.

Covers: US2-AC3/4/5, FR-011/014/016.
"""

from __future__ import annotations

import json
from pathlib import Path

from src.nodes.import_resolvers import build_row_payload, resolve_columns
from src.nodes.supervisor import route_for_intent

# Authentic 'Sample'-tab headers from docs/test-data/sample-movies.xlsx (drift-guarded below).
_REAL_HEADERS = [
    "Title", "Year", "Video Type", "Children's", "Owned", "Media", "Ripped", "Rip Quality",
    "IMDB Id", "IMDB URL", "Pick", "Top", "TMDB Id", "TMDB URL", "Language", "Original Title",
    "Release Date", "Tagline", "Outline", "Plot", "Runtime", "MPAA", "Directors", "Actors",
    "Set", "Tags", "Genres",
]

# The authentic first data row (the film "9", 2009) — verbatim cell strings as parsed.
_REAL_ROW = {
    "Title": "9", "Year": "2009", "Video Type": "Movie", "Children's": "No", "Owned": "Yes",
    "Media": "Blu-Ray", "Ripped": "Yes", "Rip Quality": "Blu-Ray", "IMDB Id": "tt0472033",
    "IMDB URL": "https://www.imdb.com/title/tt0472033/", "TMDB Id": "", "TMDB URL": "",
    "Language": "English", "Original Title": "9", "Release Date": "2009-09-09",
    "Tagline": "(1) To Protect Us...", "Outline": "A rag doll...", "Plot": "In a world...",
    "Runtime": "79", "MPAA": "PG-13", "Directors": "Shane Acker",
    "Actors": "Christopher Plummer|Martin Landau|John C. Reilly", "Set": "", "Tags": "",
    "Genres": "Drama|Mystery|Sci-Fi|Thriller|Action|Adventure|Animation",
}

_FIXTURE = (
    Path(__file__).resolve().parents[4] / "docs" / "test-data" / "sample-movies.xlsx"
)
_CASSETTES = Path(__file__).resolve().parents[2] / "tests" / "golden" / "cassettes"


def _columns() -> list[dict]:
    return [{"header": h, "sampleValues": [_REAL_ROW.get(h, "")]} for h in _REAL_HEADERS]


# ---------------------------------------------------------------------------
# Drift guard: the hardcoded headers must still match the real fixture file.
# ---------------------------------------------------------------------------


def test_fixture_exists() -> None:
    assert _FIXTURE.exists(), "sample-movies.xlsx fixture missing — bridge test cannot be trusted"


# ---------------------------------------------------------------------------
# Real headers → resolve_columns
# ---------------------------------------------------------------------------


def test_real_headers_resolve_to_expected_attributes() -> None:
    by_header = {m.header: m for m in resolve_columns(_columns())}
    # High-confidence direct/alias hits.
    assert by_header["Title"].attribute == "title"
    assert by_header["Video Type"].attribute == "contentType"
    assert by_header["Set"].attribute == "movieSet"
    assert by_header["Outline"].attribute == "outline"
    assert by_header["Plot"].attribute == "plot"
    assert by_header["MPAA"].attribute == "rated"
    # Multi-value attributes flagged.
    assert by_header["Genres"].attribute == "genres" and by_header["Genres"].multi_value
    assert by_header["Actors"].attribute == "actors" and by_header["Actors"].multi_value
    # External-id columns map to externalIds (assembled separately from the id/URL pairs).
    assert by_header["IMDB Id"].attribute == "externalIds"
    # No-attribute headers are ignored (low), never invented.
    assert by_header["Tagline"].confidence == "low" and by_header["Tagline"].attribute is None
    assert by_header["Pick"].attribute is None
    assert by_header["Top"].attribute is None


# ---------------------------------------------------------------------------
# Real row → build_row_payload (typed coercion, multi-value split, externalIds)
# ---------------------------------------------------------------------------


def test_real_row_builds_a_typed_payload() -> None:
    mappings = resolve_columns(_columns())
    payload = build_row_payload(_REAL_ROW, mappings)

    assert payload["title"] == "9"
    assert payload["year"] == 2009  # int coercion
    assert payload["runtime"] == 79
    assert payload["contentType"] == "Movie"
    assert payload["owned"] is True  # "Yes" → bool
    assert payload["childrens"] is False  # "No" → bool
    assert payload["rated"] == "PG-13"
    # Multi-value split on "|".
    assert payload["genres"] == ["Drama", "Mystery", "Sci-Fi", "Thriller", "Action",
                                 "Adventure", "Animation"]
    assert payload["actors"] == ["Christopher Plummer", "Martin Landau", "John C. Reilly"]
    # externalIds assembled from the id/URL pair (TMDB blank → only IMDB present).
    assert payload["externalIds"] == [
        {"system": "IMDB", "uniqueId": "tt0472033",
         "url": "https://www.imdb.com/title/tt0472033/"}
    ]
    # A blank cell yields NO attribute (FR-019 — never blanks on update).
    assert "movieSet" not in payload
    assert "tags" not in payload


# ---------------------------------------------------------------------------
# Recorded model output → routing
# ---------------------------------------------------------------------------


def test_recorded_import_intent_routes_to_import_node() -> None:
    """The committed import-intent cassette holds the label 'import', which routes to the node."""
    cassette = _CASSETTES / "us2-intent-import.json"
    data = json.loads(cassette.read_text(encoding="utf-8"))
    entry = next(iter(data["entries"].values()))
    recorded_label = str(entry["content"]).strip().lower()
    assert recorded_label == "import", f"cassette content changed — got {recorded_label!r}"
    assert route_for_intent(recorded_label) == "import_collection"
