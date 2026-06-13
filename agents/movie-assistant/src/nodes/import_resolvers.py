"""Pure-code resolvers for spreadsheet import (US2, feature 014).

Deterministic, LLM-free helpers the `import_collection` node composes during the
parse → map → normalize → dedup → preview pipeline. Keeping these pure (no graph, no
model, no IO) means they are exhaustively unit-testable via an adversarial matrix +
Hypothesis properties (012 Phase 9 / 013 Inc5 discipline) and never force a golden
re-record. The ONLY golden surface for import is the `import` intent classification.

Three resolver families live here:
  * column mapping     — spreadsheet header → movie attribute + confidence (FR-011/012/013)
  * title normalization — trailing English sorting article → leading form (FR-014/015)
    and `|`-delimited multi-value splitting (FR-016)
  * dedup / compose    — match an import row to an existing movie + compose a
    full-replacement payload that never blanks unsupplied attributes (FR-017/018/019)

Attribute names are the mc-service camelCase movie fields (see MovieDto /
CreateMovieDto in backend/mc-service/src/application/dtos/movie_dto.rs). There is no
`overview` field — the model has `outline` AND `plot`; do not invent fields.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from src.proposals import compose_movie_payload
from src.text_match import normalize_title

# ---------------------------------------------------------------------------
# Column mapping (FR-011/012/013)
# ---------------------------------------------------------------------------

# Multi-value attributes are split on `|` (data-model.md §1 / FR-016).
_MULTI_VALUE_ATTRIBUTES = frozenset(
    {"genres", "directors", "actors", "tags", "ownedMedia", "ripQuality", "externalIds"}
)

# Canonical high-confidence alias seeds: normalized header → movie attribute (data-model.md §4,
# verified against MovieDto / CreateMovieDto). Direct, unambiguous matches → confidence "high".
_ALIAS_TABLE: dict[str, str] = {
    "title": "title",
    "year": "year",
    "video type": "contentType",
    "children's": "childrens",
    "childrens": "childrens",
    "owned": "owned",
    "media": "ownedMedia",
    "ripped": "ripped",
    "rip quality": "ripQuality",
    "mpaa": "rated",
    "language": "language",
    "directors": "directors",
    "actors": "actors",
    "genres": "genres",
    "tags": "tags",
    "original title": "originalTitle",
    "release date": "releaseDate",
    "outline": "outline",
    "plot": "plot",
    "runtime": "runtime",
    "set": "movieSet",
    "imdb id": "externalIds",
    "imdb url": "externalIds",
    "tmdb id": "externalIds",
}

# Headers with no movie attribute at all → low confidence, ignored (FR-013).
_IGNORE_HEADERS = frozenset({"pick", "top", "tagline"})

# Sentinel a user picks to drop a medium-confidence column rather than map it (US4).
IGNORE_COLUMN = "__ignore__"

# MPAA certification tokens — used to disambiguate a generic `Rating` column by value shape.
_MPAA_TOKENS = frozenset(
    {"G", "PG", "PG-13", "R", "NC-17", "NR", "UNRATED", "X", "M", "GP", "TV-MA", "TV-14"}
)


@dataclass(frozen=True)
class ColumnMapping:
    """The resolved correspondence between a source column and a movie attribute."""

    header: str
    attribute: str | None  # None ⇒ ignored
    confidence: str  # "high" | "medium" | "low"
    multi_value: bool
    resolved_by: str = "code"  # "code" | "user" | "model"
    candidates: tuple[str, ...] = ()  # attributes offered for a medium-confidence confirm


def _normalize_header(header: str) -> str:
    """Casefold, trim, and collapse internal whitespace for alias lookup."""
    return re.sub(r"\s+", " ", (header or "").strip()).casefold()


def _looks_mpaa(value: str) -> bool:
    return value.strip().upper() in _MPAA_TOKENS


def _looks_numeric(value: str) -> bool:
    text = value.strip()
    if not text:
        return False
    # Accept "8.5", "7", and "9/10"-style fractions.
    text = text.split("/", 1)[0].strip()
    try:
        float(text)
    except ValueError:
        return False
    return True


def _is_generic_rating_header(normalized: str) -> bool:
    """A header naming a rating/score with no direct attribute (e.g. `Rating`, `My Rating`)."""
    tokens = normalized.split()
    return "rating" in tokens or "score" in tokens


def resolve_column(header: str, sample_values: list[str] | None = None) -> ColumnMapping:
    """Resolve one column header (+ optional sample values) to a ColumnMapping.

    Alias hits are high-confidence. A generic `Rating`/`Score` header is disambiguated by
    value shape: MPAA-like samples → high `rated`; numeric samples → ignored (personal
    rating, no model field); otherwise medium (ask, offering `rated`). Everything else with
    no attribute is low/ignored.
    """
    normalized = _normalize_header(header)

    if normalized in _ALIAS_TABLE:
        attribute = _ALIAS_TABLE[normalized]
        return ColumnMapping(
            header=header,
            attribute=attribute,
            confidence="high",
            multi_value=attribute in _MULTI_VALUE_ATTRIBUTES,
            resolved_by="code",
        )

    if normalized in _IGNORE_HEADERS:
        return ColumnMapping(header, None, "low", False, "code")

    if _is_generic_rating_header(normalized):
        samples = [s for s in (sample_values or []) if s and s.strip()]
        if samples and all(_looks_mpaa(s) for s in samples):
            return ColumnMapping(header, "rated", "high", False, "code")
        if samples and all(_looks_numeric(s) for s in samples):
            return ColumnMapping(header, None, "low", False, "code")
        return ColumnMapping(header, None, "medium", False, "code", candidates=("rated",))

    return ColumnMapping(header, None, "low", False, "code")


def resolve_columns(columns: list[dict[str, Any]]) -> list[ColumnMapping]:
    """Resolve every `{header, sampleValues}` column of a parsed tab."""
    return [
        resolve_column(col.get("header", ""), col.get("sampleValues"))
        for col in columns
    ]


def override_column_mapping(header: str, attribute: str) -> ColumnMapping | None:
    """A user-confirmed column choice (US4) → a high-confidence mapping, or None to ignore.

    `IGNORE_COLUMN` (or an empty attribute) drops the column; any other attribute is applied as
    if it had been a direct high-confidence match (`resolved_by="user"`), with multi-value
    inferred from the same `_MULTI_VALUE_ATTRIBUTES` set.
    """
    if not attribute or attribute == IGNORE_COLUMN:
        return None
    return ColumnMapping(
        header=header,
        attribute=attribute,
        confidence="high",
        multi_value=attribute in _MULTI_VALUE_ATTRIBUTES,
        resolved_by="user",
    )


# ---------------------------------------------------------------------------
# Title-article normalization (FR-014/015) + multi-value split (FR-016)
# ---------------------------------------------------------------------------

# Trailing "<head>, <suffix>" where <suffix> is the final comma-delimited chunk (no further
# comma). Non-greedy head so a multi-comma title splits on its LAST comma.
_TRAILING_COMMA_RE = re.compile(r"^(.*),\s*(\S[^,]*?)\s*$")

# English sorting articles (clarification Q4) → canonical leading form.
_ARTICLE_CANONICAL = {"the": "The", "a": "A", "an": "An"}


@dataclass(frozen=True)
class TitleNormalization:
    """A title resolved from the trailing-article sort convention to leading form."""

    original: str
    normalized: str
    article: str | None  # "The" | "A" | "An" | None
    needs_confirm: bool


def normalize_title_article(title: str) -> TitleNormalization:
    """Move a trailing English sorting article to the front ("Matrix, The" → "The Matrix").

    Only `The`/`A`/`An` are moved automatically. A trailing single comma-word that is NOT one
    of those three is ambiguous → `needs_confirm=True` with nothing reordered (FR-015). A
    title whose final comma is followed by multiple words is treated as a genuine title comma
    and passed through unchanged.
    """
    text = (title or "").strip()
    match = _TRAILING_COMMA_RE.match(text)
    if not match:
        return TitleNormalization(title, text, None, False)

    head = match.group(1).strip()
    suffix = match.group(2).strip()
    article = _ARTICLE_CANONICAL.get(suffix.casefold())
    if article is not None:
        return TitleNormalization(title, f"{article} {head}", article, False)
    # A single trailing comma-word that is not an article → ask before reordering.
    if " " not in suffix:
        return TitleNormalization(title, text, None, True)
    # Multiple words after the final comma → a real title comma; leave untouched.
    return TitleNormalization(title, text, None, False)


def split_multi_value(cell: str, delimiter: str = "|") -> list[str]:
    """Split a delimited cell into trimmed, non-empty values (FR-016). `None` → []."""
    if cell is None:
        return []
    return [part.strip() for part in str(cell).split(delimiter) if part.strip()]


# ---------------------------------------------------------------------------
# Dedup + compose-then-replace (FR-017/018/019)
# ---------------------------------------------------------------------------


def _as_int(value: Any) -> int | None:
    """Coerce a year-like value (int or numeric string) to int, else None."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def _is_blank(value: Any) -> bool:
    """A supplied value that must NOT overwrite an existing attribute on update.

    None, an empty/whitespace string, and an empty list/tuple are blank. `False` and `0`
    are real values — an import row may legitimately set `owned=False`.
    """
    if value is None:
        return True
    if isinstance(value, str):
        return value.strip() == ""
    if isinstance(value, (list, tuple)):
        return len(value) == 0
    return False


