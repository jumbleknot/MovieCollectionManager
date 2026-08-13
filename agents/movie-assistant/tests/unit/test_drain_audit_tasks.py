"""`drain_audit_tasks` must drain the burst it was called for, not loop until a SHARED set empties.

Feature 055 (item #179). CAPTURED 2026-08-12 from the wedged gateway at 100% CPU:

    Thread 1 (active+gil): "MainThread"
        _done_callback (asyncio/tasks.py:866)
        gather (asyncio/tasks.py:916)
        drain_audit_tasks (src/tools/mcp_tools.py:70)
        approval_gate (src/runtime_nodes.py:1165)

`_PENDING_AUDITS` is module-level and shared by every concurrent turn, so `while _PENDING_AUDITS`
is a condition one caller does not control. While other turns keep spawning audits — which sustained
multi-worker E2E load does continuously — the loop never exits. It is a BUSY loop: each pass gathers
already-finished futures and returns almost immediately, so it holds the GIL and starves the event
loop that everything else in this single-process gateway runs on. That is why /health could not be
answered while the process reported `status=running` at 100% CPU with flat memory.

The contract that matters is unchanged and is pinned below: an audit scheduled before the drain is
still awaited, so §Immutable Audit Logging of Agent Actions still holds.
"""

import asyncio

import pytest

from src.tools.mcp_tools import _PENDING_AUDITS, _spawn_audit, drain_audit_tasks


@pytest.fixture(autouse=True)
def _clear_pending():
    _PENDING_AUDITS.clear()
    yield
    _PENDING_AUDITS.clear()


@pytest.mark.asyncio
async def test_drain_terminates_while_other_turns_keep_spawning_audits() -> None:
    """The reproduction: a concurrent producer must not be able to trap the drain forever.

    Bounded by `wait_for`, because the failure mode under test is non-termination — without a
    deadline this test would hang the suite instead of failing it.
    """
    stop = asyncio.Event()

    # The audits must take SOME time, as the real ones do — the sink is off the hot path behind a
    # 3 s timeout. A first version of this test used instantly-completing coroutines and PASSED
    # against the defect: with nothing outstanding the shared set empties between passes and the
    # loop exits. The livelock needs the set to be non-empty when the `while` re-checks, which is
    # the steady state under real load, not an edge case.
    async def slow_audit() -> None:
        await asyncio.sleep(0.05)

    for _ in range(500):
        _spawn_audit(slow_audit())

    async def other_turns_spawning_audits() -> None:
        # Stands in for the other five workers' turns, each finishing writes and scheduling audits
        # into the same module-level set. One per tick is enough; measured.
        while not stop.is_set():
            _spawn_audit(slow_audit())
            await asyncio.sleep(0)

    producer = asyncio.create_task(other_turns_spawning_audits())
    try:
        await asyncio.wait_for(drain_audit_tasks(), timeout=5.0)
    except TimeoutError:  # pragma: no cover - this IS the defect
        pytest.fail(
            "drain_audit_tasks did not terminate while another turn kept spawning audits — "
            "this is the 100%-CPU livelock captured in item #179"
        )
    finally:
        stop.set()
        producer.cancel()
        await asyncio.gather(producer, return_exceptions=True)


@pytest.mark.asyncio
async def test_audits_scheduled_before_the_drain_are_awaited() -> None:
    """The guarantee the loop existed to provide, kept.

    Audit emission is deliberately off the hot path, but "off the hot path" is not "fire and
    forget": a burst whose transport never awaits could otherwise finish with every audit task
    unscheduled. Measured 2026-08-05 — a 2,000-write apply produced ZERO audit events that way.
    """
    seen: list[int] = []

    async def emit(n: int) -> None:
        await asyncio.sleep(0)
        seen.append(n)

    for i in range(25):
        _spawn_audit(emit(i))

    await drain_audit_tasks()

    assert sorted(seen) == list(range(25)), f"audits were lost: {sorted(seen)}"


@pytest.mark.asyncio
async def test_drain_is_safe_with_nothing_pending() -> None:
    await drain_audit_tasks()


@pytest.mark.asyncio
async def test_drain_does_not_spin_when_called_repeatedly() -> None:
    """A drain per write-burst is the normal pattern; none of them may busy-wait."""
    for _ in range(50):
        _spawn_audit(asyncio.sleep(0))
        await asyncio.wait_for(drain_audit_tasks(), timeout=2.0)
    assert not _PENDING_AUDITS
