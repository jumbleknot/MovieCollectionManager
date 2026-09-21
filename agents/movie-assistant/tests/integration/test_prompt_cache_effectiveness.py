"""Prompt caching must actually ENGAGE — not merely be configured.

Implements: T012 / FR-009, FR-010, FR-011, FR-012. Research: specs/075-llm-cost-phase-1/ R2, R7.

── WHY THIS IS A TEST AND NOT A DASHBOARD CHECK ────────────────────────────────────────────────

The original plan for verifying this change was: "confirm on the console the next day that the CI
key shows input_cache_read rows; that is the whole test."

It is not a test. Caching is a PREFIX MATCH. One interpolated byte in the static block and the
cache-read rate goes to zero — with no exception, no 4xx, and no other failing assertion. The only
symptom is a number on a vendor dashboard, a day later, that nobody is watching. An operator who
looked once and saw green cannot defend the property in six months.

`usage_metadata["input_token_details"]["cache_read"]` is emitted on EVERY Anthropic response today
and is read by nothing. This file is the first reader.

── WHY IT MUST BE LIVE ─────────────────────────────────────────────────────────────────────────

A replayed cassette reconstructs an AIMessage from JSON and carries no usage metadata, so the
assertion would be vacuous. This tier therefore runs against the real provider, is marked NOT
golden so it never enters the keyless replay gate, and inherits the fail-not-skip escalation that
feature 048 put in place after a credential-less gate reported "1 passed, 50 skipped", exit 0.
"""

from __future__ import annotations

import os

import pytest

from src.models import build_chat_model, select_model_config
from src.nodes.supervisor import build_classify_messages
from tests.integration.live_model import invoke_or_skip, require_live_credential

# The tier CI's burst surfaces select. Kept as a local mapping because `select_model_config` is pure
# over a Mapping — no process-env mutation needed, so this test cannot leak into its neighbours.
_CACHED_TIER_ENV = {"MODEL_PROVIDER": "anthropic", "ANTHROPIC_SUPERVISOR_MODEL": "claude-sonnet-5"}
_FAST_TIER_ENV = {"MODEL_PROVIDER": "anthropic"}


def _cache_counts(response) -> tuple[int, int]:
    """(cache_read, cache_creation) for one response, defaulting absent fields to 0."""
    details = (getattr(response, "usage_metadata", None) or {}).get("input_token_details") or {}
    return int(details.get("cache_read") or 0), int(details.get("cache_creation") or 0)


def test_a_repeated_classification_is_served_from_cache() -> None:
    """FR-009 / SC-003: the second of two back-to-back classifications reads from cache.

    The first call pays the cache WRITE; the second should read. A five-minute entry comfortably
    covers two successive calls, so a zero here has essentially one cause — see the failure text.
    """
    require_live_credential(os.environ, "prompt-cache effectiveness (cached tier)")

    spec = select_model_config("supervisor", {**os.environ, **_CACHED_TIER_ENV})
    model = build_chat_model(spec, os.environ)

    first = invoke_or_skip(model.invoke, build_classify_messages("find the movie Dune"))
    second = invoke_or_skip(model.invoke, build_classify_messages("how many movies do I have"))

    read_1, write_1 = _cache_counts(first)
    read_2, write_2 = _cache_counts(second)

    assert read_2 > 0, (
        "PREFIX INSTABILITY (almost certainly): the second classification on "
        f"{spec.model_id} read ZERO tokens from cache.\n"
        f"  call 1: cache_read={read_1} cache_creation={write_1}\n"
        f"  call 2: cache_read={read_2} cache_creation={write_2}\n\n"
        "Prompt caching is a prefix match, so the usual cause is that something per-call leaked "
        "into the supervisor's static block and the two requests no longer share a prefix. Check "
        "`_CLASSIFY_SYSTEM_PROMPT` for an interpolated value, and run "
        "`pytest tests/unit/test_supervisor_prompt_cache.py`, which catches that offline.\n\n"
        "This is NOT a provider outage: an outage raises, and `invoke_or_skip` would have "
        "classified it as capacity before reaching this assertion. It is also not a flake — the "
        "whole point of this test is that the failure it detects is otherwise SILENT and simply "
        "doubles the bill."
    )
    # NOT `write_1 > 0`. The cache entry survives between runs for five minutes, so a first call
    # that follows a recent run READS rather than writes — a cold-cache assumption here would make
    # this test pass or fail depending on how recently it last ran, which is the definition of a
    # flake. What actually proves the marker reached the wire is that the first call did EITHER.
    assert (read_1 + write_1) > 0, (
        f"the first call neither wrote nor read the cache (read={read_1} write={write_1}), so the "
        "`cache_control` marker is not reaching the wire at all — check that the static block is "
        "still a structured content block carrying it, rather than a bare string."
    )


def test_the_marker_is_inert_on_the_fast_tier_that_production_uses() -> None:
    """FR-012 / US2-AC3: the cache marking must be IGNORED, not rejected, where it cannot apply.

    Production keeps the fast tier, whose minimum cacheable prefix (4,096 tokens) this ~1,700-token
    prompt does not clear. The restructure must therefore be completely inert there: the call
    succeeds and is billed exactly as before. If this ever raises, the prompt change has broken
    production rather than leaving it untouched.
    """
    require_live_credential(os.environ, "prompt-cache inertness (fast tier)")

    spec = select_model_config("supervisor", {**os.environ, **_FAST_TIER_ENV})
    model = build_chat_model(spec, os.environ)

    response = invoke_or_skip(model.invoke, build_classify_messages("find the movie Dune"))

    assert str(response.content).strip(), f"{spec.model_id} returned nothing for a classification"
    read, write = _cache_counts(response)
    assert read == 0 and write == 0, (
        f"{spec.model_id} reported cache activity (read={read} write={write}). Its minimum "
        "cacheable prefix is 4,096 tokens and this prompt is ~1,700, so the marker should be a "
        "silent no-op. If the vendor lowered that minimum, production is now paying cache WRITES "
        "on isolated user turns — which costs MORE than the uncached call it replaced (break-even "
        "is a ~65% hit rate that real user traffic never reaches). Re-check the production default."
    )


@pytest.mark.parametrize("mode", ["record", "replay"])
def test_this_tier_is_meaningless_under_a_cassette(mode: str) -> None:
    """Guard the guard: a replayed message carries no usage metadata, so nothing above would hold.

    Parametrised rather than asserted once so the reason is legible in the test id when it fires.
    """
    assert (os.environ.get("LLM_CASSETTE_MODE") or "").strip().lower() != mode, (
        f"LLM_CASSETTE_MODE={mode!r}: a replayed AIMessage carries no usage_metadata, so the "
        "cache assertions above would be vacuous. Run this tier with the cassette mode unset."
    )
