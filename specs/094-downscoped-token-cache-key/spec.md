# Spec 094: The downscoped-token cache is keyed by the token presented, not by an unverified claim

**Status**: Complete | **Date**: 2026-11-08 | **Input**: implementation review, 2026-11-08 (security step)

## Problem

`acquire_downscoped_token` (agents/movie-assistant/src/tools/identity.py) caches the mc-service token it
mints per `(user_id, audience)`. `user_id` is the subject token's `sub` claim, decoded **without a
signature check** (`agui_identity.subject_user_id`, which says so in its docstring). A cache hit returns
before OPA and before the Keycloak re-exchange, so for that path nothing validates the presented token.

So any caller that can reach the gateway with an `Authorization: Bearer` JWT whose `sub` is another user's
id is served that user's cached token for up to ~45 s after the victim's last tool call, and the turn's
tools run against mc-service as the victim. The gateway publishes no host port, so the attacker needs a
foothold on an internal Docker network. That makes it defence in depth, not an external bypass. But the
cache is the one place where an unverified claim decides whose credential is used.

## Requirements

- **FR-001**: A cached downscoped token MUST be returned only for the same subject token that minted it.
  A different subject token with the same `sub` MUST miss the cache, then go through OPA and the
  re-exchange, where Keycloak validates it.
- **FR-002**: The cache MUST NOT hold the subject token itself. It is keyed by a SHA-256 digest of it.
- **FR-003**: Repeated tool calls on the same subject token within the TTL MUST still reuse one exchange,
  which is the cache's reason to exist.
- **FR-004**: Expired entries MUST be pruned when a new entry is stored. Keying per token creates more keys
  than keying per user, so dropping entries only on read would let the map grow with every run.

## Success criteria

- **SC-001**: A forged token with a victim's `sub` does not get the victim's cached token (unit test).
- **SC-002**: The existing cache, skew and denial tests pass unchanged.

## Out of scope

- Verifying the subject token's signature in the gateway. Keycloak does that on the exchange, and every
  other path already reaches it.
- The other review notes (Ollama redirects, `agent/stop` thread ownership, NAT64), which were assessed
  below the confidence bar. They are recorded in the 2026-11-08 implementation review.
