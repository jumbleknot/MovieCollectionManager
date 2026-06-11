"""Shared adversarial fixture catalogue for Phase 9 resolver unit tests (T078).

Each dataset targets a specific blind spot in the pure-code resolution functions
``resolve_option`` (supervisor.py) and ``_match_movie`` / ``_split_title_year`` /
``_resolve_target`` / ``references_current_screen`` (organizer.py).

Importing this module from a test file is the canonical way to access these fixtures —
do NOT duplicate inline option/movie lists across test files.
"""

from typing import Any

# ---------------------------------------------------------------------------
# resolve_option fixtures
# ---------------------------------------------------------------------------

# PREFIX_COLLISION_OPTIONS: TMDB-style search options where a short bare title is a prefix
# of longer, more-specific titles.  The Avatar case drove the "longest-title-first" fix in
# resolve_option: a short bare "Avatar" must NOT shadow "Avatar: The Way of Water" when the
# user picks the longer title.  Years are ints (native TMDB shape).
PREFIX_COLLISION_OPTIONS: list[dict[str, Any]] = [
    {"sourceId": "tmdb:19995", "title": "Avatar", "year": 2009},
    {"sourceId": "tmdb:76600", "title": "Avatar: The Way of Water", "year": 2022},
    {"sourceId": "tmdb:1160419", "title": "Avatar: Fire and Ash", "year": 2025},
    {"sourceId": "tmdb:1371196", "title": "Avatar Aang: The Last Airbender", "year": 2026},
    {"sourceId": "tmdb:63584", "title": "Capturing Avatar", "year": 2010},
]

# STRING_YEAR_OPTIONS: same logical options but with year encoded as a STRING — simulates a
# JSON round-trip where the LLM echoes option data back as string values.  Tests that year
# coercion in resolve_option (_as_int) handles both int and string years uniformly.
STRING_YEAR_OPTIONS: list[dict[str, Any]] = [
    {"sourceId": "tmdb:19995", "title": "Avatar", "year": "2009"},
    {"sourceId": "tmdb:76600", "title": "Avatar: The Way of Water", "year": "2022"},
    {"sourceId": "tmdb:1160419", "title": "Avatar: Fire and Ash", "year": "2025"},
    {"sourceId": "tmdb:1371196", "title": "Avatar Aang: The Last Airbender", "year": "2026"},
    {"sourceId": "tmdb:63584", "title": "Capturing Avatar", "year": "2010"},
]

# ---------------------------------------------------------------------------
# _match_movie fixtures
# ---------------------------------------------------------------------------

# SAME_TITLE_DIFFERENT_YEAR_MOVIES: stored movies (mc-service shape) where two films share
# the same title but differ by year.  Tests that _match_movie uses the year as a tiebreaker
# and refuses to guess when only a bare title (no year) is provided.
SAME_TITLE_DIFFERENT_YEAR_MOVIES: list[dict[str, Any]] = [
    {"movieId": "m-dune-1984", "title": "Dune", "year": 1984},
    {"movieId": "m-dune-2021", "title": "Dune", "year": 2021},
    {"movieId": "m-lion-1994", "title": "The Lion King", "year": 1994},
    {"movieId": "m-lion-2019", "title": "The Lion King", "year": 2019},
    # A unique-title film for positive-match contrast.
    {"movieId": "m-coherence", "title": "Coherence", "year": 2013},
]

# BARE_TITLE_MOVIES: stored movies whose titles contain NO year field (or year=None) and
# include colons/punctuation — tests the lenient single-side-year path and casefolding.
BARE_TITLE_MOVIES: list[dict[str, Any]] = [
    {"movieId": "m-avatar-bare", "title": "Avatar"},
    {"movieId": "m-sw4", "title": "Star Wars: A New Hope"},
    {"movieId": "m-mad-max", "title": "Mad Max: Fury Road"},
    # A title where a mid-title parenthetical is part of the name, NOT a year annotation.
    {"movieId": "m-brackets", "title": "The (Real) Deal"},
]

# ---------------------------------------------------------------------------
# _resolve_target fixtures
# ---------------------------------------------------------------------------

# COLLECTIONS: collection rows as returned by list_collections, including one isDefault.
# Names are mixed-case to exercise case-insensitive matching.
COLLECTIONS: list[dict[str, Any]] = [
    {
        "collectionId": "c-default",
        "name": "My Movies",
        "isDefault": True,
        "movieCount": 10,
    },
    {
        "collectionId": "c-scifi",
        "name": "Sci-Fi",
        "isDefault": False,
        "movieCount": 5,
    },
    {
        "collectionId": "c-horror",
        "name": "Horror Classics",
        "isDefault": False,
        "movieCount": 3,
    },
]

# COLLECTIONS_NO_DEFAULT: same shape but no isDefault — exercises the needs_clarify branch.
COLLECTIONS_NO_DEFAULT: list[dict[str, Any]] = [
    {
        "collectionId": "c-scifi",
        "name": "Sci-Fi",
        "isDefault": False,
        "movieCount": 5,
    },
    {
        "collectionId": "c-horror",
        "name": "Horror Classics",
        "isDefault": False,
        "movieCount": 3,
    },
]

# ---------------------------------------------------------------------------
# Messy-pick / model-echoed strings
# ---------------------------------------------------------------------------

# MESSY_PICK_TEXTS: realistic strings an LLM or user might produce as a disambiguation pick,
# targeting fragile title/year parsing in resolve_option.
MESSY_PICK_TEXTS: list[str] = [
    "Avatar: Fire and Ash (2025)",      # long specific title with trailing year
    "Avatar: The Way of Water",          # long title, no year
    "avatar",                            # bare lowercase
    "the first one",                     # ordinal
    "the last one",                      # ordinal (last)
    "the second one",                    # ordinal (second)
    "the 2021 one",                      # year phrase
    "AVATAR: THE WAY OF WATER",          # uppercase title
    "  Avatar: Fire and Ash  ",          # extra whitespace
    "number 2",                          # 1-based index
    "#3",                                # 1-based index (hash)
    "the green one",                     # unresolvable colour reference
    "the big one",                       # unresolvable adjective
]

# MESSY_OP_TITLES: realistic strings the LLM might emit as operation titles in a plan
# (organizer._match_movie target); mixes echoed-year suffixes, casing, and whitespace.
MESSY_OP_TITLES: list[str] = [
    "Dune (2021)",                  # echoed year → disambiguates same-title pair
    "Dune (1984)",                  # echoed year → other Dune
    "Dune",                         # bare → ambiguous across two Dunes
    "Avatar (2022)",                # year disagrees with the only stored Avatar (2009)
    "Avatar (2009)",                # year agrees
    "coherence",                    # exact title, lowercase
    "  Coherence  ",                # extra whitespace
    "COHERENCE",                    # all-caps
    "Star Wars: A New Hope",        # colon-containing title (bare, no year stored)
    "The (Real) Deal",              # mid-title parens that are NOT a year
]
