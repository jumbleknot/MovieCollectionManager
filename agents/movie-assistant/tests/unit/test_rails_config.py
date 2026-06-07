"""Parse/structure test for the NeMo Colang topic rails (T019, FR-005).

The live, LLM-backed topic-decline behaviour is verified in T060 against the real
model; this deterministic test asserts the `rails.co` Colang is well-formed and
defines the movie-domain confinement contract: an out-of-domain intent and a decline
flow that refuses it. (NeMo parses the Colang here — no LLM is invoked.)
"""

from __future__ import annotations

from pathlib import Path

from nemoguardrails import RailsConfig

_RAILS_CO = Path(__file__).resolve().parents[2] / "src" / "guardrails" / "rails.co"


def _load() -> RailsConfig:
    return RailsConfig.from_content(colang_content=_RAILS_CO.read_text(encoding="utf-8"))


def test_rails_colang_parses() -> None:
    cfg = _load()
    assert isinstance(cfg, RailsConfig)


def test_defines_in_domain_and_out_of_domain_intents() -> None:
    cfg = _load()
    assert "ask movie collection" in cfg.user_messages
    assert "ask out of domain" in cfg.user_messages


def test_defines_a_decline_flow_for_out_of_domain() -> None:
    cfg = _load()
    assert "refuse out of domain" in cfg.bot_messages
    assert len(cfg.flows) >= 1
