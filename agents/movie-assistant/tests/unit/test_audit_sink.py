"""Unit tests for src/audit_sink.py (T076b).

Three checks:
1. build_audit_doc — pure redaction: drops token/PII keys, preserves safe keys, injects action.
2. emit_audit no-op — when OPENSEARCH_URL is unset the injected mock client is never called.
3. emit_audit active — when OPENSEARCH_URL is set the mock is called once; a raising client
   does NOT propagate (best-effort).
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock

from src.audit_sink import build_audit_doc, emit_audit  # noqa: E402

# ── 1. build_audit_doc: pure redaction ───────────────────────────────────────


def test_build_audit_doc_redacts_token_named_keys() -> None:
    """Keys whose names contain 'token' (any case) must be dropped."""
    doc = build_audit_doc(
        "agent_tool_call",
        {
            "userId": "u1",
            "threadId": "t1",
            "tool": "add_movie",
            "token": "SECRET",
            "access_token": "X",
            "Token": "Y",
        },
    )
    assert "token" not in doc
    assert "access_token" not in doc
    assert "Token" not in doc


def test_build_audit_doc_redacts_pii_keys() -> None:
    """email, password, secret, authorization, bearer, credential, jwt must be dropped."""
    doc = build_audit_doc(
        "agent_tool_call",
        {
            "userId": "u1",
            "email": "a@b.c",
            "password": "pw",
            "secret": "s",
            "authorization": "Bearer x",
        },
    )
    assert "email" not in doc
    assert "password" not in doc
    assert "secret" not in doc
    assert "authorization" not in doc


def test_build_audit_doc_preserves_safe_keys() -> None:
    """Non-sensitive keys must pass through unchanged."""
    doc = build_audit_doc(
        "agent_tool_call",
        {
            "userId": "u1",
            "threadId": "t1",
            "tool": "add_movie",
            "token": "SECRET",
            "email": "a@b.c",
            "access_token": "X",
        },
    )
    assert doc["userId"] == "u1"
    assert doc["threadId"] == "t1"
    assert doc["tool"] == "add_movie"


def test_build_audit_doc_injects_action() -> None:
    doc = build_audit_doc("agent_tool_call", {"userId": "u1", "tool": "add_movie"})
    assert doc["action"] == "agent_tool_call"


def test_build_audit_doc_is_pure_does_not_mutate_input() -> None:
    fields: dict[str, Any] = {"userId": "u1", "tool": "t", "token": "s"}
    original_keys = set(fields.keys())
    build_audit_doc("x", fields)
    assert set(fields.keys()) == original_keys


# ── 2. emit_audit no-op when OPENSEARCH_URL is unset ─────────────────────────


async def test_emit_audit_noop_when_url_unset() -> None:
    """With no OPENSEARCH_URL, the injected client must never be called."""
    mock_client = AsyncMock()
    await emit_audit(
        "agent_tool_call",
        {"agent": "curator", "tool": "get_collection", "status": "ok"},
        env={},  # no OPENSEARCH_URL
        client=mock_client,
    )
    mock_client.post.assert_not_called()


async def test_emit_audit_noop_when_url_is_empty_string() -> None:
    mock_client = AsyncMock()
    await emit_audit(
        "agent_tool_call",
        {"agent": "curator", "tool": "get_collection", "status": "ok"},
        env={"OPENSEARCH_URL": "   "},
        client=mock_client,
    )
    mock_client.post.assert_not_called()


# ── 3. emit_audit active when OPENSEARCH_URL is set ───────────────────────────


async def test_emit_audit_posts_to_opensearch_when_url_set() -> None:
    """When OPENSEARCH_URL is set, the client POSTs the redacted doc exactly once."""
    mock_response = MagicMock()
    mock_client = AsyncMock()
    mock_client.post = AsyncMock(return_value=mock_response)

    await emit_audit(
        "agent_tool_call",
        {"agent": "curator", "tool": "get_collection", "status": "ok"},
        env={"OPENSEARCH_URL": "http://opensearch:9200"},
        client=mock_client,
    )

    mock_client.post.assert_called_once()
    call_kwargs = mock_client.post.call_args
    # URL must point at the audit index
    url_arg = call_kwargs.args[0] if call_kwargs.args else call_kwargs.kwargs.get("url", "")
    assert "mcm-agent-audit" in url_arg
    assert "_doc" in url_arg
    # Payload must not contain sensitive keys
    posted_json: dict[str, Any] = call_kwargs.kwargs.get("json", {})
    for key in posted_json:
        assert "token" not in key.lower(), f"token-named key leaked into audit doc: {key!r}"
    assert posted_json.get("action") == "agent_tool_call"


async def test_emit_audit_swallows_client_exception_best_effort() -> None:
    """A raising client must NOT propagate — audit is best-effort and must never break the call."""
    mock_client = AsyncMock()
    mock_client.post = AsyncMock(side_effect=Exception("opensearch down"))

    # Must NOT raise
    await emit_audit(
        "agent_tool_call",
        {"agent": "organizer", "tool": "add_movie", "status": "error"},
        env={"OPENSEARCH_URL": "http://opensearch:9200"},
        client=mock_client,
    )


async def test_emit_audit_redacts_sensitive_fields_before_posting() -> None:
    """Even if a caller mistakenly passes a sensitive key it must be stripped before the POST."""
    posted: list[dict[str, Any]] = []

    async def _post(url: str, *, json: dict[str, Any] | None = None, **_kw: Any) -> MagicMock:
        posted.append(json or {})
        return MagicMock()

    mock_client = AsyncMock()
    mock_client.post = _post  # type: ignore[method-assign]

    await emit_audit(
        "agent_tool_call",
        {"agent": "curator", "tool": "get_collection", "status": "ok", "authorization": "Bearer x"},
        env={"OPENSEARCH_URL": "http://opensearch:9200"},
        client=mock_client,
    )

    assert posted, "expected one POST"
    doc = posted[0]
    assert "authorization" not in doc
    assert doc.get("agent") == "curator"


# ── 4. Smoke test: emit_audit is awaitable (callable signature check) ─────────


def test_emit_audit_is_a_coroutine_function() -> None:
    import asyncio

    assert asyncio.iscoroutinefunction(emit_audit)


# ── 5. build_audit_doc handles the full combined scenario from the spec ───────


def test_build_audit_doc_full_spec_scenario() -> None:
    """The exact scenario from the task spec."""
    doc = build_audit_doc(
        "agent_tool_call",
        {
            "userId": "u1",
            "threadId": "t1",
            "tool": "add_movie",
            "token": "SECRET",
            "email": "a@b.c",
            "access_token": "X",
        },
    )
    # Must not be present
    assert "token" not in doc
    assert "access_token" not in doc
    assert "email" not in doc
    # Must be present
    assert doc["action"] == "agent_tool_call"
    assert doc["userId"] == "u1"
    assert doc["tool"] == "add_movie"


# ── 047 US3 (T044a): every concurrent write emits its own audit event ────────────────────────────
#
# Constitution §Immutable Audit Logging of Agent Actions is NON-NEGOTIABLE, and per-write events
# are retained deliberately (RQ-5) — a summary event would lose per-movie provenance. The hazard
# the concurrency introduces: `invoke_tool` emits via `asyncio.ensure_future(...)`, fire-and-
# forget. Nothing awaits those tasks, so a burst of writes can finish, the caller can return, and
# the audit tasks can still be unscheduled. This pins one event per item, no duplicates, none lost.

import asyncio  # noqa: E402
import time  # noqa: E402

import pytest  # noqa: E402

from src.nodes.approval_gate import apply_proposal  # noqa: E402
from src.proposals import (  # noqa: E402
    CollectionRef,
    Operation,
    Proposal,
    ProposalItem,
    ProposalKind,
)
from src.tools import mcp_tools  # noqa: E402
from src.tools.agent_rate_limit import AgentToolRateLimiter  # noqa: E402
from src.tools.mcp_tools import McpCallResult, McpServerConfig, invoke_tool  # noqa: E402

_MOVIE = McpServerConfig(name="movie-mcp", url="http://movie-mcp/mcp", needs_token=True)


def _add_proposal(n: int) -> Proposal:
    return Proposal(
        proposal_id="import:audit",
        kind=ProposalKind.batch,
        items=[
            ProposalItem(
                item_id=f"row-{i}",
                operation=Operation.add,
                movie_payload={"title": f"Film {i}", "year": 2000},
                idempotency_key=f"key:row-{i}",
            )
            for i in range(n)
        ],
        target_collection=CollectionRef(collection_id="c-1", name="Imported"),
    )


@pytest.mark.asyncio
async def test_concurrent_apply_audit_emits_exactly_one_event_per_item(
    monkeypatch: Any,
) -> None:
    captured: list[dict[str, Any]] = []

    async def capturing_emit(action: str, fields: Any, **_kw: Any) -> None:
        # A real sink awaits I/O; yielding here is what exposes a dropped fire-and-forget task.
        await asyncio.sleep(0)
        captured.append({"action": action, **dict(fields)})

    monkeypatch.setattr(mcp_tools, "emit_audit", capturing_emit)

    async def transport(
        _url: str, _tool: str, _args: dict[str, Any], _token: str | None
    ) -> McpCallResult:
        await asyncio.sleep(0)
        return McpCallResult(False, {"movieId": "m"}, "")

    async def grant(_subject: str, _audience: str) -> str:
        return "downscoped"

    limiter = AgentToolRateLimiter(max_calls=10_000, window_seconds=60)

    async def execute(_operation: Any, args: dict[str, Any], key: str) -> Any:
        from src.nodes.approval_gate import ExecOutcome

        out = await invoke_tool(
            agent="organizer", tool_name="add_movie", arguments={**args, "key": key},
            server=_MOVIE, subject_token="subj", call=transport, limiter=limiter,
            acquire_token=grant, skip_rate_limit=True,
        )
        return ExecOutcome(status="applied" if out.ok else "failed", data=out.data)

    n = 200
    result = await apply_proposal(_add_proposal(n), execute=execute)
    assert len(result.applied_item_ids) == n

    tool_events = [e for e in captured if e.get("action") == "agent_tool_call"]
    assert len(tool_events) == n, (
        f"expected {n} audit events, captured {len(tool_events)} — "
        "per-write provenance was lost under concurrency"
    )
    assert all(e.get("status") == "ok" for e in tool_events)


@pytest.mark.asyncio
async def test_rq5_audit_sink_absorbs_a_2000_event_burst(monkeypatch: Any) -> None:
    """RQ-5 (T006): 2,000 per-write audit events must not become the import's bottleneck.

    The decision was to KEEP per-write events rather than collapse to a summary — per-movie
    provenance is what makes an import auditable, and a NON-NEGOTIABLE control should not be
    weakened to save storage. That decision is only defensible if the sink absorbs the burst, so
    this measures it rather than assuming.

    The sink is deliberately given realistic latency (1 ms per event, ~2 s if it were serialised
    into the write path) so "it did not delay the apply" is a real result and not an artefact of a
    no-op stub.
    """
    captured: list[str] = []

    async def slow_sink(action: str, fields: Any, **_kw: Any) -> None:
        await asyncio.sleep(0.001)
        captured.append(action)

    monkeypatch.setattr(mcp_tools, "emit_audit", slow_sink)

    async def transport(
        _url: str, _tool: str, _args: dict[str, Any], _token: str | None
    ) -> McpCallResult:
        return McpCallResult(False, {"movieId": "m"}, "")

    async def grant(_subject: str, _audience: str) -> str:
        return "downscoped"

    limiter = AgentToolRateLimiter(max_calls=100_000, window_seconds=60)

    async def execute(_operation: Any, args: dict[str, Any], key: str) -> Any:
        from src.nodes.approval_gate import ExecOutcome

        out = await invoke_tool(
            agent="organizer", tool_name="add_movie", arguments={**args, "key": key},
            server=_MOVIE, subject_token="subj", call=transport, limiter=limiter,
            acquire_token=grant, skip_rate_limit=True,
        )
        return ExecOutcome(status="applied" if out.ok else "failed", data=out.data)

    from src.tools.mcp_tools import drain_audit_tasks

    n = 2000
    started = time.monotonic()
    result = await apply_proposal(_add_proposal(n), execute=execute)
    apply_elapsed = time.monotonic() - started
    # What the runtime approval-gate node does once the burst ends.
    await drain_audit_tasks()
    elapsed = time.monotonic() - started

    assert len(result.applied_item_ids) == n
    # Every write is still individually audited — the whole point of the decision.
    tool_events = [a for a in captured if a == "agent_tool_call"]
    assert len(tool_events) == n, f"{len(tool_events)} audit events for {n} writes"
    # And the sink did NOT serialise into the apply: 2,000 x 1 ms would be ~2 s if it had.
    # The sink must not serialise INTO the write path: 2,000 x 1 ms would be ~2 s if it had.
    assert apply_elapsed < 1.0, (
        f"the apply itself took {apply_elapsed:.2f}s with a 1 ms sink — the audit sink has become "
        "the write path's bottleneck, which is what RQ-5 said to measure rather than assume"
    )
    print(
        f"\n@@ RQ-5: {n} writes — apply {apply_elapsed:.3f}s, "
        f"drain {elapsed - apply_elapsed:.3f}s, {len(tool_events)} audit events"
    )