def match_existing_movie(
    title: str, year: Any, existing_movies: Sequence[dict[str, Any]]
) -> dict[str, Any] | None:
    """Find the stored movie an import row refers to, by (article-insensitive title, year).

    Movie uniqueness is (title, year), so when both the row and a stored movie carry a year
    they MUST agree. A unique article-insensitive title match wins; a bare title matching
    several same-titled films (or a year matching none) resolves to nothing — never guessed,
    so an ambiguous row is created rather than silently overwriting the wrong movie.
    """
    target = normalize_title(title)
    if not target:
        return None
    target_year = _as_int(year)
    matches: list[dict[str, Any]] = []
    for movie in existing_movies:
        if normalize_title(str(movie.get("title", ""))) != target:
            continue
        movie_year = _as_int(movie.get("year"))
        if target_year is not None and movie_year is not None and movie_year != target_year:
            continue
        matches.append(movie)
    return matches[0] if len(matches) == 1 else None


def compose_import_payload(
    existing_doc: dict[str, Any] | None, supplied: dict[str, Any]
) -> dict[str, Any]:
    """Build the movie payload for an import write.

    Create (no existing doc): the supplied attributes, copied. Update (existing doc): the full
    persisted document with server-assigned ids stripped, overlaid by ONLY the non-blank
    supplied attributes (FR-019 — an omitted/empty column never blanks an existing value).
    The source document is never mutated.
    """
    if existing_doc is None:
        return dict(supplied)

    payload = compose_movie_payload(existing_doc)
    for key, value in supplied.items():
        if not _is_blank(value):
            payload[key] = value
    return payload


