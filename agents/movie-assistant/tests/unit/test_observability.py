"""Observability primitives (T030/T030b/SC-008): LangFuse gating, budgets, OTel config.

The pure/gated pieces are unit-tested here; the live LangFuse cost/latency capture + the
budget verification are exercised against the real stack in tests/integration (T067). All of it
is env-gated so the default dev/test/E2E path is a no-op (SC-005 additive).
"""

from __future__ import annotations

from src.observability import (
    Budgets,
    budget_metadata,
    build_langfuse_handler,
    classify_breach,
    configure_metrics,
    configure_otel,
    evaluate_turns,
    langfuse_configured,
    load_budgets,
    percentile,
    record_breach,
    record_turn,
    record_turn_failure,
)

# ── LangFuse gating ───────────────────────────────────────────────────────────

def test_langfuse_configured_requires_both_keys() -> None:
    assert langfuse_configured({"LANGFUSE_PUBLIC_KEY": "pk", "LANGFUSE_SECRET_KEY": "sk"}) is True
    assert langfuse_configured({"LANGFUSE_PUBLIC_KEY": "pk"}) is False
    assert langfuse_configured({}) is False


def test_build_langfuse_handler_is_none_when_unconfigured() -> None:
    # The default dev/test path has no LangFuse env → no handler → no-op (SC-005).
    assert build_langfuse_handler({}) is None


# ── budgets + breach classification ───────────────────────────────────────────

def test_load_budgets_parses_env_and_defaults_to_none() -> None:
    assert load_budgets({}) == Budgets(per_turn_cost_usd=None, turn_latency_ms=None)
    loaded = load_budgets(
        {"AGENT_PER_TURN_COST_BUDGET_USD": "0.05", "AGENT_TURN_LATENCY_BUDGET_MS": "8000"}
    )
    assert loaded.per_turn_cost_usd == 0.05
    assert loaded.turn_latency_ms == 8000.0


def test_classify_breach_flags_cost_and_latency_over_budget() -> None:
    budgets = Budgets(per_turn_cost_usd=0.05, turn_latency_ms=8000)
    assert classify_breach(0.10, 1000, budgets).cost is True
    assert classify_breach(0.10, 1000, budgets).latency is False
    assert classify_breach(0.01, 9000, budgets).latency is True
    within = classify_breach(0.01, 1000, budgets)
    assert within.cost is False and within.latency is False and within.any is False


def test_classify_breach_no_budget_means_no_breach() -> None:
    none_budget = Budgets(per_turn_cost_usd=None, turn_latency_ms=None)
    assert classify_breach(999.0, 999999, none_budget).any is False


# ── p95 + per-turn evaluation (T067 helper) ───────────────────────────────────

def test_percentile_nearest_rank() -> None:
    assert percentile([], 95) is None
    assert percentile([100.0], 95) == 100.0
    # 20 values 1..20: p95 nearest-rank = ceil(0.95*20)=19th value = 19
    assert percentile([float(i) for i in range(1, 21)], 95) == 19.0


def test_evaluate_turns_computes_p95_and_flags_breaches(caplog: object) -> None:
    budgets = Budgets(per_turn_cost_usd=0.05, turn_latency_ms=5000)
    turns = [
        {"cost_usd": 0.01, "latency_ms": 1000, "trace_id": "t1"},
        {"cost_usd": 0.20, "latency_ms": 2000, "trace_id": "t2"},  # cost breach
        {"cost_usd": 0.02, "latency_ms": 9000, "trace_id": "t3"},  # latency breach
    ]
    import logging as _logging

    with caplog.at_level(_logging.WARNING):  # type: ignore[attr-defined]
        summary = evaluate_turns(turns, budgets)
    assert summary["count"] == 3
    assert summary["max_cost_usd"] == 0.20
    assert summary["p95_latency_ms"] is not None
    assert len(summary["breaches"]) == 2  # one cost, one latency
    assert "budget" in caplog.text.lower()  # type: ignore[attr-defined]  — breach WARN emitted


def test_budget_metadata_only_includes_set_budgets() -> None:
    assert budget_metadata(Budgets(per_turn_cost_usd=None, turn_latency_ms=None)) == {}
    md = budget_metadata(Budgets(per_turn_cost_usd=0.05, turn_latency_ms=8000))
    assert md == {"budget_cost_usd": 0.05, "budget_latency_ms": 8000.0}


# ── OTel gating ───────────────────────────────────────────────────────────────

def test_configure_otel_is_noop_without_endpoint() -> None:
    assert configure_otel({}) is False  # no OTEL_EXPORTER_OTLP_ENDPOINT → no-op


def test_configure_metrics_is_noop_without_endpoint() -> None:
    assert configure_metrics({}) is False  # no endpoint → no metric export


def test_metric_recorders_are_noop_safe_when_unconfigured() -> None:
    # Instruments are no-ops until configure_metrics wires a real MeterProvider — calling them
    # in the default dev/test path must never raise (SC-005 additive).
    record_turn("add")
    record_turn_failure()
    record_breach("cost")
