"""Unit tests for the UI-action tools (T059).

The UI-action tools are PURE instruction builders (no I/O, no token) that a node emits as
AG-UI tool calls. The client dispatches only allowlisted action names; `prefill_add_movie`
(which touches unsaved form state) is HITL-surfaced. Contract:
specs/012-multi-agent-mvp/contracts/generative-ui-and-actions.md.
"""

from __future__ import annotations

from src.tools.ui_action_tools import (
    NAVIGATE_TO_COLLECTION,
    NAVIGATE_TO_MOVIE,
    PREFILL_ADD_MOVIE,
    UI_ACTION_TOOLS,
    is_ui_action,
    navigate_to_collection,
    navigate_to_movie,
    prefill_add_movie,
    requires_hitl,
)


class TestBuilders:
    def test_navigate_to_collection_shape(self) -> None:
        assert navigate_to_collection("507f1f77bcf86cd799439011") == {
            "collectionId": "507f1f77bcf86cd799439011"
        }

    def test_navigate_to_movie_shape(self) -> None:
        assert navigate_to_movie("507f1f77bcf86cd799439011", "507f191e810c19729de860ea") == {
            "collectionId": "507f1f77bcf86cd799439011",
            "movieId": "507f191e810c19729de860ea",
        }

    def test_prefill_add_movie_carries_collection_and_draft(self) -> None:
        draft = {"title": "Inception", "year": 2010}
        out = prefill_add_movie("507f1f77bcf86cd799439011", draft)
        assert out["collectionId"] == "507f1f77bcf86cd799439011"
        assert out["movie"] == draft

    def test_prefill_add_movie_defaults_empty_draft(self) -> None:
        out = prefill_add_movie("507f1f77bcf86cd799439011", None)
        assert out["collectionId"] == "507f1f77bcf86cd799439011"
        assert out["movie"] == {}

    def test_builders_carry_no_token_or_extra_keys(self) -> None:
        # Defensive: the client/BFF allowlist sanitization expects exactly the contract keys.
        assert set(navigate_to_collection("x")) == {"collectionId"}
        assert set(navigate_to_movie("x", "y")) == {"collectionId", "movieId"}
        assert set(prefill_add_movie("x", {"title": "T"})) == {"collectionId", "movie"}


class TestAllowlist:
    def test_allowlist_is_exactly_the_three_contract_tools(self) -> None:
        assert UI_ACTION_TOOLS == frozenset(
            {NAVIGATE_TO_COLLECTION, NAVIGATE_TO_MOVIE, PREFILL_ADD_MOVIE}
        )

    def test_is_ui_action_true_for_allowlisted(self) -> None:
        assert is_ui_action(NAVIGATE_TO_COLLECTION)
        assert is_ui_action(NAVIGATE_TO_MOVIE)
        assert is_ui_action(PREFILL_ADD_MOVIE)

    def test_is_ui_action_false_for_unknown_or_render(self) -> None:
        assert not is_ui_action("render_movie_card")
        assert not is_ui_action("delete_everything")
        assert not is_ui_action("")


class TestHitl:
    def test_prefill_requires_hitl(self) -> None:
        # Prefilling unsaved form state is HITL-surfaced (contract/constitution).
        assert requires_hitl(PREFILL_ADD_MOVIE) is True

    def test_navigation_does_not_require_hitl(self) -> None:
        # Navigation reads no unsaved state and writes nothing — no HITL gate.
        assert requires_hitl(NAVIGATE_TO_COLLECTION) is False
        assert requires_hitl(NAVIGATE_TO_MOVIE) is False
