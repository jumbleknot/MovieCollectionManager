"""Bounded in-memory checkpoint retention for the gateway (spec 102 US2, item #974).

`langgraph`'s `InMemorySaver` (alias `MemorySaver`) never evicts. Every checkpoint of every thread
stayed in process memory until the gateway restarted, so resident memory grew with total usage
rather than with active users. That ends in an OOM kill, which drops every in-flight run, or in an
unrecorded restart.

`BoundedInMemorySaver` keeps the saver's storage and behaviour and adds two bounds:

* an IDLE window (`AGENT_THREAD_RETENTION_SECONDS`, default 86400, the session's absolute window):
  a thread with no checkpoint write for longer than this is evicted. Idle rather than age from
  creation, so a conversation in active use never expires mid-turn;
* a thread CAP (`AGENT_CHECKPOINT_MAX_THREADS`, default 1000): past it, the least recently written
  threads go first. The cap bounds the total even when every thread stays active.

Writes sweep. Reads evict an expired thread before answering, so an expired thread is never served
even when no write has run since it expired. The thread being written is never swept by its own
write.

CROSS-SERVICE INVARIANT (spec 102 US3, item #975): the BFF's thread-owner claim lives
2 x `AGENT_THREAD_RETENTION_SECONDS`, refreshed on every use, so it outlives any checkpoint held
here. Both services read the same variable with the same default. Change one, change both.

The async methods of `InMemorySaver` (4.3.1) call these sync ones, so overriding the sync methods
bounds both paths. `tests/unit/test_checkpoint_retention.py` drives both.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import OrderedDict
from collections.abc import Callable, Iterator, Mapping, Sequence
from typing import Any

from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import (
    ChannelVersions,
    Checkpoint,
    CheckpointMetadata,
    CheckpointTuple,
)
from langgraph.checkpoint.memory import InMemorySaver

logger = logging.getLogger(__name__)

RETENTION_ENV = "AGENT_THREAD_RETENTION_SECONDS"
MAX_THREADS_ENV = "AGENT_CHECKPOINT_MAX_THREADS"
DEFAULT_RETENTION_SECONDS = 86400
DEFAULT_MAX_THREADS = 1000


def _thread_of(config: RunnableConfig | None) -> str | None:
    configurable = (config or {}).get("configurable") or {}
    thread = configurable.get("thread_id")
    return str(thread) if thread else None


class BoundedInMemorySaver(InMemorySaver):
    """`InMemorySaver` with an idle window and a thread cap. See the module docstring."""

    def __init__(
        self,
        *,
        retention_seconds: int = DEFAULT_RETENTION_SECONDS,
        max_threads: int = DEFAULT_MAX_THREADS,
        clock: Callable[[], float] = time.monotonic,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        if retention_seconds <= 0 or max_threads <= 0:
            raise ValueError("retention_seconds and max_threads must be positive")
        self.retention_seconds = retention_seconds
        self.max_threads = max_threads
        self._clock = clock
        # thread_id -> last write time, oldest first. A lock because a sync graph run may call the
        # saver from an executor thread while the event loop serves another request.
        self._last_write: OrderedDict[str, float] = OrderedDict()
        self._lock = threading.Lock()

    # ── bookkeeping ──────────────────────────────────────────────────────────

    def retained_thread_count(self) -> int:
        """Threads currently held. Read by the `agent.checkpoint.threads` gauge."""
        with self._lock:
            return len(self._last_write)

    def _expired(self, thread: str, now: float) -> bool:
        written = self._last_write.get(thread)
        return written is not None and now - written > self.retention_seconds

    def _evict_locked(self, thread: str) -> None:
        self._last_write.pop(thread, None)
        super().delete_thread(thread)

    def _touch_and_sweep(self, thread: str | None) -> None:
        with self._lock:
            now = self._clock()
            if thread is not None:
                self._last_write[thread] = now
                self._last_write.move_to_end(thread)
            idle = [
                t
                for t, written in self._last_write.items()
                if now - written > self.retention_seconds
            ]
            for t in idle:
                self._evict_locked(t)
            over_cap = 0
            while len(self._last_write) > self.max_threads:
                oldest = next(iter(self._last_write))
                if oldest == thread:  # only possible with max_threads < 1, refused in __init__
                    break
                self._evict_locked(oldest)
                over_cap += 1
            retained = len(self._last_write)
        if idle or over_cap:
            # Counts and reason only. A thread id is not a secret, but it is not needed here.
            logger.info(
                "checkpoint retention: evicted idle=%d cap=%d retained=%d",
                len(idle),
                over_cap,
                retained,
            )

    def _evict_if_expired(self, config: RunnableConfig | None) -> bool:
        """Evict what the read would otherwise serve expired. True when the named thread went."""
        thread = _thread_of(config)
        with self._lock:
            now = self._clock()
            if thread is None:  # a global listing: drop every expired thread first
                for t in [t for t in self._last_write if self._expired(t, now)]:
                    self._evict_locked(t)
                return False
            if self._expired(thread, now):
                self._evict_locked(thread)
                return True
            return False

    # ── InMemorySaver overrides ──────────────────────────────────────────────

    def get_tuple(self, config: RunnableConfig) -> CheckpointTuple | None:
        if self._evict_if_expired(config):
            # Not `super().get_tuple`: it indexes the base's defaultdict storage, which would
            # re-create an empty entry for the thread just evicted.
            return None
        return super().get_tuple(config)

    def list(
        self,
        config: RunnableConfig | None,
        *,
        filter: dict[str, Any] | None = None,  # noqa: A002 — the base class's parameter name
        before: RunnableConfig | None = None,
        limit: int | None = None,
    ) -> Iterator[CheckpointTuple]:
        if self._evict_if_expired(config):
            return iter(())
        return super().list(config, filter=filter, before=before, limit=limit)

    def put(
        self,
        config: RunnableConfig,
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata,
        new_versions: ChannelVersions,
    ) -> RunnableConfig:
        saved = super().put(config, checkpoint, metadata, new_versions)
        self._touch_and_sweep(_thread_of(config))
        return saved

    def put_writes(
        self,
        config: RunnableConfig,
        writes: Sequence[tuple[str, Any]],
        task_id: str,
        task_path: str = "",
    ) -> None:
        super().put_writes(config, writes, task_id, task_path)
        self._touch_and_sweep(_thread_of(config))

    def delete_thread(self, thread_id: str) -> None:
        with self._lock:
            self._evict_locked(thread_id)


def _positive_int(env: Mapping[str, str], name: str, default: int) -> int:
    raw = (env.get(name) or "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        value = 0
    if value <= 0:
        # Refuse to start rather than run unbounded or evict everything on a typo.
        raise ValueError(f"{name} must be a positive integer number of seconds/threads")
    return value


def bounded_checkpointer(env: Mapping[str, str]) -> BoundedInMemorySaver:
    """The gateway's checkpointer, bounded by `AGENT_THREAD_RETENTION_SECONDS` and
    `AGENT_CHECKPOINT_MAX_THREADS` (both optional; defaults in this module)."""
    return BoundedInMemorySaver(
        retention_seconds=_positive_int(env, RETENTION_ENV, DEFAULT_RETENTION_SECONDS),
        max_threads=_positive_int(env, MAX_THREADS_ENV, DEFAULT_MAX_THREADS),
    )
