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
# Whitespace / case option shapes (047 T007)
# ---------------------------------------------------------------------------

# A bare space, named so the trailing-space fixtures below are built by CONCATENATION rather
# than by a literal that ends in whitespace. A source formatter (or an editor stripping
# trailing whitespace on save) cannot silently eat the significant character this way — and
# the whole point of these fixtures is that the trailing space survives.
_SP = " "

# The exact title from the reported 047 US2 defect. The trailing space is significant: it is
# what makes the option label LONGER than the reply the member sends back, so `resolve_option`
# step 2 (`title in low`) can never match and the question re-fires forever.
TRAILING_SPACE_TITLE: str = "Three Billboards Outside Ebbing, Missouri" + _SP

# A genuine multi-word comma title — the final comma chunk is two words, so it is a real title
# comma and must raise NO sorting question at all (047 FR-012).
MULTI_WORD_COMMA_TITLE: str = "Crouching Tiger, Hidden Dragon"

# WHITESPACE_LABEL_OPTIONS: option sets whose labels differ from a trimmed/differently-cased
# reply only by surrounding whitespace or case. Every one of these resolves to None today —
# the year step does not apply, and the substring step fails because the label is longer than
# (or cased differently from) the reply. This is the shared failure mode behind 047 US2 (the
# import sorting loop) and 047 US4 (the multi-select reply), which is why the fix belongs in
# the shared `resolve_option` and not in either caller.
WHITESPACE_LABEL_OPTIONS: list[dict[str, Any]] = [
    {"id": "keep", "title": TRAILING_SPACE_TITLE},
    {"id": "reorder", "title": "Missouri Three Billboards Outside Ebbing"},
]

LEADING_SPACE_LABEL_OPTIONS: list[dict[str, Any]] = [
    {"id": "keep", "title": _SP + "Goodbye, Lenin!"},
    {"id": "reorder", "title": "Lenin! Goodbye"},
]

MIXED_CASE_LABEL_OPTIONS: list[dict[str, Any]] = [
    {"id": "dvd", "title": "Blu-Ray 3D"},
    {"id": "uhd", "title": "UHD Blu-Ray"},
]

# WHITESPACE_PICK_CASES: (reply_text, option_set, expected option id). Each pair is a reply a
# member could plausibly send that differs from the intended label ONLY by surrounding
# whitespace or case — so it MUST resolve. Drives 047 T008.
WHITESPACE_PICK_CASES: list[tuple[str, list[dict[str, Any]], str]] = [
    # The reported defect: label carries a trailing space, the reply does not.
    (TRAILING_SPACE_TITLE.strip(), WHITESPACE_LABEL_OPTIONS, "keep"),
    # The mirror image: the reply carries whitespace the label does not.
    (_SP + "Missouri Three Billboards Outside Ebbing" + _SP, WHITESPACE_LABEL_OPTIONS, "reorder"),
    # Leading space on the label.
    ("Goodbye, Lenin!", LEADING_SPACE_LABEL_OPTIONS, "keep"),
    # Case-only difference.
    ("blu-ray 3d", MIXED_CASE_LABEL_OPTIONS, "dvd"),
    ("UHD BLU-RAY", MIXED_CASE_LABEL_OPTIONS, "uhd"),
    # Whitespace AND case together.
    (_SP + "uhd blu-ray" + _SP, MIXED_CASE_LABEL_OPTIONS, "uhd"),
]

