"""Subject-token bridge: ContextVar → LangGraph `config["configurable"]` (gateway cut-over).

The BFF supplies the run-scoped subject token as `Authorization: Bearer` on each AG-UI request;
`runtime_context.SubjectTokenMiddleware` captures it into a request-local ContextVar. The graph's
real nodes (organizer / approval_gate) need it in `config["configurable"]` — task-safe and never
checkpointed (SC-004) — because a ContextVar set at the ASGI boundary does NOT reliably propagate
into LangGraph's per-node executor tasks deep in the graph.

`IdentityAwareAGUIAgent` overrides `prepare_stream` (which runs in the request task, where the
ContextVar IS visible) to inject the token + user_id into `config["configurable"]` BEFORE the
graph stream is built — bridging the boundary value into the explicit per-run channel. No token
(tool-free graph / no BFF token) → a no-op, so behaviour is unchanged (SC-005).
"""

from __future__ import annotations

import base64
import binascii
import json
import os
from collections.abc import Mapping
from typing import Any

from copilotkit import LangGraphAGUIAgent

from src.runtime_context import get_import_file, get_subject_token, get_ui_snapshot


def subject_user_id(token: str) -> str:
    """Decode the `sub` claim from a JWT for the cache/OPA key. No signature check (provenance
    only — the token is validated downstream by mc-service); empty string on any decode failure.
    """
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        claims = json.loads(base64.urlsafe_b64decode(payload))
        return str(claims.get("sub", ""))
    except (IndexError, ValueError, binascii.Error):
        return ""


def inject_subject_identity(config: dict[str, Any], token: str | None) -> None:
    """Mutate `config["configurable"]` with the run-scoped subject token + user_id.

    No-op when there is no token (preserves the tool-free graph's behaviour). Existing
    `configurable` keys (e.g. thread_id) are preserved.
    """
    if not token:
        return
    configurable = config.setdefault("configurable", {})
    configurable["subject_token"] = token
    configurable["user_id"] = subject_user_id(token)


def inject_ui_snapshot(config: dict[str, Any], snapshot: dict[str, Any] | None) -> None:
    """Mutate `config["configurable"]` with the sanitized UI snapshot (US3/R15).

    No-op when there is no snapshot (preserves behaviour when the client pushed none — the
    organizer then can't resolve "this" and clarifies). Existing keys are preserved.
    """
    if not snapshot:
        return
    config.setdefault("configurable", {})["ui_snapshot"] = snapshot


def inject_import_file(config: dict[str, Any], import_file: dict[str, Any] | None) -> None:
    """Mutate `config["configurable"]` with the import-file reference (014 US2).

    Sets `file_handle` (+ `filename` when present) from the BFF-supplied `{handle, filename}`.
    No-op when there is no reference (a non-import turn), so existing behaviour is unchanged.
    The handle is an opaque transient-store key — never file bytes, never a credential.
    """
    if not import_file:
        return
    handle = str(import_file.get("handle") or "").strip()
    if not handle:
        return
    configurable = config.setdefault("configurable", {})
    configurable["file_handle"] = handle
    filename = str(import_file.get("filename") or "").strip()
    if filename:
        configurable["filename"] = filename


def inject_observability(config: dict[str, Any], env: Mapping[str, str]) -> None:
    """Attach the LangFuse trace callback + per-turn budget metadata to the run config (T030).

    No-op when LangFuse is not configured (default dev/test/E2E → SC-005 additive). The handler
    makes each turn a LangFuse trace (model/tokens/cost + latency); the budgets ride as trace
    metadata so a breach is visible/queryable (SC-008). `user_id`/`thread_id` from the run's
    `configurable` become the LangFuse user/session for per-conversation cost roll-up.
    """
    from src.observability import build_langfuse_handler, langfuse_run_metadata, load_budgets

    handler = build_langfuse_handler(env)
    if handler is None:
        return
    configurable = config.get("configurable", {})
    metadata = langfuse_run_metadata(
        load_budgets(env),
        user_id=str(configurable.get("user_id") or "") or None,
        session_id=str(configurable.get("thread_id") or "") or None,
        tags=["movie-assistant"],
    )
    config.setdefault("metadata", {}).update(metadata)
    existing = config.get("callbacks")
    if existing is None:
        config["callbacks"] = [handler]
    elif isinstance(existing, list):
        existing.append(handler)
    else:  # a BaseCallbackManager
        try:
            existing.add_handler(handler, inherit=True)
        except Exception:  # noqa: BLE001 — never let tracing wiring break a run
            config["callbacks"] = [handler]


class IdentityAwareAGUIAgent(LangGraphAGUIAgent):
    """AG-UI agent that bridges the per-request subject token into `config["configurable"]`.

    `clone()` (called per request by the endpoint) re-creates via `type(self)(...)`, so the
    subclass is preserved; no new __init__ params are added.
    """

    async def prepare_stream(self, *, input: Any, agent_state: Any, config: Any) -> Any:  # noqa: A002
        inject_subject_identity(config, get_subject_token())
        inject_ui_snapshot(config, get_ui_snapshot())
        inject_import_file(config, get_import_file())
        inject_observability(config, os.environ)
        return await super().prepare_stream(input=input, agent_state=agent_state, config=config)
