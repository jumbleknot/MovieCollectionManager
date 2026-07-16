"""Unit tests for the parsed-import transient store (040 US2 T024).

`write_parsed` / `read_parsed` stash the parsed spreadsheet ({tabs, collections}) so a guided
import checkpoints only a small handle. Unlike `read_upload`, `read_parsed` is NOT single-use and
REFRESHES the TTL on every read (FR-016 — an active multi-turn import never expires mid-session).
Uses an injected in-memory fake client (the same seam the store already exposes via `client=`).

WHY unit-with-a-fake, when this project's other store coverage
(`tests/integration/test_parse_store.py`) hits a REAL Redis: **no CI workflow runs any
`test:integration` target** — `guardrails/agent-gates` and `app-ci/affected` run `test` (= tests/unit)
and `test:golden` only. Coverage placed in tests/integration therefore never executes in CI and
silently rots (exactly how a contradictory assertion survived a month in
`agents/movie-assistant/tests/integration/test_import_flow.py`). The FR-016 guarantees asserted here
are OUR logic (we call `expire` on every read; we do NOT delete the key), not Redis's behaviour, so a
fake is the honest seam for them — and it actually runs on every push. If `test:integration` is ever
wired into CI, promote these to `test_parse_store.py` against real Redis.
"""

from __future__ import annotations

import pytest

from src import store


class _FakeRedis:
    """Minimal async Redis stand-in: get/set/delete/expire over an in-memory dict, plus an
    `expires` log so a test can assert the TTL was refreshed."""

    def __init__(self) -> None:
        self.data: dict[str, bytes] = {}
        self.refreshes: list[tuple[str, int]] = []  # only explicit expire() calls (TTL refreshes)

    async def set(self, key: str, value: bytes, ex: int | None = None) -> None:
        self.data[key] = value

    async def get(self, key: str) -> bytes | None:
        return self.data.get(key)

    async def delete(self, key: str) -> None:
        self.data.pop(key, None)

    async def expire(self, key: str, ttl: int) -> None:
        self.refreshes.append((key, ttl))


async def test_write_then_read_parsed_round_trips() -> None:
    fake = _FakeRedis()
    handle = await store.write_parsed(b'{"tabs":[],"collections":[]}', client=fake)
    assert handle  # opaque, non-empty
    assert (store.PARSED_PREFIX + handle) in fake.data
    got = await store.read_parsed(handle, client=fake)
    assert got == b'{"tabs":[],"collections":[]}'


async def test_read_parsed_is_not_single_use_and_refreshes_ttl() -> None:
    fake = _FakeRedis()
    handle = await store.write_parsed(b'{"tabs":[1]}', client=fake)
    # Read it multiple times — the key survives (NOT consumed) and each read refreshes the TTL.
    for _ in range(3):
        assert await store.read_parsed(handle, client=fake) == b'{"tabs":[1]}'
    assert (store.PARSED_PREFIX + handle) in fake.data  # still present after repeated reads
    # One TTL refresh per read — the session stays alive across every clarification turn (FR-016).
    assert fake.refreshes == [(store.PARSED_PREFIX + handle, store.PARSED_TTL_SECONDS)] * 3


async def test_read_parsed_missing_handle_raises() -> None:
    fake = _FakeRedis()
    with pytest.raises(store.HandleNotFoundError):
        await store.read_parsed("does-not-exist", client=fake)
