"""OTel gating for web-api-mcp (T030b) — env-gated, leak-safe."""

from __future__ import annotations

from src.observability import configure_otel, tool_span


def test_configure_otel_is_noop_without_endpoint() -> None:
    assert configure_otel({}) is False


def test_tool_span_is_usable_without_otel_configured() -> None:
    # No-op tracer until configure_otel runs — entering the span must never raise (SC-005).
    with tool_span("search_title") as span:
        assert span is not None