# ---------------------------------------------------------------------------
# Row transform: parsed string cells → typed mc-service movie payload (FR-011/014/016/019)
# ---------------------------------------------------------------------------

# Cell strings that mean boolean true (case-insensitive). Anything else non-blank → False.
_TRUE_TOKENS = frozenset({"yes", "y", "true", "t", "1"})

# Content-type cell → canonical ContentType enum (domain/movie.rs: Movie/Series/Concert).
_CONTENT_TYPE_CANON = {"movie": "Movie", "series": "Series", "concert": "Concert"}

# Valid USA ratings (domain/movie.rs UsaRating serde names) — an unrecognized value is dropped
# rather than failing the row.
_VALID_RATINGS = frozenset({"G", "PG", "PG-13", "R", "NC-17", "NR", "Unrated"})

# externalIds is assembled from fixed (system, id-header, url-header) column triples — the id and
# URL live in separate spreadsheet columns but compose one {system, uniqueId, url} object.
_EXTERNAL_ID_SOURCES = (
    ("IMDB", "IMDB Id", "IMDB URL"),
    ("TMDB", "TMDB Id", "TMDB URL"),
)

# mc-service CreateMovieDto required fields with no per-row source → defaults for a CREATE only.
_CREATE_BOOL_DEFAULTS = ("owned", "ripped", "childrens")
_CREATE_LIST_DEFAULTS = (
    "directors",
    "actors",
    "genres",
    "tags",
    "ownedMedia",
    "ripQuality",
    "externalIds",
)

_BOOLEAN_ATTRS = frozenset({"owned", "ripped", "childrens"})
_INT_ATTRS = frozenset({"year", "runtime"})


