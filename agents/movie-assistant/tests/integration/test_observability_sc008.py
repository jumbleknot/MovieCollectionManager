"""T067 — SC-008 verification LIVE: per-turn cost + p95 latency captured in LangFuse, in budget.

Runs real Claude turns with the production LangFuse v3 callback attached (the exact mechanism
the gateway uses), then queries the LangFuse API and asserts each turn's cost is captured and
within the configured budget, and the cross-turn p95 latency is within budget (SC-008). Also
proves the breach path is visible (a deliberately tight budget flags every turn).

Requires the `--profile observability` stack (LangFuse v3 at :3030) + `ANTHROPIC_API_KEY`
(the priced provider — Ollama is free, so cost would be $0). Skips cleanly otherwise.

Run:
  docker compose --profile observability up -d
  MODEL_PROVIDER=anthropic pnpm nx test:integration movie-assistant -- -k observability_sc008
"""

from __future__ import annotations

import os
import time
import uuid
from typing import Any

import pytest

from src.observability import Budgets, classify_breach, evaluate_turns

LANGFUSE_HOST = os.environ.get("LANGFUSE_HOST", "http://localhost:3030")
PUBLIC_KEY = os.environ.get("LANGFUSE_PUBLIC_KEY", "pk-lf-mcm-dev-0000000000000000")
SECRET_KEY = os.environ.get("LANGFUSE_SECRET_KEY", "sk-lf-mcm-dev-0000000000000000")

# Generous-but-real per-turn budgets (a short Claude-haiku turn is well under these).
COST_BUDGET_USD = 0.05
LATENCY_BUDGET_MS = 20_000.0

_PROMPTS = [
    "Reply with the single word: one",
    "Reply with the single word: two",
    "Reply with the single word: three",
    "Reply with the single word: four",
    "Reply with the single word: five",
]


def _langfuse_reachable() -> bool:
    import httpx

    try:
        return httpx.get(f"{LANGFUSE_HOST}/api/public/health", timeout=5).status_code == 200
    except Exception:  # noqa: BLE001
        return False


_requires_langfuse_and_claude = pytest.mark.skipif(
    not os.environ.get("ANTHROPIC_API_KEY") or not _langfuse_reachable(),
    reason="needs ANTHROPIC_API_KEY + the --profile observability LangFuse stack at :3030",
)


def _client() -> Any:
    from langfuse import Langfuse

    return Langfuse(public_key=PUBLIC_KEY, secret_key=SECRET_KEY, host=LANGFUSE_HOST)


def _register_model_price(model_id: str) -> None:
    """Ensure the Claude model is priced in LangFuse so cost computes (idempotent).

    LangFuse prices a generation by matching the model name against its model table; a model it
    doesn't know yields cost 0. We register a non-zero price so per-turn COST is real."""
    try:
        _client().api.models.create(
            model_name=f"{model_id}-mcm",
            # PREFIX match (no `$`) — Claude's response model carries a date suffix
            # (e.g. claude-haiku-4-5-20251001) that an anchored pattern would miss.
            match_pattern=f"(?i)^{model_id}",
            unit="TOKENS",
            input_price=0.000001,
            output_price=0.000005,
        )
    except Exception:  # noqa: BLE001 — already registered / not creatable → rely on built-ins
        pass


def _fetch_turns(session_id: str, expected: int) -> list[dict[str, Any]]:
    """Poll the LangFuse API until the session's traces are ingested (async worker → ClickHouse)."""
    client = _client()
    deadline = time.time() + 90
    while time.time() < deadline:
        page = client.api.trace.list(session_id=session_id)
        traces = list(getattr(page, "data", []) or [])
        if len(traces) >= expected:
            out: list[dict[str, Any]] = []
            for tr in traces:
                cost = getattr(tr, "total_cost", None)
                latency_s = getattr(tr, "latency", None)
                out.append(
                    {
                        "trace_id": getattr(tr, "id", None),
                        "cost_usd": float(cost) if cost is not None else None,
                        "latency_ms": float(latency_s) * 1000.0 if latency_s else None,
                    }
                )
            return out
        time.sleep(3)
    return []


