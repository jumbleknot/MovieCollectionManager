"""T022: integration test — parse_spreadsheet against a REAL transient store (Redis).

Exercises the actual store seam the MCP tool uses (`store.read_upload`) end-to-end with
parser.parse_workbook — no store mocking (constitution §Test Type Integrity). Mirrors the
production flow: the BFF stashes upload bytes under `import:file:<handle>`; the parse tool
fetches them once (single-use) and structurally extracts tabs. Skips if Redis is absent.
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path

import pytest
import redis.asyncio as redis

from src import parser, store

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379")
SAMPLE_XLSX = Path(__file__).resolve().parents[4] / "docs" / "test-data" / "sample-movies.xlsx"


async def _redis_or_skip() -> redis.Redis:
    client = redis.from_url(REDIS_URL, decode_responses=False)
    try:
        await client.ping()
    except Exception:  # noqa: BLE001 — any connection failure → skip, this is an env gate
        await client.aclose()
        pytest.skip("Redis not available for spreadsheet-mcp integration test")
    return client


async def test_parse_via_real_transient_store_is_single_use() -> None:
    client = await _redis_or_skip()
    handle = uuid.uuid4().hex
    try:
        await client.set(store.IMPORT_PREFIX + handle, SAMPLE_XLSX.read_bytes(), ex=60)

        data = await store.read_upload(handle)
        result = parser.parse_workbook(data, "sample-movies.xlsx")

        sample = next(t for t in result["tabs"] if t["name"] == "Sample")
        assert sample["eligible"] is True
        assert sample["rowCount"] == 200

        # Single-use: a second read of the same handle fails (key deleted after first read).
        with pytest.raises(store.HandleNotFoundError):
            await store.read_upload(handle)
    finally:
        await client.delete(store.IMPORT_PREFIX + handle)
        await client.aclose()


async def test_missing_handle_raises_not_found() -> None:
    client = await _redis_or_skip()
    try:
        with pytest.raises(store.HandleNotFoundError):
            await store.read_upload("does-not-exist-" + uuid.uuid4().hex)
    finally:
        await client.aclose()
