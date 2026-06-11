"""T076d — OpenSearch audit sink integration: live append + append-only/write-only proof.

Proves two things end-to-end:
1. ``emit_audit`` POSTs a real doc to OpenSearch and the stored doc has the ``token`` key
   stripped (redaction proof end-to-end — SC-004).
2. The ``agent-audit`` write-only account genuinely cannot read (GET search → 403) or delete
   (delete-by-query → 403) — immutable append-only audit posture.

Requires the ``--profile audit`` stack (OpenSearch 2 on https://localhost:9200).
Skips cleanly otherwise — never fails on a stack-less checkout.

Run:
  docker compose --profile audit up -d
  pnpm nx test:integration movie-assistant -- -k audit_opensearch
"""

from __future__ import annotations

import json
import time
import uuid
from typing import Any

import httpx
import pytest

from src.audit_sink import emit_audit

# ── constants ──────────────────────────────────────────────────────────────────

_OPENSEARCH_URL = "https://localhost:9200"
_ADMIN_CREDS = ("admin", "***REMOVED***")
_SINK_CREDS = ("agent-audit", "***REMOVED***")
_INDEX = "mcm-agent-audit"

_EMIT_ENV = {
    "OPENSEARCH_URL": _OPENSEARCH_URL,
    "OPENSEARCH_USERNAME": _SINK_CREDS[0],
    "OPENSEARCH_PASSWORD": _SINK_CREDS[1],
}

_POLL_TIMEOUT_S = 10
_POLL_SLEEP_S = 0.5


# ── skip guard (module-level) ──────────────────────────────────────────────────

def _opensearch_reachable() -> bool:
    try:
        r = httpx.get(_OPENSEARCH_URL, verify=False, timeout=5)  # noqa: S501
        return r.status_code in (200, 401)  # 401 = up but needs auth
    except Exception:  # noqa: BLE001
        return False


_requires_opensearch = pytest.mark.skipif(
    not _opensearch_reachable(),
    reason="needs OpenSearch 2 at https://localhost:9200 (docker compose --profile audit up -d)",
)


# ── helpers ────────────────────────────────────────────────────────────────────

def _url(path: str) -> str:
    return f"{_OPENSEARCH_URL.rstrip('/')}/{path.lstrip('/')}"


def _json_headers() -> dict[str, str]:
    return {"Content-Type": "application/json"}


def _admin_search(path: str, body: dict[str, Any]) -> httpx.Response:
    """POST to a _search endpoint as admin (OpenSearch accepts POST for search bodies)."""
    return httpx.post(
        _url(path),
        auth=_ADMIN_CREDS,
        verify=False,  # noqa: S501
        timeout=10,
        content=json.dumps(body),
        headers=_json_headers(),
    )


def _admin_post(path: str, body: dict[str, Any] | None = None, **params: str) -> httpx.Response:
    return httpx.post(
        _url(path),
        auth=_ADMIN_CREDS,
        verify=False,  # noqa: S501
        timeout=10,
        content=json.dumps(body) if body is not None else b"",
        headers=_json_headers(),
        params=params,
    )


def _sink_get(path: str) -> httpx.Response:
    return httpx.get(
        _url(path),
        auth=_SINK_CREDS,
        verify=False,  # noqa: S501
        timeout=10,
    )


def _sink_post(path: str, body: dict[str, Any]) -> httpx.Response:
    return httpx.post(
        _url(path),
        auth=_SINK_CREDS,
        verify=False,  # noqa: S501
        timeout=10,
        content=json.dumps(body),
        headers=_json_headers(),
    )


def _poll_for_marker(marker: str, deadline: float) -> list[dict[str, Any]]:
    """Poll until the marker doc is visible in the index (near-real-time)."""
    query: dict[str, Any] = {"query": {"term": {"marker.keyword": marker}}}
    while True:
        # Force segment refresh so newly-indexed docs are visible immediately.
        _admin_post(f"{_INDEX}/_refresh")
        resp = _admin_search(f"{_INDEX}/_search", query)
        if resp.status_code == 200:
            hits: list[dict[str, Any]] = resp.json()["hits"]["hits"]
            if hits:
                return hits
        if time.monotonic() >= deadline:
            return []
        time.sleep(_POLL_SLEEP_S)


def _teardown_marker(marker: str) -> None:
    """Best-effort delete-by-query for the marker doc(s) as admin (teardown only)."""
    try:
        _admin_post(
            f"{_INDEX}/_delete_by_query",
            {"query": {"term": {"marker.keyword": marker}}},
            refresh="true",
        )
    except Exception:  # noqa: BLE001
        pass  # teardown must never fail the test


# ── tests ──────────────────────────────────────────────────────────────────────


@_requires_opensearch
async def test_emit_audit_appends_live_doc_and_redacts_token() -> None:
    """emit_audit writes a real document to OpenSearch; the stored doc has no ``token`` key."""
    marker = uuid.uuid4().hex
    try:
        await emit_audit(
            "agent_tool_call",
            {
                "agent": "curator",
                "tool": "add_movie",
                "status": "ok",
                "marker": marker,
                "token": "SHOULD_NOT_APPEAR",
            },
            env=_EMIT_ENV,
        )

        hits = _poll_for_marker(marker, time.monotonic() + _POLL_TIMEOUT_S)
        assert hits, f"marker {marker!r} not found in {_INDEX} after {_POLL_TIMEOUT_S}s"
        assert len(hits) == 1, f"expected 1 hit, got {len(hits)}"

        src: dict[str, Any] = hits[0]["_source"]
        assert src.get("action") == "agent_tool_call", src
        assert src.get("agent") == "curator", src
        assert "token" not in src, f"token key must be redacted; got keys: {list(src)}"
    finally:
        _teardown_marker(marker)


@_requires_opensearch
async def test_agent_audit_account_is_write_only() -> None:
    """The ``agent-audit`` sink account can append but cannot search or delete."""
    # --- search must be forbidden (403) ---
    search_resp = _sink_get(f"{_INDEX}/_search")
    assert search_resp.status_code == 403, (
        f"expected 403 on search with write-only creds, got {search_resp.status_code}: "
        f"{search_resp.text[:200]}"
    )

    # --- delete-by-query must be forbidden (403) ---
    delete_resp = _sink_post(
        f"{_INDEX}/_delete_by_query",
        {"query": {"match_all": {}}},
    )
    assert delete_resp.status_code == 403, (
        f"expected 403 on delete with write-only creds, got {delete_resp.status_code}: "
        f"{delete_resp.text[:200]}"
    )
