"""048 US1 (FR-003): `invoke_or_skip` must classify a cassette miss by TYPE, not by substring.

`invoke_or_skip` exists to absorb provider-CAPACITY failures (HTTP 529 / 429) mid-run, and it
decides by searching the stringified exception for `overloaded` / `529` / `rate_limit` / `429`.
That test is sound for the provider errors it was written for, but it is applied to *every*
exception — including `CassetteMissError`, whose message embeds a truncated sha256 cassette key.
A key beginning `529…` or `429…` is not a contrived case: it is roughly a 1-in-2000 per key over
hex, and there are dozens of keys. When it happens the loudest drift signal in the cassette design
is silently downgraded to a skip, and the golden gate reports green for a prompt that changed.

So the classification must be by exception type first: a `CassetteMissError` is drift and always
propagates, no matter what its text happens to contain.
"""

from __future__ import annotations

import pytest

from src.eval.cassette import CassetteMissError
from tests.integration.live_model import invoke_or_skip

# Real shape of a miss message, with a key that starts with a capacity keyword.
_MISS_WITH_CAPACITY_KEYWORD = (
    "no recorded response for key 529f1c0ab3d7… in us1-intent-out-of-domain.json; "
    "re-record this scenario"
)


def _raise(exc: BaseException) -> None:
    raise exc


def test_invoke_or_skip_cassette_miss_propagates_despite_capacity_keyword() -> None:
    """A cassette key that happens to contain `529` must not buy the miss a skip."""
    with pytest.raises(CassetteMissError):
        try:
            invoke_or_skip(_raise, CassetteMissError(_MISS_WITH_CAPACITY_KEYWORD))
        except pytest.skip.Exception as exc:  # noqa: PT017 - a skip here IS the defect
            raise AssertionError(
                f"CassetteMissError was misclassified as provider capacity and skipped: {exc}"
            ) from exc


def test_invoke_or_skip_cassette_miss_propagates_plain() -> None:
    """The ordinary miss (no capacity keyword) must propagate too — the baseline case."""
    with pytest.raises(CassetteMissError):
        try:
            invoke_or_skip(_raise, CassetteMissError("no recorded response for key abc…"))
        except pytest.skip.Exception as exc:  # noqa: PT017
            raise AssertionError(f"plain cassette miss was skipped: {exc}") from exc


def test_invoke_or_skip_still_skips_genuine_provider_overload() -> None:
    """Guard against over-tightening: a real 529 must STILL become a skip, not a failure.

    This is the behaviour `invoke_or_skip` was added for on 2026-07-20 (see its docstring and the
    `model provider overloaded after retries` entry in `_LEGITIMATE_SKIPS`). Narrowing the cassette
    case must not cost it.
    """
    with pytest.raises(pytest.skip.Exception):
        invoke_or_skip(_raise, RuntimeError("Error code: 529 - overloaded_error"))


def test_invoke_or_skip_still_raises_a_non_capacity_error() -> None:
    """A 4xx / malformed request still fails loudly — unchanged."""
    with pytest.raises(ValueError):
        invoke_or_skip(_raise, ValueError("invalid x-api-key"))
