"""LLM + infra observability for the agent gateway (T030/T030b, SC-008).

Two backends, both env-gated so the default dev/test/E2E path is a no-op (SC-005 additive):

- **LangFuse** (LLM traces / per-turn cost / latency): `build_langfuse_handler` returns the v3
  langchain `CallbackHandler` when `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY` are set; the
  gateway attaches it to the run config's callbacks so every turn becomes a trace with token
  cost + latency. Budgets (`AGENT_PER_TURN_COST_BUDGET_USD`, `AGENT_TURN_LATENCY_BUDGET_MS`) are
  attached as trace metadata for visibility; `classify_breach` / `evaluate_turns` flag a breach
  (WARN + the metadata tag) without blocking — SC-008 is "within budget + visible", not enforce.
- **OpenTelemetry** (infra traces/metrics/logs → Tempo/Prometheus/Loki via the otel-lgtm
  collector): `configure_otel` wires an OTLP span exporter once at startup when
  `OTEL_EXPORTER_OTLP_ENDPOINT` is set.

SC-004 carry-over: nothing here logs a token/secret, and OTel span attributes must never carry
`Authorization`/token values (the token-leak scan covers this module too).
"""

from __future__ import annotations

import logging
import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)


# ── LangFuse ──────────────────────────────────────────────────────────────────


def langfuse_configured(env: Mapping[str, str]) -> bool:
    """Whether LangFuse is configured (both API keys present)."""
    return bool(env.get("LANGFUSE_PUBLIC_KEY") and env.get("LANGFUSE_SECRET_KEY"))


def build_langfuse_handler(
    env: Mapping[str, str],
    *,
    user_id: str | None = None,
    session_id: str | None = None,
    tags: Sequence[str] | None = None,
) -> Any | None:
    """Build the LangFuse v3 langchain CallbackHandler, or None when unconfigured.

    Initialises the process-global LangFuse client from env (idempotent) so the handler ingests
    to the configured host. Per-run `user_id`/`session_id`/`tags` are passed through the run
    config metadata by the caller (the v3 handler reads `langfuse_*` metadata keys).
    """
    if not langfuse_configured(env):
        return None
    from langfuse import Langfuse  # local import — only when LangFuse is configured
    from langfuse.langchain import CallbackHandler

    Langfuse(
        public_key=env["LANGFUSE_PUBLIC_KEY"],
        secret_key=env["LANGFUSE_SECRET_KEY"],
        host=env.get("LANGFUSE_HOST") or "http://localhost:3030",
    )
    return CallbackHandler()


def langfuse_run_metadata(
    budgets: Budgets,
    *,
    user_id: str | None = None,
    session_id: str | None = None,
    tags: Sequence[str] | None = None,
) -> dict[str, Any]:
    """Run-config metadata the v3 CallbackHandler reads to tag the trace (budgets + identity)."""
    md: dict[str, Any] = dict(budget_metadata(budgets))
    if user_id:
        md["langfuse_user_id"] = user_id
    if session_id:
        md["langfuse_session_id"] = session_id
    if tags:
        md["langfuse_tags"] = list(tags)
    return md


# ── budgets + breach classification (SC-008) ──────────────────────────────────


@dataclass(frozen=True)
class Budgets:
    """Per-turn budgets; either may be None (unset → never breaches)."""

    per_turn_cost_usd: float | None
    turn_latency_ms: float | None


@dataclass(frozen=True)
class Breach:
    cost: bool
    latency: bool

    @property
    def any(self) -> bool:
        return self.cost or self.latency


def _float_or_none(value: str | None) -> float | None:
    if value is None or not str(value).strip():
        return None
    try:
        return float(value)
    except ValueError:
        return None


def load_budgets(env: Mapping[str, str]) -> Budgets:
    """Load per-turn budgets from the environment (None when unset)."""
    return Budgets(
        per_turn_cost_usd=_float_or_none(env.get("AGENT_PER_TURN_COST_BUDGET_USD")),
        turn_latency_ms=_float_or_none(env.get("AGENT_TURN_LATENCY_BUDGET_MS")),
    )


