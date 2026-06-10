"""Error-rate circuit breaker (T030): trip the degrade path when runs fail too often.

Pure, process-lived, clock-injected so the rolling window + cooldown are deterministic without
real time. Wired at the supervisor entry (mirrors the kill switch): when open, the run
short-circuits to the existing graceful-degradation reply (T061) — no new user surface.
"""

from __future__ import annotations

from src.circuit_breaker import ErrorRateBreaker


class _FakeClock:
    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += seconds


def _breaker(**kw: object) -> ErrorRateBreaker:
    defaults: dict[str, object] = {
        "threshold": 0.5,
        "window": 4,
        "cooldown_s": 30.0,
        "min_samples": 4,
    }
    defaults.update(kw)
    return ErrorRateBreaker(**defaults)  # type: ignore[arg-type]


def test_closed_below_threshold() -> None:
    b = _breaker()
    for ok in (True, True, False, True):  # 1/4 = 0.25 < 0.5
        b.record(ok)
    assert b.opened() is False


def test_opens_when_error_rate_exceeds_threshold() -> None:
    b = _breaker()
    for ok in (False, False, False, True):  # 3/4 = 0.75 >= 0.5
        b.record(ok)
    assert b.opened() is True


def test_requires_minimum_samples_before_tripping() -> None:
    b = _breaker(min_samples=4)
    b.record(False)
    b.record(False)  # rate 1.0 but only 2 samples (< 4) → not enough evidence
    assert b.opened() is False


def test_half_opens_after_cooldown_and_recovers() -> None:
    clock = _FakeClock()
    b = _breaker(clock=clock)
    for ok in (False, False, False, False):
        b.record(ok)
    assert b.opened() is True  # tripped

    clock.advance(31.0)  # past the 30s cooldown
    assert b.opened() is False  # half-open → allows traffic again (window reset)

    # A subsequent clean run keeps it closed.
    b.record(True)
    assert b.opened() is False


def test_open_stays_open_within_cooldown() -> None:
    clock = _FakeClock()
    b = _breaker(clock=clock)
    for ok in (False, False, False, False):
        b.record(ok)
    assert b.opened() is True
    clock.advance(10.0)  # still within the 30s cooldown
    assert b.opened() is True


async def test_open_breaker_routes_supervisor_to_degrade() -> None:
    # An open circuit short-circuits a turn to the graceful-degradation reply (T061), never
    # classifying or acting — like the kill switch.
    from langgraph.checkpoint.memory import MemorySaver

    from src.graph import build_graph

    breaker = _breaker()
    for ok in (False, False, False, False):
        breaker.record(ok)
    assert breaker.opened() is True

    graph = build_graph(
        classifier=lambda _m: "add",  # would route to curator if the breaker weren't open
        circuit=breaker,
        checkpointer=MemorySaver(),
    )
    out = await graph.ainvoke(
        {"messages": [("user", "add The Matrix to Sci-Fi")]},
        {"configurable": {"thread_id": "cb-1"}},
    )
    text = " ".join(str(m.content) for m in out["messages"])
    assert "couldn't complete" in text.lower()  # the degrade reply, not a curator/add response


async def test_closed_breaker_does_not_intercept() -> None:
    from langgraph.checkpoint.memory import MemorySaver

    from src.graph import build_graph

    breaker = _breaker()
    graph = build_graph(
        classifier=lambda _m: "out_of_domain", circuit=breaker, checkpointer=MemorySaver()
    )
    out = await graph.ainvoke(
        {"messages": [("user", "what's the weather")]},
        {"configurable": {"thread_id": "cb-2"}},
    )
    text = " ".join(str(m.content) for m in out["messages"])
    assert "only help with your movie collections" in text.lower()  # normal decline, not degrade


def test_from_env_defaults_and_overrides() -> None:
    default = ErrorRateBreaker.from_env({})
    assert default.threshold > 0 and default.window > 0

    tuned = ErrorRateBreaker.from_env(
        {
            "AGENT_ERROR_RATE_THRESHOLD": "0.8",
            "AGENT_ERROR_RATE_WINDOW": "10",
            "AGENT_ERROR_RATE_COOLDOWN_S": "60",
            "AGENT_ERROR_RATE_MIN_SAMPLES": "5",
        }
    )
    assert tuned.threshold == 0.8
    assert tuned.window == 10
    assert tuned.cooldown_s == 60.0
    assert tuned.min_samples == 5


# ── T075c: manual degrade override via degrade_check ─────────────────────────────────────────


def test_degrade_check_true_forces_open_with_zero_failures() -> None:
    # A degrade_check=lambda: True forces the breaker open regardless of recorded outcomes.
    b = ErrorRateBreaker(
        threshold=0.5, window=10, cooldown_s=30, degrade_check=lambda: True
    )
    assert b.opened() is True  # no failures recorded — flag alone opens it


def test_degrade_check_false_default_does_not_open_fresh_breaker() -> None:
    # The default degrade_check returns False — a fresh breaker with no failures stays closed.
    b = _breaker()  # uses the helper which does NOT pass degrade_check → default lambda: False
    assert b.opened() is False


def test_degrade_check_false_does_not_change_existing_window_behavior() -> None:
    # Explicitly passing degrade_check=lambda: False is identical to the default.
    b = ErrorRateBreaker(
        threshold=0.5, window=4, cooldown_s=30, min_samples=4, degrade_check=lambda: False
    )
    for ok in (True, True, False, True):  # 1/4 = 0.25 < 0.5 → closed
        b.record(ok)
    assert b.opened() is False
