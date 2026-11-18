"""Checkpoint retention is bounded and observable (spec 102 US2, item #974).

`MemorySaver` never evicts, so the gateway's memory grew with total usage since the last restart.
`BoundedInMemorySaver` evicts a thread once it is idle for longer than the retention window, and the
least recently written threads once more than the cap are held. These tests drive a real compiled
graph through it with a fake clock, so eviction is observed through LangGraph's own read path
(`get_state`), not only through the saver's internals.
"""

from __future__ import annotations

from typing import Any, TypedDict

import pytest
from langgraph.graph import END, START, StateGraph
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader

from src.checkpoint_retention import (
    DEFAULT_MAX_THREADS,
    DEFAULT_RETENTION_SECONDS,
    BoundedInMemorySaver,
    bounded_checkpointer,
)
from src.observability import register_checkpoint_gauge


class _Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


class _S(TypedDict):
    n: int


def _graph(saver: BoundedInMemorySaver) -> Any:
    def step(state: _S) -> dict[str, int]:
        return {"n": state["n"] + 1}

    g = StateGraph(_S)
    g.add_node("step", step)
    g.add_edge(START, "step")
    g.add_edge("step", END)
    return g.compile(checkpointer=saver)


def _cfg(thread: str) -> dict[str, Any]:
    return {"configurable": {"thread_id": thread}}


def _has_checkpoint(graph: Any, thread: str) -> bool:
    return graph.get_state(_cfg(thread)).created_at is not None


def _held_anywhere(saver: BoundedInMemorySaver, thread: str) -> bool:
    return (
        bool(saver.storage.get(thread))  # .get: the base storage is a defaultdict
        or any(k[0] == thread for k in saver.writes)
        or any(k[0] == thread for k in saver.blobs)
    )


def test_a_thread_idle_past_the_window_is_evicted_on_the_next_write() -> None:
    clock = _Clock()
    saver = BoundedInMemorySaver(retention_seconds=60, max_threads=100, clock=clock)
    graph = _graph(saver)
    graph.invoke({"n": 0}, _cfg("old"))
    clock.now += 61
    graph.invoke({"n": 0}, _cfg("new"))  # a write sweeps

    assert not _held_anywhere(saver, "old")  # checkpoints, writes AND blobs are gone
    assert _has_checkpoint(graph, "new")
    assert saver.retained_thread_count() == 1


def test_an_expired_thread_is_never_served_even_with_no_write_to_sweep_it() -> None:
    clock = _Clock()
    saver = BoundedInMemorySaver(retention_seconds=60, max_threads=100, clock=clock)
    graph = _graph(saver)
    graph.invoke({"n": 0}, _cfg("t"))
    clock.now += 61

    assert not _has_checkpoint(graph, "t")  # the read itself evicts
    assert not _held_anywhere(saver, "t")
    assert list(saver.list(_cfg("t"))) == []


def test_use_slides_the_window() -> None:
    clock = _Clock()
    saver = BoundedInMemorySaver(retention_seconds=60, max_threads=100, clock=clock)
    graph = _graph(saver)
    for _ in range(5):  # 5 x 50 s = 250 s of continuous use, more than 4 windows
        graph.invoke({"n": 0}, _cfg("active"))
        clock.now += 50
    assert _has_checkpoint(graph, "active")


def test_the_cap_evicts_the_least_recently_written_thread_first() -> None:
    clock = _Clock()
    saver = BoundedInMemorySaver(retention_seconds=3600, max_threads=2, clock=clock)
    graph = _graph(saver)
    for thread in ("a", "b"):
        graph.invoke({"n": 0}, _cfg(thread))
        clock.now += 1
    graph.invoke({"n": 0}, _cfg("a"))  # a is now the most recently written
    clock.now += 1
    graph.invoke({"n": 0}, _cfg("c"))

    assert not _held_anywhere(saver, "b")
    assert _has_checkpoint(graph, "a")
    assert _has_checkpoint(graph, "c")
    assert saver.retained_thread_count() == 2


def test_the_thread_being_written_is_never_the_one_evicted() -> None:
    clock = _Clock()
    saver = BoundedInMemorySaver(retention_seconds=3600, max_threads=1, clock=clock)
    graph = _graph(saver)
    graph.invoke({"n": 0}, _cfg("a"))
    graph.invoke({"n": 0}, _cfg("b"))
    assert _has_checkpoint(graph, "b")
    assert graph.get_state(_cfg("b")).values == {"n": 1}  # its whole run survived the sweep
    assert saver.retained_thread_count() == 1


async def test_the_async_path_is_bounded_too() -> None:
    clock = _Clock()
    saver = BoundedInMemorySaver(retention_seconds=60, max_threads=100, clock=clock)
    graph = _graph(saver)
    await graph.ainvoke({"n": 0}, _cfg("t"))
    clock.now += 61
    assert (await graph.aget_state(_cfg("t"))).created_at is None


def test_bounded_checkpointer_reads_the_environment() -> None:
    saver = bounded_checkpointer(
        {"AGENT_THREAD_RETENTION_SECONDS": "120", "AGENT_CHECKPOINT_MAX_THREADS": "7"}
    )
    assert (saver.retention_seconds, saver.max_threads) == (120, 7)

    default = bounded_checkpointer({})
    # The session's absolute window. The BFF claim TTL is derived from the same default.
    assert DEFAULT_RETENTION_SECONDS == 86400
    assert (default.retention_seconds, default.max_threads) == (86400, DEFAULT_MAX_THREADS)


@pytest.mark.parametrize("bad", ["0", "-5", "abc", ""])
def test_bounded_checkpointer_rejects_a_non_positive_or_garbled_value(bad: str) -> None:
    if bad == "":
        assert bounded_checkpointer({"AGENT_THREAD_RETENTION_SECONDS": bad}).retention_seconds == (
            DEFAULT_RETENTION_SECONDS
        )
        return
    with pytest.raises(ValueError, match="AGENT_THREAD_RETENTION_SECONDS"):
        bounded_checkpointer({"AGENT_THREAD_RETENTION_SECONDS": bad})


def test_the_retained_thread_count_is_exported_as_a_gauge() -> None:
    clock = _Clock()
    saver = BoundedInMemorySaver(retention_seconds=60, max_threads=100, clock=clock)
    graph = _graph(saver)
    reader = InMemoryMetricReader()
    meter = MeterProvider(metric_readers=[reader]).get_meter("test")
    register_checkpoint_gauge(saver, meter=meter)

    for thread in ("a", "b", "c"):
        graph.invoke({"n": 0}, _cfg(thread))

    def gauge_value() -> int:
        data = reader.get_metrics_data()
        assert data is not None
        points = [
            point.value
            for rm in data.resource_metrics
            for sm in rm.scope_metrics
            for metric in sm.metrics
            if metric.name == "agent.checkpoint.threads"
            for point in metric.data.data_points
        ]
        assert len(points) == 1
        return int(points[0])

    assert gauge_value() == 3
    clock.now += 61
    graph.invoke({"n": 0}, _cfg("d"))
    assert gauge_value() == 1
