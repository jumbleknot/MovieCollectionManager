"""State-Layer: typed graph state + checkpoint contract.

Implements: T015. Schema source of truth: specs/012-multi-agent-mvp/data-model.md (GraphState).
INVARIANT (SC-004 / FR-016): no subject/exchanged token or raw JWT may ever be a
checkpointed field; identity is carried only as non-sensitive user_id / thread_id.
The subject token arrives as an ephemeral run value per invocation/resume and is
never written into state.

`forbid_token_fields` is the guard enforcing that invariant before any state is persisted.
The typed GraphState (TypedDict + langgraph reducers) is added with the graph wiring (T020).
"""

from collections.abc import Mapping

# Substrings (case-insensitive) that mark a field as carrying a secret/credential.
_FORBIDDEN_KEY_MARKERS = (
    "token",
    "jwt",
    "authorization",
    "bearer",
    "secret",
    "password",
    "credential",
    # 018 US2: the per-user agent config + its decrypted provider/TMDB keys are secrets too.
    "api_key",
    "apikey",
    "agent_config",
)


def forbid_token_fields(state: Mapping[str, object]) -> None:
    """Raise ValueError if any top-level state key looks like it carries a token/secret.

    Names the offending key (for debuggability) but never includes its value (SC-004).
    """
    for key in state:
        lowered = key.lower()
        if any(marker in lowered for marker in _FORBIDDEN_KEY_MARKERS):
            raise ValueError(
                f"checkpointed state must not carry credential field {key!r} "
                f"(SC-004: no raw token/JWT in agent state)"
            )
