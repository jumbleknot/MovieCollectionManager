"""T032 (row transform): a parsed string row → a typed mc-service movie payload.

`build_row_payload` maps the high-confidence columns of a row to typed attributes (year/runtime
→ int, Yes/No → bool, multi-values split, externalIds assembled from id+URL column pairs into
{system, uniqueId, url}); a BLANK cell yields NO attribute (so an update preserves it — FR-019)
and the title is article-normalized. `apply_create_defaults` fills the mc-service-required
fields (owned/ripped/childrens → False, the list fields → []) only when building a CREATE.

Verified against MovieDto/CreateMovieDto + the domain enums (ContentType, MediaFormat,
UsaRating, ExternalIdentifier) in backend/mc-service/src/.

Covers: US2-AC3/AC4/AC5, FR-011/014/016/019.
"""

from __future__ import annotations

from src.nodes.import_resolvers import (
    apply_create_defaults,
    build_row_payload,
    resolve_columns,
)

SAMPLE_ROW = {
    "Title": "Matrix, The",
    "Year": "1999",
    "Video Type": "Movie",
    "Children's": "No",
    "Owned": "Yes",
    "Media": "Blu-Ray|DVD",
    "Ripped": "No",
    "Rip Quality": "",
    "MPAA": "R",
    "Language": "English",
    "Directors": "Lana Wachowski|Lilly Wachowski",
    "Actors": "Keanu Reeves",
    "Genres": "Action|Sci-Fi",
    "Tags": "",
    "Original Title": "",
    "Release Date": "1999-03-31",
    "Outline": "",
    "Plot": "A hacker discovers reality is a simulation.",
    "Runtime": "136",
    "Set": "",
    "IMDB Id": "tt0133093",
    "IMDB URL": "https://www.imdb.com/title/tt0133093/",
    "TMDB Id": "603",
    "TMDB URL": "https://www.themoviedb.org/movie/603",
    "Pick": "x",
    "Rating": "8.7",
}


def _mappings(row: dict[str, str]) -> list:
    return resolve_columns([{"header": h, "sampleValues": [v]} for h, v in row.items()])


def test_typed_scalar_and_enum_coercion() -> None:
    payload = build_row_payload(SAMPLE_ROW, _mappings(SAMPLE_ROW))
    assert payload["title"] == "The Matrix"  # article-normalized
    assert payload["year"] == 1999  # int
    assert payload["runtime"] == 136
    assert payload["contentType"] == "Movie"
    assert payload["rated"] == "R"
    assert payload["language"] == "English"
    assert payload["releaseDate"] == "1999-03-31"
    assert payload["plot"].startswith("A hacker")


def test_boolean_coercion() -> None:
    payload = build_row_payload(SAMPLE_ROW, _mappings(SAMPLE_ROW))
    assert payload["owned"] is True
    assert payload["childrens"] is False
    assert payload["ripped"] is False


def test_multi_value_split() -> None:
    payload = build_row_payload(SAMPLE_ROW, _mappings(SAMPLE_ROW))
    assert payload["ownedMedia"] == ["Blu-Ray", "DVD"]
    assert payload["directors"] == ["Lana Wachowski", "Lilly Wachowski"]
    assert payload["genres"] == ["Action", "Sci-Fi"]
    assert payload["actors"] == ["Keanu Reeves"]


def test_external_ids_assembled_from_id_and_url_pairs() -> None:
    payload = build_row_payload(SAMPLE_ROW, _mappings(SAMPLE_ROW))
    ext = payload["externalIds"]
    by_system = {e["system"]: e for e in ext}
    assert by_system["IMDB"]["uniqueId"] == "tt0133093"
    assert by_system["IMDB"]["url"] == "https://www.imdb.com/title/tt0133093/"
    assert by_system["TMDB"]["uniqueId"] == "603"
    assert by_system["TMDB"]["url"] == "https://www.themoviedb.org/movie/603"


def test_blank_cells_are_not_supplied() -> None:
    """A blank cell must yield NO attribute so an update preserves the existing value (FR-019)."""
    payload = build_row_payload(SAMPLE_ROW, _mappings(SAMPLE_ROW))
    for blank in ("ripQuality", "tags", "originalTitle", "outline", "movieSet"):
        assert blank not in payload


def test_blank_boolean_is_not_supplied() -> None:
    row = {**SAMPLE_ROW, "Owned": ""}
    payload = build_row_payload(row, _mappings(row))
    assert "owned" not in payload  # blank → preserve on update, not forced False


def test_ignored_columns_do_not_appear() -> None:
    payload = build_row_payload(SAMPLE_ROW, _mappings(SAMPLE_ROW))
    # 'Pick' (low) and a numeric 'Rating' (low) map to no attribute.
    assert "rated" not in payload or payload["rated"] == "R"  # rated came from MPAA, not Rating
    assert all(k in _ALL_MOVIE_ATTRS for k in payload)


def test_unparseable_year_is_not_supplied() -> None:
    row = {**SAMPLE_ROW, "Year": "n/a"}
    payload = build_row_payload(row, _mappings(row))
    assert "year" not in payload


def test_apply_create_defaults_fills_required_fields() -> None:
    supplied = {"title": "Coherence", "year": 2013, "contentType": "Movie"}
    payload = apply_create_defaults(supplied)
    assert payload["owned"] is False
    assert payload["ripped"] is False
    assert payload["childrens"] is False
    for list_field in ("directors", "actors", "genres", "tags", "ownedMedia", "ripQuality",
                       "externalIds"):
        assert payload[list_field] == []
    # Supplied values preserved; create defaults never overwrite them.
    assert payload["title"] == "Coherence"
    assert payload["year"] == 2013


def test_apply_create_defaults_does_not_clobber_supplied() -> None:
    supplied = {"title": "X", "year": 2000, "contentType": "Movie", "owned": True,
                "genres": ["Action"]}
    payload = apply_create_defaults(supplied)
    assert payload["owned"] is True
    assert payload["genres"] == ["Action"]


_ALL_MOVIE_ATTRS = {
    "title", "year", "contentType", "language", "owned", "ripped", "childrens",
    "originalTitle", "releaseDate", "outline", "plot", "runtime", "rated", "directors",
    "actors", "movieSet", "tags", "genres", "ownedMedia", "ripQuality", "externalIds",
}
