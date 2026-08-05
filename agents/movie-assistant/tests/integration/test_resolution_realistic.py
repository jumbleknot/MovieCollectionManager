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

import asyncio
import base64
import json
import os
import time
import uuid
from typing import Any

import httpx
import pytest
from langgraph.checkpoint.memory import MemorySaver

from src.graph import build_graph
from src.nodes.curator import enrich_movie
from src.nodes.organizer import _match_movie
from src.nodes.supervisor import resolve_option
from src.runtime_nodes import build_runtime_nodes
from src.tools.agent_rate_limit import AgentToolRateLimiter
from src.tools.mcp_tools import (
    McpServerConfig,
    call_mcp_tool,
    invoke_tool,
    list_mcp_tools,
    tmdb_key_scope,
)
from src.tools.token_exchange import reexchange_for_mc_service

WEB_API_MCP_URL = os.environ.get("WEB_API_MCP_URL", "http://127.0.0.1:8765/mcp")
MOVIE_MCP_URL = os.environ.get("MOVIE_MCP_URL", "http://127.0.0.1:8766/mcp")
MC_SERVICE_URL = os.environ.get("MC_SERVICE_URL", "http://localhost:3001")

_API = "/api/v1"

WEB = McpServerConfig(name="web-api-mcp", url=WEB_API_MCP_URL, needs_token=False)
MOVIE = McpServerConfig(name="movie-mcp", url=MOVIE_MCP_URL, needs_token=True)
# The per-request key web-api-mcp REQUIRES (no shared fallback). Supplied by the CI job env.
TMDB_KEY = os.environ.get("TMDB_API_KEY", "")


# ── service probes ────────────────────────────────────────────────────────────


async def _require_web_api_mcp() -> None:
    if not TMDB_KEY:
        pytest.skip("TMDB_API_KEY not set — web-api-mcp requires a per-request X-TMDB-Key")
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

    # Bind the per-request TMDB key around each web-api-mcp call, exactly as the production
    # curator node does — it rides as `X-TMDB-Key`, the server's sole key source (no fallback).
    async def search(query: str, year: int | None) -> dict[str, Any]:
        args: dict[str, Any] = {"query": query}
        if year is not None:
            args["year"] = year
        with tmdb_key_scope(TMDB_KEY):
            out = await invoke_tool(
                agent="curator", tool_name="search_title", arguments=args, server=WEB,
                subject_token=None, call=call_mcp_tool, limiter=limiter, acquire_token=_no_token,
            )
        assert out.ok, f"search_title failed: {out.error}"
        return out.data

    async def details(source_id: str) -> dict[str, Any]:
        with tmdb_key_scope(TMDB_KEY):
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


# ── Test D — large-library navigation (047 US1 / T022) ───────────────────────
#
# US1's defect only reproduces at scale, which is the point of the T003 fixture: against a
# handful of movies EVERY version of the navigator passes. Here the target collection is big
# enough that walking it by keyset page would be ~50 tool calls against a 30-per-60 s budget the
# navigator does not skip — so "did it page the collection?" is answerable, not theoretical.
#
# The collection is seeded ONCE and reused: the titles are deterministic (matching the web
# fixture's `Large Library Title NNNNN`), so a rerun tops up rather than duplicating, and it is
# NOT deleted at the end — re-seeding 2,500 movies per run would dominate the suite.

LARGE_LIBRARY_NAME = "E2E Large Library"
LARGE_LIBRARY_SIZE = int(os.environ.get("MCM_LARGE_LIBRARY_SIZE", "2500"))
_KEYSET_PAGE = 50


def _large_title(i: int) -> str:
    return f"Large Library Title {i:05d}"


