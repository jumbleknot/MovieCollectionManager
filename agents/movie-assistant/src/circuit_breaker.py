"""Error-rate circuit breaker for the agent gateway (T030, Control Tower).

A process-lived rolling-window error-rate tracker. The supervisor records each run's outcome
(provider/classifier success or failure) and checks `opened()` at the entry — mirroring the
kill switch. When the failure rate over the recent window crosses a threshold the breaker
opens, and the run short-circuits to the existing graceful-degradation reply (T061, the
"couldn't complete" path) — no new user-facing surface, zero side effects. After a cooldown it
half-opens (resets the window) and lets traffic flow again, re-tripping if failures persist.

Clock-injected so the window + cooldown are deterministic under test. Per-process only (the
gateway is a single uvicorn process); a multi-replica deployment would back this with the
Unleash circuit breaker (the deferred T030 piece) — the predicate signature here is the seam.
"""

from __future__ import annotations

import time
from collections import deque
from collections.abc import Callable, Mapping


class ErrorRateBreaker:
    """Rolling-window error-rate breaker. `opened()` is the short-circuit predicate."""

    def __init__(
        self,
        *,
        threshold: float,
        window: int,
        cooldown_s: float,
        min_samples: int = 1,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if window < 1:
            raise ValueError("window must be >= 1")
        self.threshold = float(threshold)
        self.window = int(window)
        self.cooldown_s = float(cooldown_s)
        self.min_samples = max(1, int(min_samples))
        self._clock = clock
        self._outcomes: deque[bool] = deque(maxlen=self.window)
        self._opened_at: float | None = None

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> ErrorRateBreaker:
        """Build from the gateway environment (sensible defaults when unset)."""
        return cls(
            threshold=float(env.get("AGENT_ERROR_RATE_THRESHOLD") or 0.5),
            window=int(env.get("AGENT_ERROR_RATE_WINDOW") or 20),
            cooldown_s=float(env.get("AGENT_ERROR_RATE_COOLDOWN_S") or 30),
            min_samples=int(env.get("AGENT_ERROR_RATE_MIN_SAMPLES") or 5),
        )

    @property
    def state(self) -> str:
        return "open" if self._opened_at is not None else "closed"

    def record(self, ok: bool) -> None:
        """Record one run outcome; trip the breaker if the window's error rate crosses the
        threshold (only once enough samples have accumulated)."""
        self._outcomes.append(bool(ok))
        if self._opened_at is not None:
            return  # already open — wait for the cooldown (checked in opened())
        if len(self._outcomes) < self.min_samples:
            return
        failures = sum(1 for o in self._outcomes if not o)
        if failures / len(self._outcomes) >= self.threshold:
            self._opened_at = self._clock()

    def opened(self) -> bool:
        """Whether the circuit is currently open (the run should short-circuit to degrade)."""
        if self._opened_at is None:
            return False
        if self._clock() - self._opened_at >= self.cooldown_s:
            # Half-open: clear the window and resume — re-trips if failures continue.
            self._opened_at = None
            self._outcomes.clear()
            return False
        return True
