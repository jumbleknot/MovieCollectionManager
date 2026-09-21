"""Deterministic LLM cassette: record real provider responses, replay them offline.

The single LLM seam is `models.build_chat_model`; this module supplies the record/replay
wrappers it returns when LLM_CASSETTE_MODE is set. Cassettes are keyed by a hash of
(model_id + serialized prompt), so a prompt change produces a miss (fails loudly) rather
than silently replaying a stale response. Used by the golden-pair regression gate (T032).
"""

import hashlib
import json
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

from langchain_core.messages import AIMessage


@runtime_checkable
class ChatModel(Protocol):
    """The only chat-model surface the graph uses: a synchronous `.invoke`."""

    def invoke(self, model_input: Any, /, *args: Any, **kwargs: Any) -> Any: ...


class CassetteMissError(LookupError):
    """Raised on replay when no recorded response matches the prompt (re-record needed)."""


def _normalize(model_input: Any) -> list[tuple[str, str]]:
    """Normalize a str or a list of LangChain messages to [(role, text), ...]."""
    if isinstance(model_input, str):
        return [("user", model_input)]
    out: list[tuple[str, str]] = []
    for message in model_input:
        role = getattr(message, "type", None) or getattr(message, "role", "user")
        content = getattr(message, "content", message)
        out.append((str(role), str(content)))
    return out


def cassette_key(model_id: str, model_input: Any) -> str:
    """Stable sha256 over model id + serialized prompt."""
    payload = model_id + "\n" + "\n".join(
        f"{role}: {text}" for role, text in _normalize(model_input)
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


@dataclass
class Cassette:
    """A per-scenario JSON file of recorded responses keyed by `cassette_key`."""

    path: Path
    model_id: str
    entries: dict[str, dict[str, Any]] = field(default_factory=dict)

    @classmethod
    def load(cls, path: Path, model_id: str) -> "Cassette":
        if path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
            return cls(path, str(data.get("model_id", model_id)), dict(data.get("entries", {})))
        return cls(path, model_id, {})

    def require(self, key: str) -> dict[str, Any]:
        try:
            return self.entries[key]
        except KeyError as exc:
            raise CassetteMissError(
                f"no recorded response for key {key[:12]}… in {self.path.name}; "
                "re-record this scenario"
            ) from exc

    def put(self, key: str, entry: dict[str, Any]) -> None:
        self.entries[key] = entry

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(
            json.dumps(
                {"model_id": self.model_id, "entries": self.entries}, indent=2, sort_keys=True
            ),
            encoding="utf-8",
        )


_ACTIVE: ContextVar[Cassette | None] = ContextVar("active_cassette", default=None)


@contextmanager
def use(cassette: Cassette) -> Iterator[Cassette]:
    """Set the active cassette for `build_chat_model` for the duration of the block."""
    token = _ACTIVE.set(cassette)
    try:
        yield cassette
    finally:
        _ACTIVE.reset(token)


def active_cassette() -> Cassette:
    cassette = _ACTIVE.get()
    if cassette is None:
        raise RuntimeError("no active cassette; wrap the call in cassette.use(...)")
    return cassette


class ReplayChatModel:
    """Returns recorded responses; never imports or calls a real provider."""

    def __init__(self, cassette: Cassette, model_id: str) -> None:
        self._cassette = cassette
        self._model_id = model_id

    def invoke(self, model_input: Any, *_args: Any, **_kwargs: Any) -> AIMessage:
        entry = self._cassette.require(cassette_key(self._model_id, model_input))
        return AIMessage(content=entry["content"], tool_calls=list(entry.get("tool_calls") or []))


class RecordingChatModel:
    """Calls the real model, persists its response keyed by the prompt, returns it."""

    def __init__(self, inner: ChatModel, cassette: Cassette, model_id: str) -> None:
        self._inner = inner
        self._cassette = cassette
        self._model_id = model_id
        # Stamp the cassette with the model being RECORDED. `Cassette.load` prefers the file's own
        # `model_id` over the one passed in, and `save` writes that value back — so without this
        # the label is STICKY: re-record a pair on a new model and the file still claims the old
        # one, for ever, while its entries are keyed to the new one. The entries stay correct
        # (ReplayChatModel keys on the live spec), so nothing breaks — which is exactly what makes
        # it dangerous. Feature 075 hit it: a grep of the cassettes reported
        # `claude-sonnet-4-6` for files that had just been re-recorded on `claude-sonnet-5`.
        cassette.model_id = model_id

    def invoke(self, model_input: Any, *args: Any, **kwargs: Any) -> Any:
        result = self._inner.invoke(model_input, *args, **kwargs)
        # The TEXT, not `str(content)`. A thinking-enabled model (Sonnet 5, Opus 5) returns a LIST
        # of content blocks, and stringifying it records a 478-char blob like
        # "[{'type':'thinking',...}, {'type':'text','text':'query'}]" — which then replays as an
        # intent that matches no label, or as JSON that will not parse — the cassette would
        # faithfully preserve a value the graph can never use. `.text` concatenates the text
        # blocks only; where content is already a plain string this is byte-identical to before,
        # so existing cassettes stay valid. See `response_text` in src/models.py.
        from src.models import response_text

        content = response_text(result)
        tool_calls = list(getattr(result, "tool_calls", []) or [])
        self._cassette.put(
            cassette_key(self._model_id, model_input),
            {"content": str(content), "tool_calls": tool_calls},
        )
        self._cassette.save()
        return result