async def _ensure_large_library(token: str) -> tuple[str, int]:
    """Ensure the large-library collection exists with LARGE_LIBRARY_SIZE movies; return (id, n).

    Idempotent by construction: mc-service's (title, year) uniqueness makes a repeat create a
    409, so a partially-seeded run resumes instead of duplicating.
    """
    async with _mc(token) as client:
        resp = await client.get(f"{_API}/collections")
        resp.raise_for_status()
        body = resp.json()
        items = body.get("items", body) if isinstance(body, dict) else body
        found = next((c for c in items if c.get("name") == LARGE_LIBRARY_NAME), None)
        if found:
            collection_id = str(found["collectionId"])
        else:
            r = await client.post(f"{_API}/collections", json={"name": LARGE_LIBRARY_NAME})
            r.raise_for_status()
            collection_id = str(r.json()["collectionId"])

        # How many are already there — walk the keyset cursor.
        present: set[str] = set()
        cursor: str | None = None
        for _ in range(200):
            params: dict[str, Any] = {"limit": _KEYSET_PAGE}
            if cursor:
                params["cursor"] = cursor
            r = await client.get(f"{_API}/collections/{collection_id}/movies", params=params)
            r.raise_for_status()
            page = r.json()
            present.update(str(m["title"]) for m in page.get("items", []))
            cursor = page.get("nextCursor")
            if not cursor:
                break

        missing = [i for i in range(LARGE_LIBRARY_SIZE) if _large_title(i) not in present]
        if missing:
            sem = asyncio.Semaphore(24)

            async def create(i: int) -> None:
                async with sem:
                    r = await client.post(
                        f"{_API}/collections/{collection_id}/movies",
                        json=_movie_body(_large_title(i), 1950 + (i % 75)),
                    )
                    if r.status_code not in (200, 201, 409):
                        r.raise_for_status()

            await asyncio.gather(*(create(i) for i in missing))
        return collection_id, len(present) + len(missing)


@pytest.mark.asyncio
async def test_navigate_large_library_is_bounded_and_fast(
    subject_token: str, reexchange_env: dict[str, str]
) -> None:
    """FR-002/FR-003: naming a collection must not read its contents, however big it is."""
    await _require_movie_mcp()
    token = await _downscoped(subject_token, reexchange_env)
    collection_id, total = await _ensure_large_library(token)

    pages_if_walked = -(-total // _KEYSET_PAGE)  # ceil
    assert pages_if_walked > 30, (
        f"fixture too small to be meaningful: {total} movies is {pages_if_walked} keyset pages, "
        "which fits inside the 30-call budget — the defect could not reproduce here"
    )

    calls: list[str] = []

    async def counting_call(url: str, tool: str, args: dict[str, Any], tok: str | None) -> Any:
        calls.append(tool)
        return await call_mcp_tool(url, tool, args, tok)

    cfg = _live_nav_cfg(reexchange_env, counting_call)
    graph = build_graph(
        classifier=lambda _m: "navigate",
        checkpointer=MemorySaver(),
        **build_runtime_nodes(cfg),
    )

    started = time.monotonic()
    result = await graph.ainvoke(
        {"messages": [("user", f"navigate to my {LARGE_LIBRARY_NAME} collection")]},
        {
            "configurable": {
                "thread_id": f"nav-large-{uuid.uuid4().hex[:8]}",
                "subject_token": subject_token,
                "user_id": _sub(subject_token),
            }
        },
    )
    elapsed = time.monotonic() - started

    last = result["messages"][-1]
    names = [c["name"] for c in (getattr(last, "tool_calls", None) or [])]
    assert "navigate_to_collection" in names, f"did not open the collection: {last.content!r}"
    assert last.tool_calls[0]["args"]["collectionId"] == collection_id

    # THE ASSERTION THIS FIXTURE EXISTS FOR: zero pagination of the target collection.
    assert calls.count("list_movies") == 0, (
        f"read the collection's movies {calls.count('list_movies')}x to answer a name-only "
        f"navigation of a {total}-movie collection (would be ~{pages_if_walked} pages)"
    )
    assert elapsed < 5.0, f"took {elapsed:.2f}s for a {total}-movie collection (SC-002: < 5 s)"


def _live_nav_cfg(reexchange_env: dict[str, str], call: Any) -> Any:
    from src.runtime_nodes import RuntimeNodeConfig
    from src.tools.agent_rate_limit import AgentToolRateLimiter
    from src.tools.identity import DownscopedTokenCache

    async def authorize(_user: str, _aud: str) -> bool:
        return True

    async def exchange(subject_token: str) -> Any:
        return await reexchange_for_mc_service(subject_token, env=reexchange_env)

    return RuntimeNodeConfig(
        web_api_mcp_url="http://unused/mcp",
        movie_mcp_url=MOVIE_MCP_URL,
        limiter=AgentToolRateLimiter(max_calls=30, window_seconds=60),  # PRODUCTION default
        cache=DownscopedTokenCache(),
        authorize=authorize,
        exchange=exchange,
        call=call,
    )