def classify_breach(
    cost_usd: float | None, latency_ms: float | None, budgets: Budgets
) -> Breach:
    """Pure budget-breach check (no budget or no measurement → not a breach)."""
    cost = (
        cost_usd is not None
        and budgets.per_turn_cost_usd is not None
        and cost_usd > budgets.per_turn_cost_usd
    )
    latency = (
        latency_ms is not None
        and budgets.turn_latency_ms is not None
        and latency_ms > budgets.turn_latency_ms
    )
    return Breach(cost=cost, latency=latency)


def budget_metadata(budgets: Budgets) -> dict[str, float]:
    """The budget values as trace metadata (only the ones that are set)."""
    md: dict[str, float] = {}
    if budgets.per_turn_cost_usd is not None:
        md["budget_cost_usd"] = budgets.per_turn_cost_usd
    if budgets.turn_latency_ms is not None:
        md["budget_latency_ms"] = budgets.turn_latency_ms
    return md


def percentile(values: Sequence[float], p: float) -> float | None:
    """Nearest-rank percentile (p in [0, 100]); None for an empty input."""
    data = sorted(float(v) for v in values)
    if not data:
        return None
    rank = max(1, math.ceil((p / 100.0) * len(data)))
    return data[min(rank, len(data)) - 1]


def evaluate_turns(
    turns: Sequence[Mapping[str, Any]], budgets: Budgets
) -> dict[str, Any]:
    """Summarise measured turns against the budgets (SC-008 / T067).

    Each turn: `{"cost_usd": float|None, "latency_ms": float|None, "trace_id": str}`. Returns a
    summary (count, max cost, p95 latency, per-turn breaches) and WARN-logs each breach — the
    "visible within budget" half of SC-008, non-blocking.
    """
    costs = [float(t["cost_usd"]) for t in turns if t.get("cost_usd") is not None]
    latencies = [float(t["latency_ms"]) for t in turns if t.get("latency_ms") is not None]
    breaches: list[dict[str, Any]] = []
    for t in turns:
        b = classify_breach(t.get("cost_usd"), t.get("latency_ms"), budgets)
        if b.any:
            entry = {"trace_id": t.get("trace_id"), "cost": b.cost, "latency": b.latency}
            breaches.append(entry)
            logger.warning(
                "per-turn budget breach",
                extra={
                    "trace_id": t.get("trace_id"),
                    "cost_breach": b.cost,
                    "latency_breach": b.latency,
                    "budget_cost_usd": budgets.per_turn_cost_usd,
                    "budget_latency_ms": budgets.turn_latency_ms,
                },
            )
    return {
        "count": len(turns),
        "max_cost_usd": max(costs) if costs else None,
        "p95_latency_ms": percentile(latencies, 95),
        "breaches": breaches,
    }


# ── OpenTelemetry (T030b) ─────────────────────────────────────────────────────

_otel_configured = False


def configure_otel(env: Mapping[str, str]) -> bool:
    """Wire an OTLP span exporter once at startup; no-op (False) when no endpoint is set.

    Reads `OTEL_EXPORTER_OTLP_ENDPOINT` (the standard OTLP env the exporter itself honours);
    idempotent so repeated gateway imports don't stack exporters.
    """
    global _otel_configured
    endpoint = (env.get("OTEL_EXPORTER_OTLP_ENDPOINT") or "").strip()
    if not endpoint:
        return False
    if _otel_configured:
        return True
    from opentelemetry import trace
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    # OTLP/HTTP wants the full signal path; accept either the base or the explicit traces URL.
    traces_url = (
        endpoint if endpoint.endswith("/v1/traces") else endpoint.rstrip("/") + "/v1/traces"
    )
    resource = Resource.create(
        {"service.name": env.get("OTEL_SERVICE_NAME") or "movie-assistant-gateway"}
    )
    provider = TracerProvider(resource=resource)
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=traces_url)))
    trace.set_tracer_provider(provider)
    _otel_configured = True
    logger.info("OpenTelemetry OTLP export configured")
    return True


def otel_tracer() -> Any:
    """The gateway tracer (a no-op tracer when OTel was never configured)."""
    from opentelemetry import trace

    return trace.get_tracer("movie-assistant-gateway")
