"""059 US1 — the film's real US certification, extracted from TMDB's release-dates block.

Every fixture below is a REAL film's published shape, measured against live TMDB on 2026-08-14
and tabulated in specs/059-assistant-add-fidelity/contracts/web-api-mcp-get-movie-details.md.
They are not invented shapes: rows 4 and 5 (All Is Lost, Fallen Leaves) are why the rule is
"first NON-EMPTY certification" rather than "first certification" — a naive `[0]` read returns
`""` for both and silently loses a real `PG-13`/`NR`.

Tier note (constitution §Test Type Integrity): stubbing the HTTP transport is permitted here,
at the UNIT tier, and only here — the same stub under tests/integration/ would be a violation.
This tier covers every branch, including shapes no real film exhibits; the live suite
(tests/integration/test_tmdb.py) is the only check that TMDB still returns this shape at all.
Neither tier replaces the other.

Verify RED:   pnpm nx test web-api-mcp -- tests/unit/test_certification.py -q
Verify GREEN: same → 0 failures.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from src.tools import extract_us_certification, get_movie_details, make_tmdb_client


def _us(*certifications: str) -> dict[str, Any]:
    """A movie-details dict whose US block publishes `certifications`, in that order."""
    return {
        "id": 1,
        "release_dates": {
            "results": [
                {
                    "iso_3166_1": "US",
                    "release_dates": [
                        {"certification": c, "type": i + 1, "note": ""}
                        for i, c in enumerate(certifications)
                    ],
                }
            ]
        },
    }


# ── The extraction rules, one case per row of the contract's behaviour table ────────────────────


def test_single_us_certification_is_taken_verbatim() -> None:
    """412117 The Secret Life of Pets 2 — `PG`, `PG`. SC-001, the reported case."""
    assert extract_us_certification(_us("PG", "PG")) == "PG"


def test_trailing_empty_certification_is_ignored() -> None:
    """603 The Matrix — `R`, `R`, `""`."""
    assert extract_us_certification(_us("R", "R", "")) == "R"


def test_nr_is_returned_when_the_source_really_says_nr() -> None:
    """396535 Train to Busan — `NR`, `NR`. The only case where `NR` is truthful (FR-005)."""
    assert extract_us_certification(_us("NR", "NR")) == "NR"


def test_leading_empty_certification_does_not_win() -> None:
    """152747 All Is Lost — `""`, `PG-13`, `PG-13`.

    The defect a naive `[0]` read produces: a real PG-13 becomes null. Second film checked.
    """
    assert extract_us_certification(_us("", "PG-13", "PG-13")) == "PG-13"


def test_seven_leading_empties_do_not_win() -> None:
    """986280 Fallen Leaves — seven `""`, then `NR`, `NR`. The same trap, seven deep."""
    assert extract_us_certification(_us("", "", "", "", "", "", "", "NR", "NR")) == "NR"


def test_all_empty_certifications_yield_none() -> None:
    """411397 Agnes — `""` only. Nothing was published, so nothing is claimed (FR-004)."""
    assert extract_us_certification(_us("")) is None


def test_no_us_block_yields_none() -> None:
    """1245424 Nightless Night — no US entry at all."""
    details = {
        "id": 1245424,
        "release_dates": {
            "results": [
                {"iso_3166_1": "FI", "release_dates": [{"certification": "K-12"}]},
                {"iso_3166_1": "DE", "release_dates": [{"certification": "12"}]},
            ]
        },
    }
    assert extract_us_certification(details) is None


def test_non_us_blocks_are_never_read() -> None:
    """A non-US certification must not leak in, even when the US block is empty (FR-002)."""
    details = {
        "id": 1,
        "release_dates": {
            "results": [
                {"iso_3166_1": "GB", "release_dates": [{"certification": "15"}]},
                {"iso_3166_1": "US", "release_dates": [{"certification": ""}]},
            ]
        },
    }
    assert extract_us_certification(details) is None


def test_value_outside_the_vocabulary_yields_none_not_an_error() -> None:
    """`TV-14` is a real TMDB value and not a movie rating the product stores (FR-006)."""
    assert extract_us_certification(_us("TV-14")) is None
    assert extract_us_certification(_us("M/PG")) is None
    assert extract_us_certification(_us("Approved")) is None


def test_an_unrecognised_value_does_not_shadow_a_later_valid_one() -> None:
    """"First non-empty" is the ordering rule; validation is a separate filter (FR-003/FR-003a)."""
    assert extract_us_certification(_us("TV-14", "PG-13")) is None


def test_the_hyphenated_forms_are_the_accepted_ones() -> None:
    """No PG13/NC17 exists at any boundary — item #163's AC3 is wrong (research R1).

    UsaRating carries #[serde(rename = "PG-13")], the app's TypeScript union is hyphenated, and
    TMDB publishes the hyphenated form. Renaming would send mc-service a value it rejects,
    swapping a wrong rating for a failed add.
    """
    assert extract_us_certification(_us("PG-13")) == "PG-13"
    assert extract_us_certification(_us("NC-17")) == "NC-17"
    assert extract_us_certification(_us("PG13")) is None
    assert extract_us_certification(_us("NC17")) is None


def test_every_vocabulary_member_round_trips() -> None:
    for value in ("G", "PG", "PG-13", "R", "NC-17", "NR", "Unrated"):
        assert extract_us_certification(_us(value)) == value


def test_missing_or_malformed_release_dates_yield_none_not_an_error() -> None:
    """The block is absent on some records; a KeyError here would fail an otherwise fine add."""
    assert extract_us_certification({"id": 1}) is None
    assert extract_us_certification({"id": 1, "release_dates": {}}) is None
    assert extract_us_certification({"id": 1, "release_dates": {"results": []}}) is None
    assert extract_us_certification({"id": 1, "release_dates": {"results": [{}]}}) is None
    assert (
        extract_us_certification({"id": 1, "release_dates": {"results": [{"iso_3166_1": "US"}]}})
        is None
    )


def test_whitespace_only_certification_counts_as_empty() -> None:
    assert extract_us_certification(_us("  ", "R")) == "R"


# ── The request itself: one call, with the certification appended (FR-002a) ─────────────────────


def _details_response(request: httpx.Request) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "id": 412117,
            "title": "The Secret Life of Pets 2",
            "release_date": "2019-05-24",
            "overview": "Max the terrier must cope with change.",
            "genres": [{"name": "Animation"}, {"name": "Family"}],
            "poster_path": "/abc.jpg",
            "original_language": "en",
            "spoken_languages": [{"iso_639_1": "en", "english_name": "English"}],
            "release_dates": {
                "results": [
                    {
                        "iso_3166_1": "US",
                        "release_dates": [
                            {"certification": "PG", "type": 3},
                            {"certification": "PG", "type": 5},
                        ],
                    }
                ]
            },
        },
        request=request,
    )


@pytest.mark.asyncio
async def test_get_movie_details_requests_append_to_response_in_exactly_one_call() -> None:
    """FR-002a: the certification rides on the request already being made.

    A second round trip would add a failure mode (details resolved, certification did not) and
    latency to every add. Asserted on the recorded requests, not on the response.
    """
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return _details_response(request)

    transport = httpx.MockTransport(handler)
    async with make_tmdb_client("k", "https://tmdb.test/3") as client:
        client._transport = transport  # noqa: SLF001 - stubbing the transport is the point
        candidate = await get_movie_details(client, "tmdb:412117")

    assert len(seen) == 1, f"expected exactly one HTTP call, got {len(seen)}"
    query = parse_qs(urlparse(str(seen[0].url)).query)
    assert query.get("append_to_response") == ["release_dates"]
    assert urlparse(str(seen[0].url)).path.endswith("/movie/412117")
    assert candidate["rated"] == "PG"


@pytest.mark.asyncio
async def test_get_movie_details_returns_rated_none_when_uncertified() -> None:
    """The key is PRESENT and null — never omitted, never a substituted "NR" (FR-004, R5)."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "id": 411397,
                "title": "Agnes",
                "release_date": "2021-12-10",
                "genres": [],
                "original_language": "en",
                "spoken_languages": [],
                "release_dates": {
                    "results": [
                        {"iso_3166_1": "US", "release_dates": [{"certification": ""}]}
                    ]
                },
            },
            request=request,
        )

    async with make_tmdb_client("k", "https://tmdb.test/3") as client:
        client._transport = httpx.MockTransport(handler)  # noqa: SLF001
        candidate = await get_movie_details(client, "tmdb:411397")

    assert "rated" in candidate
    assert candidate["rated"] is None
