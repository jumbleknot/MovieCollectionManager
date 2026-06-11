"""Subject-token bridge helpers (gateway cut-over, US1 Slice G).

`inject_subject_identity` is the ContextVar→`config["configurable"]` bridge the gateway applies
per request (in the request task, where the captured token is reliably in-context) so the graph
nodes receive the run-scoped subject token + user_id task-safely — never checkpointed (SC-004).
These pure helpers are unit-tested here; the live ASGI bridge is exercised by the gateway
integration test.
"""

from __future__ import annotations

import base64
import json

from src.agui_identity import inject_subject_identity, inject_ui_snapshot, subject_user_id


def _jwt(claims: dict[str, object]) -> str:
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).rstrip(b"=").decode()
    return f"header.{payload}.signature"


def test_subject_user_id_decodes_the_sub_claim() -> None:
    assert subject_user_id(_jwt({"sub": "user-42", "aud": "mc-service"})) == "user-42"


def test_subject_user_id_is_empty_on_a_non_jwt() -> None:
    assert subject_user_id("not-a-jwt") == ""
    assert subject_user_id("") == ""


def test_inject_sets_subject_token_and_user_id() -> None:
    token = _jwt({"sub": "user-7"})
    config: dict[str, object] = {"configurable": {"thread_id": "t1"}}
    inject_subject_identity(config, token)
    configurable = config["configurable"]
    assert isinstance(configurable, dict)
    assert configurable["subject_token"] == token
    assert configurable["user_id"] == "user-7"
    assert configurable["thread_id"] == "t1"  # preserves existing keys


def test_inject_creates_configurable_when_absent() -> None:
    token = _jwt({"sub": "u"})
    config: dict[str, object] = {}
    inject_subject_identity(config, token)
    assert config["configurable"]["subject_token"] == token  # type: ignore[index]


def test_inject_is_a_noop_without_a_token() -> None:
    config: dict[str, object] = {"configurable": {"thread_id": "t1"}}
    inject_subject_identity(config, None)
    assert "subject_token" not in config["configurable"]  # type: ignore[operator]
    inject_subject_identity(config, "")
    assert "subject_token" not in config["configurable"]  # type: ignore[operator]


# ── US3 (R15): UI-snapshot bridge into config["configurable"] ────────────────────────────────


def test_inject_ui_snapshot_sets_snapshot() -> None:
    snapshot = {"current_screen": "collection", "collection_id": "abc"}
    config: dict[str, object] = {"configurable": {"thread_id": "t1"}}
    inject_ui_snapshot(config, snapshot)
    configurable = config["configurable"]
    assert isinstance(configurable, dict)
    assert configurable["ui_snapshot"] == snapshot
    assert configurable["thread_id"] == "t1"  # preserves existing keys


def test_inject_ui_snapshot_creates_configurable_when_absent() -> None:
    config: dict[str, object] = {}
    inject_ui_snapshot(config, {"current_screen": "home"})
    assert config["configurable"]["ui_snapshot"] == {"current_screen": "home"}  # type: ignore[index]


def test_inject_ui_snapshot_is_a_noop_without_a_snapshot() -> None:
    config: dict[str, object] = {"configurable": {"thread_id": "t1"}}
    inject_ui_snapshot(config, None)
    assert "ui_snapshot" not in config["configurable"]  # type: ignore[operator]
