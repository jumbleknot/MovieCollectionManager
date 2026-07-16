"""Transient upload/download store for spreadsheet-mcp (014 R3/R11).

The BFF writes an uploaded file's raw bytes to Redis under `import:file:<handle>` with a short
TTL and passes only the opaque `handle` into the agent run. `parse_spreadsheet` fetches those
bytes here (never an LLM-chosen arg, never logged). `build_workbook` writes the generated
`.xlsx` bytes under `export:file:<handle>` (+ its filename) for the BFF download route to stream.

This is the ONLY external resource spreadsheet-mcp touches — a transient blob store, not a
backend domain service. No mc-service / TMDB / network-domain calls (scoped-capability MCP).
"""

from __future__ import annotations

import os
import uuid
from typing import Any, cast

import redis.asyncio as redis

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379")

IMPORT_PREFIX = "import:file:"
EXPORT_PREFIX = "export:file:"
EXPORT_NAME_PREFIX = "export:name:"
PARSED_PREFIX = "import:parsed:"

# Generated download handles live this long (seconds) — enough for the user to click download.
EXPORT_TTL_SECONDS = 15 * 60

# Parsed-import handles (040 US2 T024): the parsed spreadsheet ({tabs, collections}) is stashed
# here so a guided import checkpoints only a small opaque handle — NOT the whole dataset per
# clarification turn (the checkpoint-bloat / "it timed out" cause). The TTL is SESSION-scale and is
# REFRESHED on every read (`read_parsed`), so an active multi-turn import never expires mid-session
# (FR-016). Distinct from `read_upload`, which is single-use and consumes the upload handle.
PARSED_TTL_SECONDS = 60 * 60


class HandleNotFoundError(Exception):
    """The transient handle is expired, already consumed, or never existed (FR-022)."""


_shared_client: Any = None


def _make_redis() -> Any:
    # Process-shared, lazily created client — building a fresh client (and its connection pool)
    # per tool call leaks pools/sockets over the long-lived server. Reuse one, matching movie-mcp's
    # single-backend-client pattern. decode_responses=False — bytes in, bytes out (spreadsheets are
    # binary). Typed Any: redis-py's overloaded async signatures fight a strict Protocol, and tests
    # inject a lightweight fake satisfying get/set/delete (not type-checked under `mypy src`).
    global _shared_client
    if _shared_client is None:
        _shared_client = redis.from_url(REDIS_URL, decode_responses=False)
    return _shared_client


async def read_upload(handle: str, *, client: Any = None) -> bytes:
    """Fetch an uploaded file's bytes by handle. Raises HandleNotFoundError if absent.

    Single-use: the key is deleted after a successful read so a handle cannot be replayed.
    """
    c = client or _make_redis()
    data = await c.get(IMPORT_PREFIX + handle)
    if data is None:
        raise HandleNotFoundError(f"upload handle not found or expired: {handle[:8]}…")
    await c.delete(IMPORT_PREFIX + handle)
    return cast(bytes, data)


async def write_export(
    data: bytes,
    filename: str,
    *,
    ttl: int = EXPORT_TTL_SECONDS,
    client: Any = None,
) -> str:
    """Store generated workbook bytes + filename under a fresh handle; return the handle."""
    c = client or _make_redis()
    handle = uuid.uuid4().hex
    await c.set(EXPORT_PREFIX + handle, data, ex=ttl)
    await c.set(EXPORT_NAME_PREFIX + handle, filename.encode("utf-8"), ex=ttl)
    return handle


async def write_parsed(
    data: bytes,
    *,
    ttl: int = PARSED_TTL_SECONDS,
    client: Any = None,
) -> str:
    """Stash a parsed-import context (JSON bytes) under a fresh handle; return the handle.

    NOT single-use (unlike `read_upload`): the same handle is read on every clarification turn of
    one import, and each read refreshes the TTL (`read_parsed`) so the session never expires.
    """
    c = client or _make_redis()
    handle = uuid.uuid4().hex
    await c.set(PARSED_PREFIX + handle, data, ex=ttl)
    return handle


async def read_parsed(
    handle: str,
    *,
    ttl: int = PARSED_TTL_SECONDS,
    client: Any = None,
) -> bytes:
    """Fetch stashed parsed-import bytes by handle and REFRESH its TTL, so an active multi-turn
    import never expires mid-session (FR-016). Raises HandleNotFoundError if absent/expired.

    Not single-use — the key is kept (with a bumped TTL) so later clarification turns still resolve.
    """
    c = client or _make_redis()
    data = await c.get(PARSED_PREFIX + handle)
    if data is None:
        raise HandleNotFoundError(f"parsed handle not found or expired: {handle[:8]}…")
    await c.expire(PARSED_PREFIX + handle, ttl)  # keep alive for the rest of the session
    return cast(bytes, data)
