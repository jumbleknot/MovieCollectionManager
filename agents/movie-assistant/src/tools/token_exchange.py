"""Gateway-side RFC 8693 token re-exchange (T024).

At tool-call time the gateway exchanges the BFF-supplied run-scoped subject token for the
downscoped token mc-service receives. Requester = `agent-gateway` (confidential). No
`audience` request param is sent — the agent-gateway client's audience mappers stamp
aud=[movie-collection-manager, mc-service] so the UNCHANGED mc-service accepts the token
(it validates aud⊇'movie-collection-manager') while `mc-service` stays as research R3's
distinct binding signal. Sending no `audience` also sidesteps Keycloak's precondition-2
"Requested audience not available" check. The gateway-issued token's TTL is bounded to
<=60 s by the agent-gateway client's `access.token.lifespan`; this module also caps the
reported expiry defensively.

INVARIANT (SC-004): the subject and exchanged tokens are never logged or checkpointed.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Mapping
from typing import NamedTuple

import httpx

logger = logging.getLogger(__name__)

_GRANT_TYPE_TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange"
_TOKEN_TYPE_ACCESS = "urn:ietf:params:oauth:token-type:access_token"

# Hard ceiling for the exchanged (gateway-issued) token TTL (research R3: <=60 s).
EXCHANGED_TOKEN_MAX_TTL_SECONDS = 60


class TokenExchangeError(RuntimeError):
    """Raised when the gateway re-exchange is unconfigured or rejected by Keycloak.

    Carries no token material (SC-004) — only a non-sensitive reason/status.
    """


class ExchangedToken(NamedTuple):
    token: str
    expires_in: int


def _env(env: Mapping[str, str] | None) -> Mapping[str, str]:
    return os.environ if env is None else env


def is_reexchange_configured(env: Mapping[str, str] | None = None) -> bool:
    """Whether the gateway holds the confidential `agent-gateway` requester credentials."""
    e = _env(env)
    return bool(e.get("AGENT_GATEWAY_CLIENT_ID")) and bool(e.get("AGENT_GATEWAY_CLIENT_SECRET"))


async def reexchange_for_mc_service(
    subject_token: str,
    *,
    env: Mapping[str, str] | None = None,
    client: httpx.AsyncClient | None = None,
) -> ExchangedToken:
    """Re-exchange the run-scoped subject token for the downscoped mc-service token.

    :param subject_token: the BFF-minted run-scoped subject token (aud=agent-gateway).
    :param env: env source (defaults to os.environ) — injectable for tests.
    :param client: optional httpx client (injectable for tests); one is created if omitted.
    :raises TokenExchangeError: if unconfigured or Keycloak rejects the exchange.
    """
    e = _env(env)
    from src.secrets import resolve_secret

    client_id = e.get("AGENT_GATEWAY_CLIENT_ID", "")
    # Vault-injected in deployed environments, env (.env.local) in dev (T030a).
    client_secret = resolve_secret("AGENT_GATEWAY_CLIENT_SECRET", e) or ""
    if not client_id or not client_secret:
        raise TokenExchangeError("gateway re-exchange is not configured")

    kc_url = e.get("KEYCLOAK_URL", "http://localhost:8099")
    realm = e.get("KEYCLOAK_REALM", "grumpyrobot")
    token_url = f"{kc_url}/realms/{realm}/protocol/openid-connect/token"

    data = {
        "grant_type": _GRANT_TYPE_TOKEN_EXCHANGE,
        "client_id": client_id,
        "client_secret": client_secret,
        "subject_token": subject_token,
        "subject_token_type": _TOKEN_TYPE_ACCESS,
        "requested_token_type": _TOKEN_TYPE_ACCESS,
    }

    owns_client = client is None
    http = client or httpx.AsyncClient(timeout=10.0)
    try:
        resp = await http.post(token_url, data=data)
    finally:
        if owns_client:
            await http.aclose()

    if resp.status_code // 100 != 2:
        # Log status only — never the subject/exchanged token or response body (SC-004).
        logger.error("gateway token re-exchange failed: status=%s", resp.status_code)
        raise TokenExchangeError(f"token re-exchange rejected (status {resp.status_code})")

    payload = resp.json()
    reported = payload.get("expires_in", EXCHANGED_TOKEN_MAX_TTL_SECONDS)
    return ExchangedToken(
        token=payload["access_token"],
        expires_in=min(int(reported), EXCHANGED_TOKEN_MAX_TTL_SECONDS),
    )