@_requires_langfuse_and_claude
def test_sc008_per_turn_cost_and_p95_latency_in_budget_and_breach_visible() -> None:
    from src.models import build_chat_model, select_model_config
    from src.observability import build_langfuse_handler

    env = {**os.environ, "MODEL_PROVIDER": "anthropic"}
    env.pop("LLM_CASSETTE_MODE", None)
    # Drop the dev .env.local Ollama per-node overrides so the Claude tier defaults apply
    # (mirrors the golden runner) — otherwise SUPERVISOR_MODEL=qwen2.5 is sent to Anthropic.
    env.pop("SUPERVISOR_MODEL", None)
    env.pop("SPECIALIST_MODEL", None)
    spec = select_model_config("supervisor", env)  # claude-haiku tier
    _register_model_price(spec.model_id)

    handler = build_langfuse_handler({**env, "LANGFUSE_HOST": LANGFUSE_HOST,
                                      "LANGFUSE_PUBLIC_KEY": PUBLIC_KEY,
                                      "LANGFUSE_SECRET_KEY": SECRET_KEY})
    assert handler is not None  # LangFuse configured

    model = build_chat_model(spec, env)
    session_id = f"sc008-{uuid.uuid4().hex[:8]}"
    for prompt in _PROMPTS:
        model.invoke(
            prompt,
            config={
                "callbacks": [handler],
                "metadata": {"langfuse_session_id": session_id, "langfuse_tags": ["sc008-verify"]},
            },
        )

    from langfuse import get_client

    get_client().flush()

    turns = _fetch_turns(session_id, expected=len(_PROMPTS))
    assert len(turns) >= len(_PROMPTS), f"LangFuse did not ingest {len(_PROMPTS)} turns: {turns}"

    budgets = Budgets(per_turn_cost_usd=COST_BUDGET_USD, turn_latency_ms=LATENCY_BUDGET_MS)
    summary = evaluate_turns(turns, budgets)

    # Per-turn COST is captured (priced provider → > 0) and within budget (SC-008).
    assert all(t["cost_usd"] is not None and t["cost_usd"] > 0 for t in turns), turns
    assert summary["max_cost_usd"] is not None and summary["max_cost_usd"] <= COST_BUDGET_USD
    # p95 LATENCY is captured and within budget.
    assert summary["p95_latency_ms"] is not None
    assert summary["p95_latency_ms"] <= LATENCY_BUDGET_MS
    # In-budget run flags no breach.
    assert summary["breaches"] == []

    # The breach path is visible: a deliberately tight budget flags every turn.
    tight = Budgets(per_turn_cost_usd=0.0, turn_latency_ms=0.0)
    tight_summary = evaluate_turns(turns, tight)
    assert len(tight_summary["breaches"]) == len(turns)
    assert all(classify_breach(t["cost_usd"], t["latency_ms"], tight).any for t in turns)


# ── T030a: Vault runtime secret injection (live) ──────────────────────────────

VAULT_ADDR = os.environ.get("VAULT_ADDR_TEST", "http://localhost:8200")
# Generated per-machine root token (feature 021/022) from stacks/auth.env — no hardcoded secret.
VAULT_TOKEN = os.environ.get("VAULT_TOKEN_TEST") or os.environ.get("VAULT_DEV_ROOT_TOKEN_ID", "")


def _vault_reachable() -> bool:
    import httpx

    try:
        # 200 (unsealed) or 429 (standby) both mean Vault is responding.
        return httpx.get(f"{VAULT_ADDR}/v1/sys/health", timeout=5).status_code in (200, 429, 473)
    except Exception:  # noqa: BLE001
        return False


@pytest.mark.skipif(
    not _vault_reachable() or not VAULT_TOKEN,
    reason=(
        "needs --profile observability Vault :8200 and VAULT_DEV_ROOT_TOKEN_ID "
        "(source stacks/auth.env)"
    ),
)
def test_vault_runtime_secret_injection_live() -> None:
    """resolve_secret reads the credential from a live Vault (preferred over env) — T030a."""
    import hvac

    from src.secrets import resolve_secret

    sentinel = "sk-vault-sentinel-" + uuid.uuid4().hex[:8]
    client = hvac.Client(url=VAULT_ADDR, token=VAULT_TOKEN)
    client.secrets.kv.v2.create_or_update_secret(
        path="movie-assistant", secret={"ANTHROPIC_API_KEY": sentinel}, mount_point="secret"
    )

    env = {"VAULT_ADDR": VAULT_ADDR, "VAULT_TOKEN": VAULT_TOKEN, "ANTHROPIC_API_KEY": "sk-from-env"}
    assert resolve_secret("ANTHROPIC_API_KEY", env) == sentinel  # Vault wins over env


# ── T030b: OpenTelemetry export to the otel-lgtm collector (live) ──────────────


def _otlp_reachable() -> bool:
    import httpx

    try:
        # An empty POST to /v1/traces returns 4xx (not a connection error) when the collector
        # is up — that's enough to confirm the OTLP endpoint is listening.
        httpx.post("http://localhost:4318/v1/traces", content=b"", timeout=5)
        return True
    except Exception:  # noqa: BLE001
        return False


@pytest.mark.skipif(not _otlp_reachable(), reason="needs --profile observability otel-lgtm :4318")
def test_otel_span_exports_to_collector_live() -> None:
    """configure_otel wires the OTLP exporter and a span flushes to the collector — T030b."""
    from opentelemetry import trace

    from src.observability import configure_otel, otel_tracer

    assert configure_otel({"OTEL_EXPORTER_OTLP_ENDPOINT": "http://localhost:4318"}) is True
    tracer = otel_tracer()
    with tracer.start_as_current_span("sc008-otel-check") as span:
        span.set_attribute("mcm.test", "sc008")
    # force_flush returns True when the batch exported within the timeout (reached the collector).
    assert trace.get_tracer_provider().force_flush(timeout_millis=10_000) is True


def test_otel_metrics_export_to_collector_live() -> None:
    """configure_metrics wires the OTLP metric exporter and the agent counters export — T030b."""
    if not _otlp_reachable():
        pytest.skip("needs --profile observability otel-lgtm :4318")
    from opentelemetry import metrics

    from src.observability import configure_metrics, record_breach, record_turn, record_turn_failure

    assert configure_metrics({"OTEL_EXPORTER_OTLP_ENDPOINT": "http://localhost:4318"}) is True
    record_turn("add")
    record_turn_failure()
    record_breach("cost")
    # force_flush returns True when the metric batch exported to the collector within the timeout.
    assert metrics.get_meter_provider().force_flush(timeout_millis=10_000) is True
