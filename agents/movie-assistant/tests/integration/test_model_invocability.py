"""Every model this repo can RESOLVE must be INVOCABLE with the parameters this repo SENDS.

Implements: T005 / FR-028. Research: specs/075-llm-cost-phase-1/research.md R13.

── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────────────

Nothing here asserted that a configured model actually answers. Every gate was green and truthful
about a NARROWER claim than the one being relied on:

  * the OpenWiki generator guard checks an output cap, and never calls a provider;
  * `select_model_config` is pure, so its unit tests resolve ids without building a model;
  * the golden suite replays cassettes, so it never constructs a real chat model at all.

A model id can therefore be current, correctly spelled, present in every vendor table, and still
400 on the parameters we send it. Measured 2026-09-21, one live call per id:

    claude-haiku-4-5    temperature=0.0 -> accepted
    claude-sonnet-4-6   temperature=0.0 -> accepted
    claude-opus-4-6     temperature=0.0 -> accepted
    claude-sonnet-5     temperature=0.0 -> 400 `temperature` is deprecated for this model
    claude-opus-5       temperature=0.0 -> 400 (same)
    claude-opus-4-8     temperature=0.0 -> 400 (same)

Two defects hid behind that. The escalation tier is pinned to `claude-opus-4-8` and would have
failed on FIRST USE the moment `mcm.agent.frontier-escalation` was enabled — dormant, so never
observed. And feature 075's own headline change (a cached `claude-sonnet-5` supervisor) could not
have worked at all.

This test is the missing instrument. It is deliberately about the SEAM, not about a hand-rolled
client: it goes through `build_chat_model`, so it exercises exactly the parameters production
sends. A test that constructed its own `ChatAnthropic` would pass while the gateway kept 400ing.

── TIER ────────────────────────────────────────────────────────────────────────────────────────

Live-model integration, NOT golden: it needs the real provider (a cassette cannot 400), and it must
never enter the keyless replay gate. Cost is a handful of tokens per model — `max_tokens` is tiny
and the prompt is four words.
"""

from __future__ import annotations

import os

import pytest

from src.models import ModelSpec, build_chat_model, select_model_config
from tests.integration.live_model import invoke_or_skip, require_live_credential

# NO `golden` marker, deliberately. Tier selection here is by DIRECTORY plus that one marker:
# `pytest tests/integration -m golden` is the keyless replay gate (this file must never enter it —
# it needs a real provider), and `-m "not golden"` is the live integration tier CI runs with a key.
# `integration` is not a registered marker; adding one would only emit PytestUnknownMarkWarning.

# Every Anthropic id the selection logic can land on, and where it comes from. Keep this list
# derived from `select_model_config` rather than hand-copied: the point is to cover what the repo
# can RESOLVE, so a new default or a new pinned surface must show up here.
_ANTHROPIC_ENV = {"MODEL_PROVIDER": "anthropic"}


def _resolvable_anthropic_specs() -> list[tuple[str, ModelSpec]]:
    """The (label, spec) pairs a real run can produce on the Anthropic provider."""
    specs = [
        ("supervisor default", select_model_config("supervisor", _ANTHROPIC_ENV)),
        ("specialist default", select_model_config("curator", _ANTHROPIC_ENV)),
        ("escalation default", select_model_config("escalation", _ANTHROPIC_ENV)),
    ]
    # Surfaces that PIN a model rather than taking the default: CI's app-e2e job and the dev
    # container select a cached-tier supervisor by provider-scoped override (075 FR-007/R4). A pin
    # that nothing ever invokes here would be exactly the blind spot this file exists to remove.
    pinned = (os.environ.get("ANTHROPIC_SUPERVISOR_MODEL") or "").strip()
    if pinned:
        specs.append(
            ("supervisor pin (ANTHROPIC_SUPERVISOR_MODEL)", ModelSpec("anthropic", pinned, 0.0))
        )
    return specs


@pytest.mark.parametrize(
    "label,spec",
    _resolvable_anthropic_specs(),
    ids=lambda v: v if isinstance(v, str) else getattr(v, "model_id", str(v)),
)
def test_resolvable_anthropic_model_is_invocable(label: str, spec: ModelSpec) -> None:
    """The model answers with the parameters `build_chat_model` actually sends it.

    A 4xx here is a REQUEST defect — a parameter the model rejects, or an id it does not know —
    and is the failure this test exists to surface. A 5xx/429/529 is provider capacity and is
    converted to a skip (or, under the live gate, to a failure that NAMES itself infrastructure)
    by `invoke_or_skip`.
    """
    require_live_credential(os.environ, f"model invocability: {label} ({spec.model_id})")

    model = build_chat_model(spec, os.environ)
    response = invoke_or_skip(model.invoke, "Reply with exactly: OK")

    assert str(response.content).strip(), (
        f"{label} ({spec.model_id}) returned empty content — it accepted the request but said "
        "nothing, which is not a working model."
    )


def test_cassette_mode_is_off_so_this_tier_measures_the_real_provider() -> None:
    """Guard the guard: under replay this whole file would assert nothing.

    `build_chat_model` returns a `ReplayChatModel` when `LLM_CASSETTE_MODE` is record/replay, which
    never contacts a provider and therefore can never 400. If this tier were ever run with the
    cassette mode set, every test above would pass while proving nothing — the precise shape of
    false green this file was written to eliminate.
    """
    mode = (os.environ.get("LLM_CASSETTE_MODE") or "").strip().lower()
    assert mode not in ("record", "replay"), (
        f"LLM_CASSETTE_MODE={mode!r} substitutes a replay model for the real one, so the "
        "invocability assertions above would pass without contacting any provider. Run this tier "
        "with the cassette mode unset."
    )
