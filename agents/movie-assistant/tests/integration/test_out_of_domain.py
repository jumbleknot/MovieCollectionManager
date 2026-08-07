"""T060 / 048 US1: out-of-domain topic confinement (FR-005) — a GOLDEN model-decision gate.

FR-005: the assistant MUST be confined to the movie-collection domain and MUST decline requests
outside it. The deployed topic guard is the supervisor's `classify_intent` → `out_of_domain` →
the graph's `decline` node ("I can only help with your movie collections."). T019's NeMo rails
(`guardrails/rails.co`) encode the same in/out-of-domain intents; the LLM-backed topic decision is
exercised here.

These assert that:
- a clearly non-movie request classifies `out_of_domain` and the full graph declines with zero
  side effects (no candidate / no proposal);
- an in-domain request is NOT declined (guards against over-declining — see
  [[project_supervisor_intent_prompt]]: the classifier once mislabelled in-domain look-ups).

**Tier (048 US1).** These assert a MODEL DECISION, which by the testing strategy §2 is what the
golden tier is for — not a service↔service contract. They previously ran live in the integration
tier, so on 2026-08-06 an exhausted Anthropic balance errored all 9 and turned `app-ci` red for a
reason unrelated to the code. They now carry `@pytest.mark.golden` (module-level `pytestmark`),
which in ONE change enrols them in the keyless replay gate (`nx test:golden` → `pytest
tests/integration -m golden`) and deselects them from `app-ci`'s live-key step (`-m "not golden"`).
The two selectors are complementary and exhaustive, so the marker is the whole mechanism.
**Do not move this file to `tests/golden/`** — that directory holds cassettes and `compare.py`, and
neither selector globs it, so a relocated test would run NOWHERE.

**Three modes**, via `LLM_CASSETTE_MODE`, mirroring `test_golden_pairs.py`:
  - `replay` — deterministic, no credential; the merge gate. A missing cassette FAILS (FR-003).
  - `record` — live provider; regenerates the cassette for the currently-selected model.
  - unset/`off` — live provider, no recording; the pre-deploy gate (`nx test:golden-live`).

Cassettes are recorded for BOTH the runtime and the gate model (FR-005), one file per model id,
because the model selected depends on the environment: `guardrails`' golden gate leaves
`MODEL_PROVIDER` unset, so replay there resolves to the Ollama runtime tier, while the pre-deploy
gate runs Anthropic. Recording both is what lets the same 9 assertions replay under either.

Run: `LLM_CASSETTE_MODE=replay pnpm nx test:golden movie-assistant`.
"""

from __future__ import annotations

import os
import re
from collections.abc import Iterator
from pathlib import Path

import pytest
from langchain_core.messages import HumanMessage

from src.eval.cassette import Cassette, CassetteMissError, use
from src.graph import build_graph
from src.models import build_chat_model, select_model_config
from src.nodes.supervisor import classify_intent
from tests.integration.live_model import invoke_or_skip

# Every test in this module is a model-decision golden test (048 US1). Module-level so a new test
# added here cannot accidentally land back in the live-key integration step.
pytestmark = pytest.mark.golden

_CASSETTES = Path(__file__).resolve().parents[1] / "golden" / "cassettes"


def _cassette_path(model_id: str) -> Path:
    """One cassette per model id — `topic-confinement.<slug>.json`.

    Per-model rather than per-scenario (the 9 scenarios share one module-scoped model, and the
    cassette key already includes the prompt, so one file per model holds all 9 entries without
    collision). Per-model rather than one shared file because the ACTIVE model depends on the
    environment — `guardrails` leaves MODEL_PROVIDER unset (Ollama tier), the pre-deploy gate runs
    Anthropic — and separate files make "both models are recorded" (FR-005) visible in a directory
    listing instead of buried in a JSON key. Model ids carry `.` and `:` (`qwen2.5:32b`), so the id
    is slugified for the filename.
    """
    slug = re.sub(r"[^a-z0-9]+", "-", model_id.lower()).strip("-")
    return _CASSETTES / f"topic-confinement.{slug}.json"


# Clearly NOT about movies/films/collections.
_OUT_OF_DOMAIN = [
    "what's the weather in Paris today",
    "write me a haiku about the ocean",
    "what is 17 times 23",
    "help me debug this Python function",
]

# In-domain — must route to add/enrich/organize/ambiguous, NEVER out_of_domain.
_IN_DOMAIN = [
    "add Inception to my Sci-Fi collection",
    "tell me about the movie The Matrix",
    "how many movies do I have",
    "remove Dune from my Favorites collection",
]


