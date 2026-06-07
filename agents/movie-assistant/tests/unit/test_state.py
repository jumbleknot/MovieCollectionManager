"""Unit tests for the GraphState no-token invariant (T015 / SC-004 / FR-016).

The checkpointed graph state MUST NEVER carry a subject/exchanged token or raw JWT.
`forbid_token_fields` is the guard that enforces this before any state is persisted.
"""

import pytest

from src.state import forbid_token_fields


def test_clean_state_is_allowed():
    forbid_token_fields({"thread_id": "t1", "messages": [], "status": "active"})


@pytest.mark.parametrize(
    "bad_key",
    [
        "subject_token",
        "access_token",
        "exchanged_token",
        "jwt",
        "authorization",
        "bearer_token",
    ],
)
def test_token_bearing_field_is_rejected(bad_key):
    with pytest.raises(ValueError) as exc:
        forbid_token_fields({"thread_id": "t1", bad_key: "secret-value"})
    # The offending key must be named for debuggability; the secret value must never leak.
    assert bad_key in str(exc.value)
    assert "secret-value" not in str(exc.value)


def test_user_and_thread_identity_are_allowed():
    forbid_token_fields({"user_id": "kc-uuid", "thread_id": "t1"})
