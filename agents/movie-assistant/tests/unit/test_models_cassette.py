"""build_chat_model cassette-mode dispatch (T032)."""

from pathlib import Path

from src.eval.cassette import Cassette, RecordingChatModel, ReplayChatModel, cassette_key, use
from src.models import ModelSpec, build_chat_model


def test_replay_mode_returns_replay_model_without_key(tmp_path: Path):
    # No ANTHROPIC_API_KEY, provider=anthropic — replay must not touch the provider.
    cassette = Cassette.load(tmp_path / "s.json", "claude-haiku-4-5")
    cassette.put(cassette_key("claude-haiku-4-5", "hi"), {"content": "add", "tool_calls": []})
    spec = ModelSpec(provider="anthropic", model_id="claude-haiku-4-5", temperature=0.0)
    with use(cassette):
        model = build_chat_model(spec, {"LLM_CASSETTE_MODE": "replay"})
    assert isinstance(model, ReplayChatModel)
    assert model.invoke("hi").content == "add"


def test_record_mode_wraps_real(monkeypatch, tmp_path: Path):
    # Avoid building a real provider: stub _build_real_chat_model.
    class _Fake:
        def invoke(self, _x, *_a, **_k):
            from langchain_core.messages import AIMessage

            return AIMessage(content="enrich")

    monkeypatch.setattr("src.models._build_real_chat_model", lambda spec, env: _Fake())
    cassette = Cassette.load(tmp_path / "r.json", "qwen2.5")
    spec = ModelSpec(provider="ollama", model_id="qwen2.5", temperature=0.0)
    with use(cassette):
        model = build_chat_model(spec, {"LLM_CASSETTE_MODE": "record"})
        assert isinstance(model, RecordingChatModel)
        assert model.invoke("classify").content == "enrich"
    # Recorded to disk.
    reloaded = Cassette.load(tmp_path / "r.json", "qwen2.5")
    assert reloaded.require(cassette_key("qwen2.5", "classify"))


def test_off_mode_builds_real_unchanged():
    # Default (no cassette mode) returns a real ChatOllama (constructs offline, no network).
    spec = ModelSpec(provider="ollama", model_id="qwen2.5", temperature=0.0)
    model = build_chat_model(spec, {})
    assert not isinstance(model, (ReplayChatModel, RecordingChatModel))
    assert hasattr(model, "invoke")
