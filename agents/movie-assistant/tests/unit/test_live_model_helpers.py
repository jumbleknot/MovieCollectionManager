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
from tests.integration.live_model import (
    invoke_or_skip,
    live_model_required,
    require_live_credential,
)

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


# ── 048 US2: the pre-deploy live gate must not skip its way to green ────────────────────────────

_OVERLOAD = RuntimeError("Error code: 529 - overloaded_error")


def test_require_live_credential_passes_when_a_key_is_present() -> None:
    require_live_credential({"ANTHROPIC_API_KEY": "sk-ant-whatever"}, "live gate")  # no raise


def test_require_live_credential_skips_locally_without_the_gate_flag() -> None:
    """A developer's credential-less checkout keeps its skip-clean behaviour (constitution)."""
    with pytest.raises(pytest.skip.Exception):
        require_live_credential({}, "live gate needs Claude")


def test_require_live_credential_fails_under_the_gate_flag() -> None:
    """FR-007 / US2-AC3: the live gate FAILS when it cannot obtain a credential.

    Measured 2026-08-07 before this existed: `nx test:golden-live` with no key reported
    `1 passed, 50 skipped`, exit 0 — a gate that would have let any deploy through.
    """
    with pytest.raises(pytest.fail.Exception) as excinfo:
        require_live_credential({"MCM_REQUIRE_LIVE_MODEL": "1"}, "live gate needs Claude")
    assert "ANTHROPIC_API_CD_GOLDEN" in str(excinfo.value)  # names the fix, not just the fault


def test_require_live_credential_whitespace_only_key_is_not_a_credential() -> None:
    """A secret that resolved to an empty/whitespace string must not satisfy the gate."""
    with pytest.raises(pytest.fail.Exception):
        require_live_credential(
            {"MCM_REQUIRE_LIVE_MODEL": "1", "ANTHROPIC_API_KEY": "   "}, "live gate"
        )


def test_live_model_required_reads_the_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MCM_REQUIRE_LIVE_MODEL", raising=False)
    assert live_model_required() is False
    monkeypatch.setenv("MCM_REQUIRE_LIVE_MODEL", "1")
    assert live_model_required() is True


def test_capacity_outage_blocks_the_deploy_but_stays_distinguishable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """US2-AC4: an exhausted-retry 529 must be a DISTINGUISHABLE infrastructure outcome.

    Two things must both hold at the deploy boundary. It must not be a silent pass — an unreachable
    provider means the model decision was never verified, so the deploy is blocked. And it must not
    be mistaken for a classification regression, or an on-call engineer burns the incident hunting a
    prompt change that never happened. So: a failure whose text names it as infrastructure.
    """
    monkeypatch.setenv("MCM_REQUIRE_LIVE_MODEL", "1")
    with pytest.raises(pytest.fail.Exception) as excinfo:
        invoke_or_skip(_raise, _OVERLOAD)
    message = str(excinfo.value)
    assert "PROVIDER CAPACITY" in message
    assert "NOT a classification defect" in message


def test_capacity_outage_still_only_skips_outside_the_gate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Outside the gate a mid-run 529 stays a skip — the 2026-07-20 behaviour is unchanged."""
    monkeypatch.delenv("MCM_REQUIRE_LIVE_MODEL", raising=False)
    with pytest.raises(pytest.skip.Exception):
        invoke_or_skip(_raise, _OVERLOAD)


def test_cassette_miss_outranks_the_gate_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    """Drift is drift in every mode: still raised, never converted, flag set or not."""
    monkeypatch.setenv("MCM_REQUIRE_LIVE_MODEL", "1")
    with pytest.raises(CassetteMissError):
        invoke_or_skip(_raise, CassetteMissError(_MISS_WITH_CAPACITY_KEYWORD))