# IMPORT_WHITESPACE_ROWS: parsed spreadsheet rows carrying the two 047 US2 title shapes, in the
# `{header: cell}` form `build_row_payload` / `collect_import_disambiguations` consume. The
# trailing-space row must resolve its sorting question exactly once and store a TRIMMED title
# (FR-011); the multi-word-comma row must never be asked about at all (FR-012).
IMPORT_WHITESPACE_ROWS: list[dict[str, Any]] = [
    {"Title": TRAILING_SPACE_TITLE, "Year": "2017"},
    {"Title": MULTI_WORD_COMMA_TITLE, "Year": "2000"},
    # A trailing-space title that IS an article case — reorders automatically, no question,
    # but must still store trimmed.
    {"Title": "Matrix, The" + _SP, "Year": "1999"},
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

# ---------------------------------------------------------------------------
# enrich_movie / _unique_exact_match fixtures (013 Inc5 — curator exact-match)
# ---------------------------------------------------------------------------

# SUBSET_SUPERSET_SAME_YEAR: TMDB-shape search results where the requested exact title is ALSO a
# substring of a longer ("superset") title that shares the SAME year. Drove the curator fix
# (new bug 3): adding "Back to the Future (1985)" must resolve the exact film and never
# re-disambiguate against "Looking Back to the Future… (1985)".
SUBSET_SUPERSET_SAME_YEAR: list[dict[str, Any]] = [
    {"sourceId": "tmdb:105", "title": "Back to the Future", "year": 1985},
    {
        "sourceId": "tmdb:330",
        "title": "Looking Back to the Future: Raymond Loewy, Industrial Designer",
        "year": 1985,
    },
]

# ---------------------------------------------------------------------------
# _resolve_op_movie fixtures (013 Inc5 — organize partial-title resolution)
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Spreadsheet-import resolver fixtures (014 US2 — import_resolvers.py)
# ---------------------------------------------------------------------------

# IMPORT_EXISTING_MOVIES: stored movies (mc-service `list_movies` shape) already present in the
# target collection. Drives dedup / compose-then-replace (`match_existing_movie`,
# `compose_import_payload`): exercises article-insensitive title match ("The Matrix" stored vs a
# bare "Matrix" import), a same-title/different-year pair that must disambiguate by year, and
# rich attributes that an update MUST preserve when the import row does not supply them.
IMPORT_EXISTING_MOVIES: list[dict[str, Any]] = [
    {
        "movieId": "m-matrix",
        "collectionId": "c-target",
        "title": "The Matrix",
        "year": 1999,
        "contentType": "movie",
        "owned": False,
        "ripped": False,
        "childrens": False,
        "plot": "A hacker learns the truth about his reality.",
        "genres": ["Action", "Sci-Fi"],
        "directors": ["Lana Wachowski", "Lilly Wachowski"],
        "tags": [],
    },
    {
        "movieId": "m-dune-1984",
        "collectionId": "c-target",
        "title": "Dune",
        "year": 1984,
        "contentType": "movie",
        "owned": True,
        "ripped": False,
        "childrens": False,
        "genres": ["Sci-Fi"],
    },
    {
        "movieId": "m-dune-2021",
        "collectionId": "c-target",
        "title": "Dune",
        "year": 2021,
        "contentType": "movie",
        "owned": False,
        "ripped": False,
        "childrens": False,
        "genres": ["Sci-Fi", "Adventure"],
    },
]

# IMPORT_DUPLICATE_ROWS: already-mapped + article-normalized import rows where two entries denote
# the same film by (title, year) — including a leading-article variant ("The Matrix" vs bare
# "Matrix" 1999) that must collapse — plus a same-title/different-year pair that must NOT.
IMPORT_DUPLICATE_ROWS: list[dict[str, Any]] = [
    {"title": "The Matrix", "year": 1999, "genres": ["Action"]},
    {"title": "Matrix", "year": 1999, "genres": ["Sci-Fi"]},  # article variant → duplicate
    {"title": "Dune", "year": 1984},
    {"title": "Dune", "year": 2021},  # same title, different year → NOT a duplicate
    {"title": "Coherence", "year": 2013},
]

# PARTIAL_NAME_MOVIES: a collection exercising every _resolve_op_movie branch — a partial name
# ("harry potter") matching SEVERAL titles (disambiguate), an exact title, a SENTENCE-like title
# ("I really want this movie", which contains "this" but must resolve by title, not hijack on the
# current-screen heuristic), and a NO-YEAR film that must still resolve. Drove new bug 1.
PARTIAL_NAME_MOVIES: list[dict[str, Any]] = [
    {"movieId": "hp-phoenix", "title": "Harry Potter and the Order of the Phoenix", "year": 2007},
    {"movieId": "hp-goblet", "title": "Harry Potter and the Goblet of Fire", "year": 2005},
    {"movieId": "sentence", "title": "I really want this movie", "year": 2014},
    {"movieId": "primer", "title": "Primer"},  # no year — must still resolve
    {"movieId": "coherence", "title": "Coherence", "year": 2013},
]


# ---------------------------------------------------------------------------
# Multi-select reply fixtures (047 T071 — organizer.resolve_multi_select)
# ---------------------------------------------------------------------------

# The option set the 047 US4 ownership multi-selects offer. These are the values mc-service
# publishes at GET /api/v1/movie-metadata — held here ONLY as test data, never as a source the
# agent reads from (the whole point of RQ-4 is that the agent does not own domain values).
MEDIA_FORMAT_OPTIONS: list[str] = ["DVD", "Blu-Ray", "Blu-Ray 3D", "UHD Blu-Ray"]

# MULTI_SELECT_REPLIES: (reply, expected selection) for the confirm message a multi-select posts
# back, plus the typed equivalents FR-036 requires to behave identically. A member who types
# must reach the same result as one who taps — no step of the flow may be tap-only.
MULTI_SELECT_REPLIES: list[tuple[str, list[str]]] = [
    # The canonical confirm payloads the client posts.
    ("Selected: DVD, Blu-Ray", ["DVD", "Blu-Ray"]),
    ("Selected: none", []),
    ("Selected: UHD Blu-Ray", ["UHD Blu-Ray"]),
    ("Selected: DVD, Blu-Ray, Blu-Ray 3D, UHD Blu-Ray", MEDIA_FORMAT_OPTIONS),
    # Typed equivalents (FR-036).
    ("dvd, blu-ray", ["DVD", "Blu-Ray"]),
    ("DVD and Blu-Ray", ["DVD", "Blu-Ray"]),
    ("none", []),
    ("dvd", ["DVD"]),
    ("  UHD BLU-RAY  ", ["UHD Blu-Ray"]),
    ("blu-ray 3d and dvd", ["Blu-Ray 3D", "DVD"]),
    # Ordering follows the REPLY, not the offered list — the member said what they said.
    ("Selected: Blu-Ray, DVD", ["Blu-Ray", "DVD"]),
    # A value that is not on offer is ignored rather than invented (never guess a domain value).
    ("dvd and betamax", ["DVD"]),
    # Separator tolerance: the client joins with ", " but a member may not.
    ("DVD; Blu-Ray", ["DVD", "Blu-Ray"]),
    ("DVD + Blu-Ray", ["DVD", "Blu-Ray"]),
]

# MULTI_SELECT_EMPTY_REPLIES: replies that mean "none of them" and must resolve to an EMPTY
# selection — distinct from an UNRESOLVABLE reply, which must re-ask. Confirming zero
# selections is legal (FR-028), so these must never be mistaken for a failure to answer.
MULTI_SELECT_EMPTY_REPLIES: list[str] = [
    "Selected: none",
    "none",
    "None",
    "  none  ",
    "no formats",
    "nothing",
    "skip",
]

# MULTI_SELECT_UNRESOLVABLE_REPLIES: replies naming nothing on offer. These must resolve to
# None (re-ask) — NOT to an empty selection, which would silently record "I own it on nothing"
# when the member simply typed something unrelated.
MULTI_SELECT_UNRESOLVABLE_REPLIES: list[str] = [
    "what are my options",
    "betamax",
    "the green one",
    "",
    "   ",
]


# ---------------------------------------------------------------------------
# navigator movie-resolution fixtures (047 US1 / T016)
# ---------------------------------------------------------------------------
#
# The navigator resolves a movie named in FREEFORM text ("open Coherence in my Sci-Fi
# collection") rather than against an offered option list, so its blind spots differ from
# resolve_option's. Since 047 it also derives a SEARCH TERM from that text, which adds a
# blind spot of its own: a title made of the very words the term-extractor strips.

# NAV_PREFIX_COLLISION_MOVIES: a short title that is a prefix of a longer one. Longest-title-wins
# must pick the specific film — "Coherence" must not shadow "Coherence: Resurgence".
NAV_PREFIX_COLLISION_MOVIES: list[dict[str, Any]] = [
    {"movieId": "m1", "title": "Coherence", "year": 2013},
    {"movieId": "m2", "title": "Coherence: Resurgence", "year": 2021},
]

# NAV_SHORT_TITLE_MOVIES: titles under the 4-character guard. These must NEVER resolve from a
# substring match — "Up" would otherwise match almost any sentence containing "up".
NAV_SHORT_TITLE_MOVIES: list[dict[str, Any]] = [
    {"movieId": "m3", "title": "Up", "year": 2009},
    {"movieId": "m4", "title": "It", "year": 2017},
    {"movieId": "m5", "title": "Pi", "year": 1998},
]

# NAV_FILLER_WORD_TITLES: REAL films whose titles consist entirely of words the navigator's
# term-extractor treats as navigation phrasing ("open", "the", "collection", "in", "to", "me").
# Stripping them leaves an EMPTY search term, so a naive extractor decides the request names no
# movie and never looks — the member asking to open "The Collection" is asked which collection
# they meant instead. This is the case that must not regress.
NAV_FILLER_WORD_TITLES: list[dict[str, Any]] = [
    {"movieId": "m6", "title": "The Collection", "year": 2012},
    {"movieId": "m7", "title": "Open Water", "year": 2003},
    {"movieId": "m8", "title": "The Page Turner", "year": 2006},
]

# NAV_SAME_TITLE_DIFFERENT_YEARS: same title in two collections — ambiguous unless the text
# carries a discriminating year. Must ask, never guess (FR-014).
NAV_SAME_TITLE_DIFFERENT_YEARS: list[dict[str, Any]] = [
    {"movieId": "m9", "title": "The Thing", "year": 1982},
    {"movieId": "m10", "title": "The Thing", "year": 2011},
]
