"""Unit tests for render_movie_card props (013 US3 / T028).

A movie card built for an in-collection movie carries movieId + collectionId so the client can
deep-link to its detail screen; a look-up-only (TMDB preview) card omits them (null), so the
client renders it non-interactive.
"""

from __future__ import annotations

from src.proposals import EnrichedMovieCandidate
from src.tools.generative_ui_tools import (
    RENDER_MULTI_SELECT,
    render_movie_card,
    render_multi_select,
)


def _candidate() -> EnrichedMovieCandidate:
    return EnrichedMovieCandidate(
        sourceId="tmdb:603",
        title="The Matrix",
        year=1999,
        overview="A hacker learns the truth.",
        genres=["Action", "Sci-Fi"],
        posterUrl="https://image.tmdb.org/p.jpg",
    )


def test_in_collection_card_carries_movie_and_collection_ids() -> None:
    props = render_movie_card(
        _candidate(),
        movie_id="607f191e810c19729de860ea",
        collection_id="507f1f77bcf86cd799439011",
    )
    assert props["movieId"] == "607f191e810c19729de860ea"
    assert props["collectionId"] == "507f1f77bcf86cd799439011"
    assert props["title"] == "The Matrix"


def test_lookup_only_card_omits_ids() -> None:
    props = render_movie_card(_candidate())
    assert props["movieId"] is None
    assert props["collectionId"] is None


# ── 047 US4 (T069): render_multi_select props ───────────────────────────────────────────────
#
# The multi-valued counterpart to render_selection: the organizer emits it when it needs a set
# of answers (media formats, rip qualities) rather than one. Asserted against
# contracts/render-multi-select.md, not against the implementation.


def test_multi_select_props_match_the_contract_shape() -> None:
    props = render_multi_select(
        prompt="Which formats do you own it on?",
        options=[
            {"label": "DVD", "value": "DVD"},
            {"label": "Blu-Ray", "value": "Blu-Ray"},
        ],
    )
    assert props == {
        "prompt": "Which formats do you own it on?",
        "options": [
            {"label": "DVD", "value": "DVD", "selected": False},
            {"label": "Blu-Ray", "value": "Blu-Ray", "selected": False},
        ],
        "confirmLabel": "Done",
    }


def test_multi_select_selected_defaults_false_and_is_preserved_when_given() -> None:
    """A re-ask can show what was already chosen (contract: `selected` is the initial state)."""
    props = render_multi_select(
        prompt="Which formats?",
        options=[
            {"label": "DVD", "value": "DVD", "selected": True},
            {"label": "Blu-Ray", "value": "Blu-Ray"},
        ],
    )
    assert [o["selected"] for o in props["options"]] == [True, False]


def test_multi_select_confirm_label_is_overridable() -> None:
    props = render_multi_select(
        prompt="Which qualities?",
        options=[{"label": "DVD", "value": "DVD"}],
        confirm_label="Save",
    )
    assert props["confirmLabel"] == "Save"


def test_multi_select_falls_back_to_the_label_when_no_value_is_given() -> None:
    props = render_multi_select(prompt="?", options=[{"label": "DVD"}])
    assert props["options"][0]["value"] == "DVD"


def test_multi_select_carries_no_token_or_pii() -> None:
    """Pure props only — the 012 generative-UI contract forbids anything else."""
    props = render_multi_select(prompt="Which formats?", options=[{"label": "DVD"}])
    assert set(props.keys()) == {"prompt", "options", "confirmLabel"}
    for option in props["options"]:
        assert set(option.keys()) == {"label", "value", "selected"}


def test_multi_select_tool_name_is_stable() -> None:
    assert RENDER_MULTI_SELECT == "render_multi_select"


def test_multi_select_coerces_values_to_strings() -> None:
    """Option values are posted back as message text, so they must be text."""
    props = render_multi_select(prompt="?", options=[{"label": 1, "value": 2, "selected": "yes"}])
    assert props["options"][0] == {"label": "1", "value": "2", "selected": True}
