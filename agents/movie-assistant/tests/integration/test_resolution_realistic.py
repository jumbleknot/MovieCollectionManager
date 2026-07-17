"""T081 — resolver realism: pure-code resolvers vs REAL TMDB + real seeded mc-service data.

Unit stubs cannot reproduce TMDB's actual "Avatar" result set (which includes a BARE "Avatar"
alongside "Avatar: The Way of Water" — the exact prefix-collision that triggered the longest-
title-first fix in resolve_option). This test exercises the resolvers against the live services
to catch bugs that only manifest with realistic data shapes.

Two tests:

  Test A — enrich pick against REAL TMDB (bug-1 catcher):
    enrich_movie("Avatar", None, ...) → expect confidence=="ambiguous" with real options that
    INCLUDE a bare "Avatar" AND an "Avatar: The Way of Water". Then resolve_option("Avatar: The
    Way of Water", options) → assert the chosen title is "Avatar: The Way of Water" (NOT the
    bare "Avatar"). This is the exact live failure, now caught against real TMDB data.

  Test B — _match_movie against REAL seeded data (bug-2 catcher):
    Seed "Dune" (1984) and "Dune" (2021) in one collection; _match_movie("Dune (2021)", movies)
    → the 2021 film; "Dune (1984)" → the 1984 film; "Dune" → None (ambiguous). Proves the
    (title, year) uniqueness resolution path against real mc-service records.

Run:
  # Start web-api-mcp first:
  cd mcp-servers/web-api-mcp && WEB_API_MCP_PORT=8765 WEB_API_MCP_HOST=127.0.0.1 \\
      TMDB_API_KEY=<key> uv run python -m src.server
  # Start movie-mcp first:
  cd mcp-servers/movie-mcp && MC_MCP_PORT=8766 MC_MCP_HOST=127.0.0.1 \\
      MC_SERVICE_URL=http://localhost:3001 uv run python -m src.server
  # Then:
  KEYCLOAK_URL=http://localhost:8099 MOVIE_MCP_URL=http://127.0.0.1:8766/mcp \\
      WEB_API_MCP_URL=http://127.0.0.1:8765/mcp \\
      pnpm nx test:integration movie-assistant -- -k resolution_realistic
"""

from __future__ import annotations

import base64
import json
import os
import uuid
from typing import Any

import httpx
import pytest

from src.nodes.curator import enrich_movie
from src.nodes.organizer import _match_movie
from src.nodes.supervisor import resolve_option
from src.tools.agent_rate_limit import AgentToolRateLimiter
from src.tools.mcp_tools import McpServerConfig, call_mcp_tool, invoke_tool, list_mcp_tools
from src.tools.token_exchange import reexchange_for_mc_service

WEB_API_MCP_URL = os.environ.get("WEB_API_MCP_URL", "http://127.0.0.1:8765/mcp")
MOVIE_MCP_URL = os.environ.get("MOVIE_MCP_URL", "http://127.0.0.1:8766/mcp")
MC_SERVICE_URL = os.environ.get("MC_SERVICE_URL", "http://localhost:3001")

_API = "/api/v1"

WEB = McpServerConfig(name="web-api-mcp", url=WEB_API_MCP_URL, needs_token=False)
MOVIE = McpServerConfig(name="movie-mcp", url=MOVIE_MCP_URL, needs_token=True)


# ── service probes ────────────────────────────────────────────────────────────


async def _require_web_api_mcp() -> None:
    try:
        await list_mcp_tools(WEB_API_MCP_URL)
    except Exception as exc:  # noqa: BLE001 — any connect/transport failure ⇒ skip
        pytest.skip(f"web-api-mcp not reachable at {WEB_API_MCP_URL}: {exc}")


async def _require_movie_mcp() -> None:
    try:
        await list_mcp_tools(MOVIE_MCP_URL)
    except Exception as exc:  # noqa: BLE001 — any connect/transport failure ⇒ skip
        pytest.skip(f"movie-mcp not reachable at {MOVIE_MCP_URL}: {exc}")


# ── web-api-mcp search/details closures (no token — outbound-only) ────────────


def _web_enrichers() -> tuple[Any, Any]:
    limiter = AgentToolRateLimiter(max_calls=100, window_seconds=60)

    async def _no_token(_subject: str, _audience: str) -> str:
        return ""  # web-api-mcp carries no user token

    async def search(query: str, year: int | None) -> dict[str, Any]:
        args: dict[str, Any] = {"query": query}
        if year is not None:
            args["year"] = year
        out = await invoke_tool(
            agent="curator", tool_name="search_title", arguments=args, server=WEB,
            subject_token=None, call=call_mcp_tool, limiter=limiter, acquire_token=_no_token,
        )
        assert out.ok, f"search_title failed: {out.error}"
        return out.data

    async def details(source_id: str) -> dict[str, Any]:
        out = await invoke_tool(
            agent="curator", tool_name="get_movie_details",
            arguments={"sourceId": source_id}, server=WEB,
            subject_token=None, call=call_mcp_tool, limiter=limiter, acquire_token=_no_token,
        )
        assert out.ok, f"get_movie_details failed: {out.error}"
        return out.data

    return search, details


