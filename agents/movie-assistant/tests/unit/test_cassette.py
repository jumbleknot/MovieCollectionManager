"""Unit tests for the LLM cassette layer (T032)."""

from pathlib import Path

import pytest
from langchain_core.messages import AIMessage, HumanMessage

from src.eval.cassette import (
    Cassette,
    CassetteMissError,
    RecordingChatModel,
    ReplayChatModel,
    cassette_key,
    use,
)


class _FakeModel:
    """Stand-in chat model: returns a fixed AIMessage, records call count."""

    def __init__(self, content: str) -> None:
        self._content = content
        self.calls = 0

    def invoke(self, _input, *_a, **_k) -> AIMessage:
        self.calls += 1
        return AIMessage(content=self._content)


def test_cassette_key_deterministic_for_same_input():
    # Same input → same key (str and message-list paths are each stable). The real call
    # sites pass a built prompt STRING to model.invoke, so str-determinism is what matters.
    assert cassette_key("m1", "add Coherence") == cassette_key("m1", "add Coherence")
    msgs = [HumanMessage(content="add Coherence")]
    assert cassette_key("m1", msgs) == cassette_key("m1", [HumanMessage(content="add Coherence")])


def test_cassette_key_differs_by_model_and_prompt():
    assert cassette_key("m1", "x") != cassette_key("m2", "x")
    assert cassette_key("m1", "x") != cassette_key("m1", "y")


def test_recording_calls_real_and_persists(tmp_path: Path):
    path = tmp_path / "rec.json"
    inner = _FakeModel("add")
    rec = RecordingChatModel(inner, Cassette.load(path, "m1"), "m1")
    out = rec.invoke("classify: add Coherence")
    assert out.content == "add"
    assert inner.calls == 1
    # Reload from disk: the response is keyed by the prompt hash.
    reloaded = Cassette.load(path, "m1")
    assert reloaded.require(cassette_key("m1", "classify: add Coherence"))["content"] == "add"


def test_replay_returns_recorded_without_calling_real(tmp_path: Path):
    path = tmp_path / "rep.json"
    cassette = Cassette.load(path, "m1")
    cassette.put(cassette_key("m1", "p"), {"content": "enrich", "tool_calls": []})
    cassette.save()
    replay = ReplayChatModel(Cassette.load(path, "m1"), "m1")
    out = replay.invoke("p")
    assert isinstance(out, AIMessage)
    assert out.content == "enrich"


def test_replay_miss_raises(tmp_path: Path):
    replay = ReplayChatModel(Cassette.load(tmp_path / "empty.json", "m1"), "m1")
    with pytest.raises(CassetteMissError):
        replay.invoke("never recorded")


def test_use_sets_active_cassette(tmp_path: Path):
    from src.eval.cassette import active_cassette

    cassette = Cassette.load(tmp_path / "a.json", "m1")
    with use(cassette):
        assert active_cassette() is cassette
