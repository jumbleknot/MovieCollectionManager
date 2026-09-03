"""One place that knows what a model provider's refusal looks like (065 / item #325).

WHY THIS EXISTS. On 2026-08-31 (app-e2e run 2450) the Anthropic account ran out of credit. The
Messages API answered **HTTP 400** `invalid_request_error` — not 402, not 429 — and the gateway
logged nothing at all: zero ERROR, zero Exception, zero Traceback for the whole run. The only trace
was an INFO-level `httpx` line for a third-party host. Diagnosing it took an hour and two wrong
turns, because every observable pointed at the app: green containers, a healthy gateway, a 200 on
`/agent/run`, and a UI element that never appeared.

Two frames swallow a provider error on the turn path, and they are told apart by `frame=`:

  * `classifier` — `graph.py`'s `_classify` catches ANY exception and degrades to "I couldn't
    complete that". Correct product behaviour, and it is what happened at 2450; what was wrong is
    that an INFRASTRUCTURE failure became indistinguishable from a product outcome.
  * `stream` — anything escaping the graph, which reaches the AG-UI stream boundary
    (`agui_identity.py`) after the 200 and headers are already flushed.

NO PROVIDER SDK IMPORT AT MODULE SCOPE, deliberately. `models.py` lazy-imports `langchain_anthropic`
so an Ollama-only deployment carries no Anthropic dependency; importing it here would undo that and
raise ImportError on the error path — the worst possible place for a second failure. The two facts
are read by duck typing from attributes the Anthropic and OpenAI SDK error shapes both expose.

This layer emits FACTS ONLY. The 400-is-operator-action vs 429/529-is-retry remediation mapping
lives in `scripts/e2e-turn-tally.sh` (PR #334) and is not duplicated here — two copies of a
remediation table is how they come to disagree.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from dataclasses import dataclass


@dataclass(frozen=True)
class ProviderError:
    """What a caught exception says about the provider.

    `status`/`type` are None when the exception is not a provider HTTP error, or when the provider
    returned a body this code cannot read (a truncated or HTML error page). `kind` distinguishes
    those two: `provider_http` means a status WAS found, so the call really was refused;
    `unexpected` means the failure is ours, and must never be reported with a fabricated status.
    """

    status: int | None
    type: str | None
    kind: str


def _status_of(exc: BaseException) -> int | None:
    """The HTTP status, from either attribute the SDK error shapes carry."""
    status = getattr(exc, "status_code", None)
    if status is None:
        status = getattr(getattr(exc, "response", None), "status_code", None)
    return status if isinstance(status, int) else None


def _type_of(exc: BaseException) -> str | None:
    """The provider's own error `type` (`invalid_request_error`, `rate_limit_error`, …).

    Tolerates every shape a refusal can arrive in — absent body, non-mapping body, non-mapping
    `error` — because a provider returning something unparseable is exactly the case this must
    survive rather than raise inside.
    """
    body = getattr(exc, "body", None)
    if not isinstance(body, Mapping):
        return None
    error = body.get("error")
    if not isinstance(error, Mapping):
        return None
    error_type = error.get("type")
    return error_type if isinstance(error_type, str) and error_type else None


def describe_provider_error(exc: BaseException) -> ProviderError:
    """Extract the two facts an engineer needs: which status, and which error type."""
    status = _status_of(exc)
    return ProviderError(
        status=status,
        type=_type_of(exc),
        kind="provider_http" if status is not None else "unexpected",
    )


def log_provider_error(
    logger: logging.Logger, exc: BaseException, *, frame: str
) -> ProviderError:
    """Write the ONE ERROR record naming status, type and the frame that caught it.

    Status, type, frame and the exception CLASS only. `str(exc)` is never formatted in: a provider
    echoes request content in some error messages, and the never-log list
    (`openwiki/invariants/logging-and-audit.md`) has no exemption for the error path. The class name
    is enough to tell a refusal from a timeout from a bug of ours, and carries no member data.

    Returns the description so a caller can branch on it without describing twice.
    """
    described = describe_provider_error(exc)
    logger.error(
        "provider call failed: status=%s type=%s frame=%s exc=%s",
        described.status if described.status is not None else "unknown",
        described.type or "unknown",
        frame,
        type(exc).__name__,
    )
    return described
