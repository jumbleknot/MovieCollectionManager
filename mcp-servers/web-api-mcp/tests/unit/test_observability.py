"""OTel gating for web-api-mcp (T030b) — env-gated, leak-safe."""

from __future__ import annotations

import httpx
import pytest

from src.observability import configure_otel, tool_span


def test_configure_otel_is_noop_without_endpoint() -> None:
    assert configure_otel({}) is False


def test_tool_span_is_usable_without_otel_configured() -> None:
    # No-op tracer until configure_otel runs — entering the span must never raise (SC-005).
    with tool_span("search_title") as span:
        assert span is not None


def test_tool_span_never_records_an_exception_message_into_the_span() -> None:
    """SC-004 leak guard: a TMDB httpx error stringifies its request URL — which carries the
    `?api_key=<SECRET>` query param. The span must NOT record that message (record_exception
    or set_status_on_exception both embed str(exc)), or the key reaches the exported trace.
    """
    from opentelemetry import trace
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

    sentinel = "tmdb-super-secret-key-abc123"
    provider = trace.get_tracer_provider()
    if not isinstance(provider, TracerProvider):
        provider = TracerProvider()
        trace.set_tracer_provider(provider)
    exporter = InMemorySpanExporter()
    provider.add_span_processor(SimpleSpanProcessor(exporter))

    req = httpx.Request("GET", f"https://api.themoviedb.org/3/movie/603?api_key={sentinel}")
    err = httpx.HTTPStatusError(
        f"Client error '404 Not Found' for url '{req.url}'",
        request=req,
        response=httpx.Response(404, request=req),
    )

    with pytest.raises(httpx.HTTPStatusError):
        with tool_span("get_movie_details"):
            raise err

    spans = exporter.get_finished_spans()
    assert spans, "span should have been exported"
    dumped = "".join(s.to_json() for s in spans)
    assert sentinel not in dumped, "TMDB api_key leaked into the exported span"
