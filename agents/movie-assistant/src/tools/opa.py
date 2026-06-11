"""OPA authorization for the gateway token exchange (T024).

Before the gateway re-exchanges the subject token, OPA answers "may this agent act for
this user against this audience?" (research R3, constitution §Agent Security). OPA receives
only NON-SENSITIVE identity (`user_id`, `audience`, `agent_origin`) — never a token.

CONFIG-GATED: when `OPA_URL` is unset (OPA not yet deployed) the check is skipped (allow)
with a warning, so local dev / the MVP is not blocked. When `OPA_URL` IS set the decision
is enforced and FAILS CLOSED — any deny, non-2xx, malformed response, or unreachable OPA
denies the exchange (a down policy engine must never silently permit agent calls).
"""

from __future__ import annotations

import logging
import os
from collections.abc import Mapping

import httpx

logger = logging.getLogger(__name__)

# OPA data-API path for the agent token-exchange decision (package mcm.agent_token_exchange).
_DECISION_PATH = "/v1/data/mcm/agent_token_exchange/allow"


def is_opa_configured(env: Mapping[str, str] | None = None) -> bool:
    """Whether OPA enforcement is active (an `OPA_URL` is configured)."""
    e = os.environ if env is None else env
    return bool(e.get("OPA_URL", "").strip())


async def authorize_exchange(
    user_id: str,
    audience: str,
    *,
    env: Mapping[str, str] | None = None,
    client: httpx.AsyncClient | None = None,
) -> bool:
    """Ask OPA whether this agent may exchange for `audience` on behalf of `user_id`.

    Returns True when OPA permits OR when OPA is not configured (gated skip). Returns False
    (fail closed) when OPA is configured and denies, errors, is unreachable, or returns a
    malformed decision.
    """
    e = os.environ if env is None else env
    opa_url = e.get("OPA_URL", "").strip()
    if not opa_url:
        logger.warning("OPA_URL unset — skipping agent token-exchange authorization (allow)")
        return True

    decision_url = f"{opa_url.rstrip('/')}{_DECISION_PATH}"
    payload = {"input": {"user_id": user_id, "audience": audience, "agent_origin": True}}

    owns_client = client is None
    http = client or httpx.AsyncClient(timeout=5.0)
    try:
        resp = await http.post(decision_url, json=payload)
    except httpx.HTTPError as exc:
        logger.error("OPA authorization request failed (%s) — denying", type(exc).__name__)
        return False
    finally:
        if owns_client:
            await http.aclose()

    if resp.status_code // 100 != 2:
        logger.error("OPA returned status %s — denying", resp.status_code)
        return False

    try:
        decision = resp.json().get("result")
    except (ValueError, AttributeError):
        logger.error("OPA returned a malformed decision — denying")
        return False

    return decision is True
