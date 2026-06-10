"""Golden-pair regression gate (T032/T063).

Runs the shipped model (Anthropic Claude) on exemplar inputs and asserts the agent's model
decisions. Three modes via LLM_CASSETTE_MODE:
  - replay  : deterministic, no key — reads committed cassettes (CI gate). Skips a pair with
              no cassette.
  - record  : live Claude — records cassettes (run once to (re)generate fixtures).
  - off     : live Claude — asserts without recording (the pre-deploy live gate, T063).
Skips cleanly when neither a key (record/off) nor a cassette (replay) is available, so a
credential-less checkout stays green (constitution Test Type Integrity). See research R13.
"""

import json
import os
from contextlib import nullcontext
from pathlib import Path

import pytest
from langchain_core.messages import HumanMessage

from src.eval.cassette import Cassette, use
from src.models import build_chat_model, select_model_config
from src.nodes.curator import extract_entities
from src.nodes.organizer import plan_operations
from src.nodes.query import extract_query
from src.nodes.supervisor import classify_intent
from tests.golden.compare import compare_decision

_GOLDEN_PROVIDER = "anthropic"

# Golden decision kind → the graph node whose model tier produces it.
_KIND_NODE = {
    "intent": "supervisor",
    "extraction": "curator",
    "plan": "organizer",
    "query-extraction": "query",
}


def _pairs() -> list[dict]:
    root = Path(__file__).resolve().parents[2]
    return list(json.loads((root / "tests/golden/dataset.json").read_text(encoding="utf-8")))


def _messages(model_input: object) -> list[HumanMessage]:
    if isinstance(model_input, str):
        return [HumanMessage(content=model_input)]
    assert isinstance(model_input, list)
    return [HumanMessage(content=m["content"]) for m in model_input]


@pytest.mark.golden
@pytest.mark.parametrize("pair", _pairs(), ids=lambda p: p["id"])
def test_golden_pair(pair: dict, cassettes_dir: Path) -> None:
    kind = pair["kind"]
    node = _KIND_NODE.get(kind, "curator")
    # Force the golden provider AND drop any per-node Ollama model overrides from .env.local
    # so the Anthropic tier defaults apply (claude-haiku/claude-sonnet) — not "qwen2.5".
    env = {**os.environ, "MODEL_PROVIDER": _GOLDEN_PROVIDER}
    env.pop("SUPERVISOR_MODEL", None)
    env.pop("SPECIALIST_MODEL", None)
    mode = (env.get("LLM_CASSETTE_MODE") or "").strip().lower()
    spec = select_model_config(node, env)
    cassette_path = cassettes_dir / f"{pair['id']}.json"

    if mode == "replay":
        if not cassette_path.exists():
            pytest.skip(f"no cassette for {pair['id']} (record first)")
        ctx: object = use(Cassette.load(cassette_path, spec.model_id))
    elif mode == "record":
        if not env.get("ANTHROPIC_API_KEY"):
            pytest.skip("ANTHROPIC_API_KEY not set (record needs live Claude)")
        ctx = use(Cassette.load(cassette_path, spec.model_id))
    else:  # off / live gate
        if not env.get("ANTHROPIC_API_KEY"):
            pytest.skip("ANTHROPIC_API_KEY not set (live gate needs Claude)")
        ctx = nullcontext()

    messages = _messages(pair["input"])
    with ctx:  # type: ignore[attr-defined]
        model = build_chat_model(spec, env)
        if kind == "intent":
            actual: object = classify_intent(model, messages)
        elif kind == "plan":
            actual = plan_operations(model, messages)
        elif kind == "query-extraction":
            actual = extract_query(model, messages)
        else:
            actual = extract_entities(model, messages)

    ok, reason = compare_decision(kind, pair["expected"], actual, pair.get("tolerance"))
    assert ok, f"{pair['id']}: {reason}"