def _lookup(row: dict[str, Any], header: str) -> str:
    """Case-insensitive cell lookup by header (sheet headers vary in casing)."""
    target = header.casefold()
    for key, value in row.items():
        if str(key).casefold() == target:
            return str(value or "")
    return ""


def _coerce_value(attribute: str, raw: str, multi_value: bool) -> Any:
    """Coerce a raw cell to its typed attribute value, or None when blank/uncoercible.

    None means "not supplied" — the caller omits it, so an update preserves the existing value.
    """
    text = (raw or "").strip()
    if multi_value:
        values = split_multi_value(text)
        return values if values else None
    if not text:
        return None
    if attribute in _BOOLEAN_ATTRS:
        return text.casefold() in _TRUE_TOKENS
    if attribute in _INT_ATTRS:
        return _as_int(text)
    if attribute == "contentType":
        return _CONTENT_TYPE_CANON.get(text.casefold(), text)
    if attribute == "rated":
        return text if text in _VALID_RATINGS else None
    return text


def _assemble_external_ids(row: dict[str, Any]) -> list[dict[str, str]]:
    """Build the externalIds list from the fixed id/url column pairs (skip absent ids)."""
    external_ids: list[dict[str, str]] = []
    for system, id_header, url_header in _EXTERNAL_ID_SOURCES:
        unique_id = _lookup(row, id_header).strip()
        if not unique_id:
            continue
        entry: dict[str, str] = {"system": system, "uniqueId": unique_id}
        url = _lookup(row, url_header).strip()
        if url:
            entry["url"] = url
        external_ids.append(entry)
    return external_ids


def build_row_payload(
    row: dict[str, Any],
    mappings: Sequence[ColumnMapping],
    article_overrides: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Transform one parsed string row into the typed, non-blank supplied-attribute payload.

    Only high-confidence mappings are auto-applied (a user-confirmed medium column arrives here as
    a high `resolved_by="user"` mapping, US4; an unconfirmed medium → ask, low → ignored). Blank
    cells yield no attribute (FR-019). `externalIds` is assembled from the id/URL column pairs, not
    the generic mapping. The title is article-normalized (FR-014); a user-confirmed uncertain title
    (US4/FR-015) is taken verbatim from `article_overrides` (keyed by the RAW cell) instead.
    """
    supplied: dict[str, Any] = {}
    for mapping in mappings:
        if mapping.attribute is None or mapping.confidence != "high":
            continue
        if mapping.attribute == "externalIds":
            continue  # assembled separately from the id/URL pairs
        value = _coerce_value(mapping.attribute, row.get(mapping.header, ""), mapping.multi_value)
        if value is not None:
            supplied[mapping.attribute] = value

    external_ids = _assemble_external_ids(row)
    if external_ids:
        supplied["externalIds"] = external_ids

    if "title" in supplied:
        raw_title = str(supplied["title"])
        if article_overrides and raw_title in article_overrides:
            supplied["title"] = article_overrides[raw_title]
        else:
            supplied["title"] = normalize_title_article(raw_title).normalized
    return supplied


def apply_create_defaults(supplied: dict[str, Any]) -> dict[str, Any]:
    """Fill the mc-service-required fields a CREATE needs but the row didn't supply.

    booleans → False, list fields → []. Supplied values are never overwritten. (Updates use
    compose_import_payload instead, which preserves the existing document for absent fields.)
    """
    payload = dict(supplied)
    for flag in _CREATE_BOOL_DEFAULTS:
        payload.setdefault(flag, False)
    for list_field in _CREATE_LIST_DEFAULTS:
        payload.setdefault(list_field, [])
    return payload


def dedup_import_rows(
    rows: Sequence[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Split already-mapped rows into (unique, duplicates) by (article-insensitive title, year).

    First occurrence of a (title, year) wins; later rows denoting the same film are duplicates.
    Rows are expected to be title-article-normalized already; `normalize_title` collapses any
    residual leading article so "The Matrix" and a bare "Matrix" of the same year are one film.
    """
    seen: set[tuple[str, int | None]] = set()
    unique: list[dict[str, Any]] = []
    duplicates: list[dict[str, Any]] = []
    for row in rows:
        key = (normalize_title(str(row.get("title", ""))), _as_int(row.get("year")))
        if key in seen:
            duplicates.append(row)
        else:
            seen.add(key)
            unique.append(row)
    return unique, duplicates
