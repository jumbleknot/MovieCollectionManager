"""No checkpoint holds the caller's bearer token (spec 102 US1, item #973).

LangGraph's `get_checkpoint_metadata` copies every str/int/float/bool value of
`config["configurable"]` into the metadata of EVERY checkpoint, unless the key starts with `__` or
is in `EXCLUDED_METADATA_KEYS`. A token injected under a plain key was therefore written into every
checkpoint of the thread. Measured before this fix: 3 of 3 checkpoints held it verbatim.

This drives the REAL runtime graph (organizer + approval gate, fake MCP transport) through a real
checkpointer, from the first turn to an approved HITL resume. The run config is built by the same
`inject_*` helpers `IdentityAwareAGUIAgent.prepare_stream` uses. A second, different subject token
is used for the resume, as the BFF mints a fresh one per request, so the test also proves that the
resume path reaches the token exchange with the new token.
"""

from __future__ import annotations

from typing import Any

from langgraph.checkpoint.memory import InMemorySaver
from langgraph.types import Command

from src.agui_identity import (
    FILE_HANDLE_KEY,
    SUBJECT_TOKEN_KEY,
    inject_agent_config,
    inject_import_file,
    inject_subject_identity,
    inject_ui_snapshot,
)
from src.runtime_nodes import RuntimeNodeConfig, build_runtime_graph
from src.tools.agent_rate_limit import AgentToolRateLimiter
from src.tools.identity import DownscopedTokenCache
from src.tools.token_exchange import ExchangedToken
from tests.unit.test_runtime_nodes import _answer_ownership_chain, _Recorder

# Unsigned JWT-shaped tokens. `sub` gives `subject_user_id` something to decode.
_RUN_TOKEN = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1c2VyLTEifQ.run-token-SECRET-a"
_RESUME_TOKEN = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1c2VyLTEifQ.resume-token-SECRET-b"
_PROVIDER_KEY = "sk-provider-key-SECRET-c"
_FILE_HANDLE = "import-handle-SECRET-d"
_SECRETS = (_RUN_TOKEN, _RESUME_TOKEN, _PROVIDER_KEY, _FILE_HANDLE)


def _node_config(rec: _Recorder, exchanged: list[str]) -> RuntimeNodeConfig:
    async def authorize(_user: str, _aud: str) -> bool:
        return True

    async def exchange(subject: str) -> ExchangedToken:
        exchanged.append(subject)
        return ExchangedToken(token="downscoped-mc-token", expires_in=60)

    return RuntimeNodeConfig(
        web_api_mcp_url="http://web-api-mcp/mcp",
        movie_mcp_url="http://movie-mcp/mcp",
        limiter=AgentToolRateLimiter(max_calls=100, window_seconds=60),
        cache=DownscopedTokenCache(),
        authorize=authorize,
        exchange=exchange,
        call=rec,
        extract=lambda _m: {"title": "The Matrix", "year": 1999, "collection": "Sci-Fi"},
    )


def _run_config(thread: str, token: str) -> dict[str, Any]:
    """The run config, assembled exactly as `IdentityAwareAGUIAgent.prepare_stream` assembles it."""
    config: dict[str, Any] = {"configurable": {"thread_id": thread}}
    inject_subject_identity(config, token)
    inject_ui_snapshot(config, {"route": "collections", "collectionId": "c1"})
    inject_import_file(config, {"handle": _FILE_HANDLE, "filename": "movies.xlsx"})
    inject_agent_config(config, {"provider": "anthropic", "providerKey": _PROVIDER_KEY})
    return config


def _stored(saver: InMemorySaver) -> str:
    """Everything the saver holds, as one string: checkpoints, metadata, writes and blobs."""
    return repr(saver.storage) + repr(saver.writes) + repr(saver.blobs)


async def test_no_checkpoint_holds_the_subject_token_through_run_and_resume() -> None:
    saver = InMemorySaver()
    rec = _Recorder()
    exchanged: list[str] = []
    graph = build_runtime_graph(
        {},
        config=_node_config(rec, exchanged),
        classifier=lambda _m: "add",
        checkpointer=saver,
        force=True,
    )

    run_cfg = _run_config("token-absence", _RUN_TOKEN)
    await graph.ainvoke(
        {"messages": [("user", "add The Matrix to Sci-Fi")], "target_collection_name": "Sci-Fi"},
        run_cfg,
    )
    paused = await _answer_ownership_chain(graph, run_cfg)
    assert "__interrupt__" in paused  # the run reached the HITL gate

    final = await graph.ainvoke(
        Command(resume={"decision": "approved"}), _run_config("token-absence", _RESUME_TOKEN)
    )
    assert final["status"] == "completed"

    # US1-AC2: the token reached the exchange on the run AND on the resume.
    assert _RUN_TOKEN in exchanged
    assert _RESUME_TOKEN in exchanged
    assert [name for (name, _a, _t) in rec.calls].count("add_movie") == 1

    # US1-AC1: no secret anywhere in what the checkpointer holds.
    checkpoints = list(saver.list(None))
    assert len(checkpoints) > 3  # several turns were checkpointed, so absence is meaningful
    stored = _stored(saver)
    leaked = [s for s in _SECRETS if s in stored]
    assert leaked == [], f"secret(s) found in the checkpoint store: {leaked}"
    for tup in checkpoints:
        assert SUBJECT_TOKEN_KEY not in tup.metadata
        assert FILE_HANDLE_KEY not in tup.metadata
        assert "subject_token" not in tup.metadata
        assert "file_handle" not in tup.metadata
        # Decided in spec 102: `user_id` (the opaque `sub`) is kept, as the owner reference.
        assert tup.metadata.get("user_id") == "user-1"
