"""OpenTelemetry tracing for spreadsheet-mcp — env-gated, leak-safe (parity with movie-mcp).

`configure_otel` wires an OTLP/HTTP span exporter once at startup when
`OTEL_EXPORTER_OTLP_ENDPOINT` is set (no-op otherwise). `tool_span` wraps a tool body in a span
named for the tool. Spans carry the tool NAME only — never file bytes, never the transient
handle value, never request headers — so nothing sensitive reaches a trace. We deliberately do
NOT auto-instrument the store client.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from typing import Any

logger = logging.getLogger(__name__)

_otel_configured = False


def configure_otel(env: Mapping[str, str] | None = None) -> bool:
    """Wire an OTLP span exporter once; no-op (False) when no endpoint is set. Idempotent."""
    global _otel_configured
    e = os.environ if env is None else env
    endpoint = (e.get("OTEL_EXPORTER_OTLP_ENDPOINT") or "").strip()
    if not endpoint:
        return False
    if _otel_configured:
        return True
    from opentelemetry import trace
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    traces_url = (
        endpoint if endpoint.endswith("/v1/traces") else endpoint.rstrip("/") + "/v1/traces"
    )
    resource = Resource.create({"service.name": e.get("OTEL_SERVICE_NAME") or "spreadsheet-mcp"})
    provider = TracerProvider(resource=resource)
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=traces_url)))
    trace.set_tracer_provider(provider)
    _otel_configured = True
    logger.info("OpenTelemetry OTLP export configured (spreadsheet-mcp)")
    return True


@contextmanager
def tool_span(name: str) -> Iterator[Any]:
    """Span around a tool call — NAME ONLY (no args/headers/handle/bytes → leak-safe).

    record_exception/set_status_on_exception are BOTH disabled so an exception message can
    never embed file content or the handle into the exported span. The error still propagates
    to the caller unchanged.
    """
    from opentelemetry import trace

    tracer = trace.get_tracer("spreadsheet-mcp")
    with tracer.start_as_current_span(
        f"tool.{name}", record_exception=False, set_status_on_exception=False
    ) as span:
        yield span