# ── mc-service helpers (seed + teardown with a downscoped token) ──────────────


def _sub(jwt: str) -> str:
    payload = jwt.split(".")[1]
    payload += "=" * (-len(payload) % 4)
    return str(json.loads(base64.urlsafe_b64decode(payload))["sub"])


async def _downscoped(subject_token: str, reexchange_env: dict[str, str]) -> str:
    return (await reexchange_for_mc_service(subject_token, env=reexchange_env)).token


def _mc(token: str) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        base_url=MC_SERVICE_URL,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        timeout=15.0,
    )


def _movie_body(title: str, year: int) -> dict[str, Any]:
    """Minimal valid movie payload for mc-service (mirrors test_organize_batch._movie_body)."""
    return {
        "title": title, "year": year, "contentType": "Movie", "language": "English",
        "owned": True, "ripped": False, "childrens": False, "ownedMedia": [], "ripQuality": [],
        "genres": ["Sci-Fi"], "rated": "R", "directors": [], "actors": [], "tags": [],
        "movieSet": None, "originalTitle": None, "releaseDate": None, "outline": None,
        "plot": None, "runtime": None, "externalIds": [],
    }


async def _seed_collection(
    token: str, name: str, movies: list[dict[str, Any]]
) -> tuple[str, dict[tuple[str, int], str]]:
    """Create a collection and add movies; return (collectionId, {(title, year): movieId})."""
    async with _mc(token) as client:
        resp = await client.post(f"{_API}/collections", json={"name": name})
        resp.raise_for_status()
        collection_id = str(resp.json()["collectionId"])
        ids: dict[tuple[str, int], str] = {}
        for body in movies:
            r = await client.post(f"{_API}/collections/{collection_id}/movies", json=body)
            r.raise_for_status()
            ids[(str(body["title"]), int(body["year"]))] = str(r.json()["movieId"])
        return collection_id, ids


async def _list_movies(token: str, collection_id: str) -> list[dict[str, Any]]:
    async with _mc(token) as client:
        resp = await client.get(f"{_API}/collections/{collection_id}/movies")
        resp.raise_for_status()
        body = resp.json()
        items = body.get("items", body) if isinstance(body, dict) else body
        return list(items)


async def _delete_collection(token: str, collection_id: str) -> None:
    async with _mc(token) as client:
        await client.delete(f"{_API}/collections/{collection_id}")


# ── Test A — enrich + resolve_option against REAL TMDB ───────────────────────


# ci_quarantine — TMDB bucket: search_title failed on live TMDB (project_mcm_agent_integration_ci).
@pytest.mark.ci_quarantine
@pytest.mark.asyncio
async def test_avatar_resolve_option_prefers_full_title_over_bare_prefix() -> None:
    """Bug-1 catcher: resolve_option("Avatar: The Way of Water", options) must return the Way of
    Water film, NOT the bare "Avatar" — even though "avatar" is a substring of the longer title.

    The fix (longest-title-first sort in resolve_option) is a pure-code change that only matters
    when the real TMDB result set contains BOTH a bare "Avatar" and "Avatar: The Way of Water".
    Unit stubs cannot guarantee this collision — only real TMDB can.
    """
    await _require_web_api_mcp()
    search, details = _web_enrichers()

    result = await enrich_movie("Avatar", None, search=search, details=details)

    if result.confidence == "exact":
        # TMDB returned a single result — the collision is absent; we can't exercise the bug.
        pytest.skip("TMDB returned exact for 'Avatar' (no collision in live results); skip")

    assert result.confidence == "ambiguous", (
        f"Expected ambiguous for 'Avatar', got {result.confidence!r}"
    )
    options = result.options
    titles_lower = [str(o.get("title", "")).lower() for o in options]

    # Find the bare "Avatar" and the "Avatar: The Way of Water" in the live results.
    bare_avatar = next(
        (o for o in options if str(o.get("title", "")).lower() == "avatar"), None
    )
    way_of_water = next(
        (o for o in options if "way of water" in str(o.get("title", "")).lower()), None
    )

    if bare_avatar is None or way_of_water is None:
        # TMDB result set shifted — guard gracefully; don't fail spuriously.
        pytest.skip(
            f"TMDB results changed: bare 'Avatar'={bare_avatar is not None}, "
            f"'Way of Water'={way_of_water is not None}. "
            f"Titles returned: {[str(o.get('title')) for o in options[:8]]}"
        )

    # This is the exact live failure: "avatar" is a substring of "avatar: the way of water",
    # so without the longest-title-first sort, the bare "Avatar" would shadow the longer title.
    chosen = resolve_option("Avatar: The Way of Water", options)

    assert chosen is not None, (
        "resolve_option returned None for 'Avatar: The Way of Water' — it should match an option"
    )
    assert str(chosen.get("title", "")).lower() != "avatar", (
        f"resolve_option picked the bare 'Avatar' instead of 'The Way of Water' — "
        f"the prefix-collision bug is back. Options: {titles_lower}"
    )
    assert "way of water" in str(chosen.get("title", "")).lower(), (
        f"resolve_option returned an unexpected option: {chosen.get('title')!r}. "
        f"Options: {titles_lower}"
    )

    # Also verify a year-bearing pick resolves correctly (year takes priority over title).
    way_of_water_year = way_of_water.get("year")
    if way_of_water_year:
        year_chosen = resolve_option(f"Avatar ({way_of_water_year})", options)
        assert year_chosen is not None, (
            f"Year-bearing pick 'Avatar ({way_of_water_year})' returned None"
        )
        assert str(year_chosen.get("title", "")).lower() == str(
            way_of_water.get("title", "")
        ).lower(), (
            f"Year-bearing pick resolved to wrong film: {year_chosen.get('title')!r}"
        )