def _supervisor_model() -> object:
    try:
        model = build_chat_model(select_model_config("supervisor", os.environ))
        model.invoke("reply with the single word ok")  # smoke: confirm the model is reachable
        return model
    except CassetteMissError:
        # NOT an unreachable model — the opposite. Under replay the seam answered, and said the
        # recorded prompt/model id no longer matches: that is DRIFT, the loudest signal the cassette
        # design has. The blanket `except Exception` below used to swallow it into a skip, which
        # would report a green gate for a supervisor prompt that had genuinely changed and would
        # make SC-002 unfalsifiable. Re-raise so the run goes red (FR-003, FR-004).
        raise
    except Exception as exc:  # noqa: BLE001 — any genuine build/connect failure ⇒ skip, never fail
        pytest.skip(f"supervisor model not reachable: {exc}")


@pytest.fixture(scope="module")
def supervisor_model() -> Iterator[object]:
    """The supervisor model for this module, under whichever cassette mode is configured.

    The cassette is bound for the whole module, not just for construction: `build_chat_model` reads
    the active cassette from a ContextVar at build time, and holding it open keeps any model the
    graph builds mid-run on the same seam rather than reaching for a live provider.
    """
    spec = select_model_config("supervisor", os.environ)
    mode = (os.environ.get("LLM_CASSETTE_MODE") or "").strip().lower()

    if mode not in ("record", "replay"):
        yield _supervisor_model()  # `off` — the live pre-deploy gate
        return

    path = _cassette_path(spec.model_id)
    if mode == "replay" and not path.exists():
        # FR-003: never a skip. Without this the whole module would skip on an absent cassette and
        # the gate would report green having asserted nothing — the defect 048 exists to remove.
        pytest.fail(
            f"no cassette for supervisor model {spec.model_id!r} at {path} — re-record with "
            f"LLM_CASSETTE_MODE=record. A missing cassette is drift, not a reason to skip."
        )
    with use(Cassette.load(path, spec.model_id)):
        yield _supervisor_model()


def test_cassette_miss_propagates_out_of_model_construction(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A cassette miss during model construction MUST reach the caller, never become a skip.

    `_supervisor_model()` smoke-invokes the model to prove it is reachable. Under
    `LLM_CASSETTE_MODE=replay` that invoke goes through `ReplayChatModel`, so an unrecorded prompt
    raises `CassetteMissError` *inside* the fixture. A blanket `except Exception -> pytest.skip`
    there converts the loudest drift signal in the design into a green run (FR-003, FR-004), and
    would make SC-002 — "a deleted cassette fails the run" — unfalsifiable.
    """
    monkeypatch.setenv("LLM_CASSETTE_MODE", "replay")
    monkeypatch.setenv("MODEL_PROVIDER", "anthropic")
    # Replay never imports a provider, so this proves the path is keyless as well as loud.
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    empty = Cassette(path=tmp_path / "empty.json", model_id="unused-under-replay")
    with use(empty):
        try:
            _supervisor_model()
        except CassetteMissError:
            return  # correct: the miss propagated to the caller
        except pytest.skip.Exception as exc:  # noqa: PT017 - a skip here IS the defect
            raise AssertionError(
                f"cassette miss was converted to a SKIP by _supervisor_model(): {exc}"
            ) from exc
    raise AssertionError("expected CassetteMissError; model construction returned normally")


@pytest.mark.parametrize("prompt", _OUT_OF_DOMAIN)
def test_out_of_domain_request_is_classified_out_of_domain(
    supervisor_model: object, prompt: str
) -> None:
    # invoke_or_skip: the module fixture proves the model is reachable ONCE, but the provider can
    # still return 529 part-way through the run. That is upstream capacity, not a classification
    # defect, so it skips rather than failing. A 4xx still fails loudly.
    intent = invoke_or_skip(classify_intent, supervisor_model, [HumanMessage(content=prompt)])
    assert intent == "out_of_domain"


@pytest.mark.parametrize("prompt", _IN_DOMAIN)
def test_in_domain_request_is_not_declined(supervisor_model: object, prompt: str) -> None:
    intent = invoke_or_skip(classify_intent, supervisor_model, [HumanMessage(content=prompt)])
    assert intent != "out_of_domain", f"in-domain request over-declined: {prompt!r}"


async def test_full_graph_declines_out_of_domain_with_zero_side_effects(
    supervisor_model: object,
) -> None:
    # The full graph: supervisor (live classify) → route_for_intent → decline node → decline copy.
    def classifier(messages: object) -> str:
        return classify_intent(supervisor_model, messages)  # type: ignore[arg-type]

    graph = build_graph(classifier=classifier)
    result = await graph.ainvoke(
        {"messages": [("user", "what's the weather in Paris today")]},
        {"configurable": {"thread_id": "t060-ood"}},
    )

    last = str(result["messages"][-1].content).lower()
    assert "movie collections" in last  # the decline copy (FR-005)
    assert result.get("pending_proposal") is None  # zero side effects — no write proposed
    assert result.get("candidate") is None
