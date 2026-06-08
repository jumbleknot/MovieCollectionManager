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
from typing import Any

from copilotkit import LangGraphAGUIAgent

from src.runtime_context import get_subject_token, get_ui_snapshot


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


class IdentityAwareAGUIAgent(LangGraphAGUIAgent):
    """AG-UI agent that bridges the per-request subject token into `config["configurable"]`.

    `clone()` (called per request by the endpoint) re-creates via `type(self)(...)`, so the
    subclass is preserved; no new __init__ params are added.
    """

    async def prepare_stream(self, *, input: Any, agent_state: Any, config: Any) -> Any:  # noqa: A002
        inject_subject_identity(config, get_subject_token())
        inject_ui_snapshot(config, get_ui_snapshot())
        return await super().prepare_stream(input=input, agent_state=agent_state, config=config)