# ── Test B — _match_movie against REAL seeded data ───────────────────────────


@pytest.mark.asyncio
async def test_match_movie_disambiguates_same_title_by_year_against_real_seeded_data(
    subject_token: str, reexchange_env: dict[str, str]
) -> None:
    """Bug-2 catcher: _match_movie must pick the correct "Dune" by year when two same-titled films
    coexist in a collection, and return None when the op title is bare (ambiguous).

    mc-service uniqueness is (title, year) per collection, so both "Dune (1984)" and "Dune (2021)"
    can live in the same collection — exactly the disambiguation scenario _match_movie handles.
    Unit stubs can model this but cannot catch a regression where the stored movie's year field
    has a different type (int vs string) than _match_movie expects.
    """
    await _require_movie_mcp()

    token = await _downscoped(subject_token, reexchange_env)
    name = f"t081-dune-{uuid.uuid4().hex[:8]}"

    collection_id: str | None = None
    try:
        collection_id, seeded_ids = await _seed_collection(
            token,
            name,
            [
                _movie_body("Dune", 1984),
                _movie_body("Dune", 2021),
            ],
        )
        assert seeded_ids[("Dune", 1984)], "Seed did not produce a 1984 Dune movie id"
        assert seeded_ids[("Dune", 2021)], "Seed did not produce a 2021 Dune movie id"

        # Fetch the real list from mc-service.
        movies = await _list_movies(token, collection_id)
        assert len(movies) == 2, f"Expected 2 seeded movies, got {len(movies)}: {movies}"

        # Year-bearing op titles → unambiguous match (the core guarantee).
        match_2021 = _match_movie("Dune (2021)", movies)
        assert match_2021 is not None, "_match_movie('Dune (2021)', ...) returned None"
        assert str(match_2021.get("title")) == "Dune", (
            f"Expected title='Dune', got {match_2021.get('title')!r}"
        )
        assert int(match_2021.get("year", 0)) == 2021, (
            f"Expected year=2021, got {match_2021.get('year')!r}"
        )
        assert match_2021.get("movieId") == seeded_ids[("Dune", 2021)], (
            f"Wrong movieId for 2021 Dune: {match_2021.get('movieId')!r}"
        )

        match_1984 = _match_movie("Dune (1984)", movies)
        assert match_1984 is not None, "_match_movie('Dune (1984)', ...) returned None"
        assert str(match_1984.get("title")) == "Dune", (
            f"Expected title='Dune', got {match_1984.get('title')!r}"
        )
        assert int(match_1984.get("year", 0)) == 1984, (
            f"Expected year=1984, got {match_1984.get('year')!r}"
        )
        assert match_1984.get("movieId") == seeded_ids[("Dune", 1984)], (
            f"Wrong movieId for 1984 Dune: {match_1984.get('movieId')!r}"
        )

        # Bare title with multiple matches → None (never guess).
        match_bare = _match_movie("Dune", movies)
        assert match_bare is None, (
            f"_match_movie('Dune', ...) should return None (ambiguous) but returned {match_bare!r}"
        )

    finally:
        if collection_id:
            await _delete_collection(token, collection_id)
