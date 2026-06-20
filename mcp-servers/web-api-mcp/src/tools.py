"""web-api-mcp tools — TMDB lookups via httpx (read-only, outbound-only).

Contract: specs/012-multi-agent-mvp/contracts/web-api-mcp-tools.md.
- search_title(query, year?) -> typed matchConfidence (exact | ambiguous | none); never fabricate.
- get_movie_details(source_id) -> EnrichedMovieCandidate shaped to the mc-service add-movie payload.

The TMDB v3 key is the requesting user's own key (forwarded per request by the gateway, FR-021 —
no shared/operator key); the server passes it as the `api_key` query param and NEVER logs it or
places it in agent context. Read-only; no idempotency key. This server has NO internal-network
access — egress to TMDB only.
"""

from __future__ import annotations

from typing import Any

import httpx

DEFAULT_BASE_URL = "https://api.themoviedb.org/3"
# TMDB returns relative poster paths; this is the public CDN base + a reasonable width.
IMAGE_BASE = "https://image.tmdb.org/t/p/w500"


def make_tmdb_client(api_key: str, base_url: str | None = None) -> httpx.AsyncClient:
    """httpx client bound to TMDB with the v3 api_key as a default query param.

    The caller owns the lifetime (`async with make_tmdb_client(...) as client:`). The key is
    never logged.
    """
    return httpx.AsyncClient(
        base_url=base_url or DEFAULT_BASE_URL,
        params={"api_key": api_key},
        timeout=15.0,
    )


def _year_from_release_date(release_date: str | None) -> int | None:
    if not release_date:
        return None
    head = release_date.split("-", 1)[0]
    return int(head) if head.isdigit() else None


def _poster_url(poster_path: str | None) -> str | None:
    return f"{IMAGE_BASE}{poster_path}" if poster_path else None


def _english_language(details: dict[str, Any]) -> str | None:
    """Resolve the original language's English name (e.g. 'en' -> 'English') for mc-service.

    mc-service's `language` is a free-form string; the existing app stores names like
    'English'. Prefer the spoken-languages english_name matching original_language; fall
    back to the raw code so we never fabricate.
    """
    original = details.get("original_language")
    for lang in details.get("spoken_languages", []):
        if lang.get("iso_639_1") == original and lang.get("english_name"):
            return str(lang["english_name"])
    return str(original) if original else None


async def search_title(
    client: httpx.AsyncClient, query: str, year: int | None = None
) -> dict[str, Any]:
    """TMDB /search/movie. Returns a typed matchConfidence + minimal result refs.

    none -> 0 matches; exact -> a single match; ambiguous -> several plausible matches
    (the user disambiguates). The agent must not fabricate a pick from `ambiguous`.
    """
    params: dict[str, Any] = {"query": query}
    if year is not None:
        params["year"] = year
    resp = await client.get("/search/movie", params=params)
    resp.raise_for_status()
    raw: list[dict[str, Any]] = resp.json().get("results", [])

    results = [
        {
            "sourceId": f"tmdb:{r['id']}",
            "title": r.get("title", ""),
            "year": _year_from_release_date(r.get("release_date")),
            "posterUrl": _poster_url(r.get("poster_path")),
        }
        for r in raw
    ]

    if not results:
        confidence = "none"
    elif len(results) == 1:
        confidence = "exact"
    else:
        confidence = "ambiguous"

    return {"matchConfidence": confidence, "results": results}


async def get_movie_details(client: httpx.AsyncClient, source_id: str) -> dict[str, Any]:
    """TMDB /movie/{id} -> EnrichedMovieCandidate shaped for the mc-service add payload.

    `source_id` is a namespaced id like 'tmdb:603'; a bare numeric id is also accepted.
    """
    movie_id = source_id.split(":", 1)[1] if ":" in source_id else source_id
    resp = await client.get(f"/movie/{movie_id}")
    resp.raise_for_status()
    d: dict[str, Any] = resp.json()

    return {
        "source": "tmdb",
        "sourceId": f"tmdb:{d['id']}",
        "title": d.get("title", ""),
        "year": _year_from_release_date(d.get("release_date")),
        "overview": d.get("overview", ""),
        "genres": [g["name"] for g in d.get("genres", [])],
        "posterUrl": _poster_url(d.get("poster_path")),
        "language": _english_language(d),
    }
