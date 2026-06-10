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
