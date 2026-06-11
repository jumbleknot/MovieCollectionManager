"""OTel gating for movie-mcp (T030b) — env-gated, leak-safe (name-only spans)."""

from __future__ import annotations

from src.observability import configure_otel, tool_span


def test_configure_otel_is_noop_without_endpoint() -> None:
    assert configure_otel({}) is False


def test_tool_span_is_usable_without_otel_configured() -> None:
    with tool_span("list_collections") as span:
        assert span is not None


def test_tool_span_never_records_an_exception_message_into_the_span() -> None:
    """SC-004 leak guard: an upstream exception message must never be embedded into the exported
    span (record_exception event or set_status_on_exception description)."""
    import pytest
    from opentelemetry import trace
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

    sentinel = "mc-service-bearer-token-sentinel-xyz"
    provider = trace.get_tracer_provider()
    if not isinstance(provider, TracerProvider):
        provider = TracerProvider()
        trace.set_tracer_provider(provider)
    exporter = InMemorySpanExporter()
    provider.add_span_processor(SimpleSpanProcessor(exporter))

    with pytest.raises(RuntimeError):
        with tool_span("list_collections"):
            raise RuntimeError(f"upstream failed with {sentinel}")

    spans = exporter.get_finished_spans()
    assert spans, "span should have been exported"
    dumped = "".join(s.to_json() for s in spans)
    assert sentinel not in dumped, "exception message leaked into the exported span"
