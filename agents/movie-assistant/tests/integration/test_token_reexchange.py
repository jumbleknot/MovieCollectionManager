"""T024 — gateway RFC 8693 re-exchange against REAL Keycloak.

Verifies `reexchange_for_mc_service` end-to-end against a live Keycloak with the T012 script
applied: the agent-gateway client re-exchanges a subject token (aud⊇agent-gateway) into the
downscoped token mc-service receives. Asserts the user-approved shape — aud carries BOTH
`movie-collection-manager` (so the UNCHANGED mc-service accepts it) and `mc-service` (R3's
binding signal), plus `agent_origin=true` and a TTL within the ≤60 s ceiling.

Skips cleanly without the live stack / T012 (see conftest). Real dependency, never cassetted.
"""

from __future__ import annotations

import base64
import json

from src.tools.token_exchange import (
    EXCHANGED_TOKEN_MAX_TTL_SECONDS,
    reexchange_for_mc_service,
)


def _claims(jwt: str) -> dict[str, object]:
    payload = jwt.split(".")[1]
    payload += "=" * (-len(payload) % 4)  # restore base64 padding
    return json.loads(base64.urlsafe_b64decode(payload))


async def test_reexchanges_to_dual_audience_with_agent_origin_and_bounded_ttl(
    subject_token: str, reexchange_env: dict[str, str]
) -> None:
    result = await reexchange_for_mc_service(subject_token, env=reexchange_env)

    assert result.token.count(".") == 2  # a JWS
    claims = _claims(result.token)

    aud = claims.get("aud")
    aud_list = aud if isinstance(aud, list) else [aud]
    # Unchanged mc-service validates this audience via non-empty intersection ...
    assert "movie-collection-manager" in aud_list
    # ... and mc-service is kept as research R3's distinct binding signal.
    assert "mc-service" in aud_list

    # Agent-origin marker re-stamped by the agent-gateway client (for mc-service/OPA policy).
    assert claims.get("agent_origin") is True

    # Run-segment TTL: Keycloak lifespan and our defensive cap both bound it to ≤60 s.
    assert 0 < result.expires_in <= EXCHANGED_TOKEN_MAX_TTL_SECONDS
    assert int(claims["exp"]) - int(claims["iat"]) <= EXCHANGED_TOKEN_MAX_TTL_SECONDS
