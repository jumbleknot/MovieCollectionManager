"""OTel gating for movie-mcp (T030b) — env-gated, leak-safe (name-only spans)."""

from __future__ import annotations

from src.observability import configure_otel, tool_span


def test_configure_otel_is_noop_without_endpoint() -> None:
    assert configure_otel({}) is False


def test_tool_span_is_usable_without_otel_configured() -> None:
    with tool_span("list_collections") as span:
        assert span is not None
