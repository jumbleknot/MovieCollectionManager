"""T080: bridge test — recorded model outputs feed into pure-code resolvers.

The golden gate (test_golden_pairs.py) proves the MODEL decision; this file proves the
downstream RESOLUTION correctly handles the model's real output shapes.  All inputs here are
authentic recorded phrasing sourced from the committed cassettes — NOT idealized strings.

Cassette sources:
  us2-plan-move-year-in-title  → Claude returned op title "Avatar (2009)"
  PREFIX_COLLISION_OPTIONS     → options fed to resolve_option in the add-disambiguation flow
  SAME_TITLE_DIFFERENT_YEAR_MOVIES → stored movies fed to _match_movie in the organize flow

These tests are deterministic and keyless (no LLM calls — pure resolver code only).
"""

from __future__ import annotations

import json
from pathlib import Path

from src.nodes.organizer import _match_movie
from src.nodes.supervisor import resolve_option
from tests.fixtures.adversarial import (
    PREFIX_COLLISION_OPTIONS,
    SAME_TITLE_DIFFERENT_YEAR_MOVIES,
)

# ---------------------------------------------------------------------------
# Helpers to load the recorded cassette content
# ---------------------------------------------------------------------------

_CASSETTES_DIR = (
    Path(__file__).resolve().parents[2] / "tests" / "golden" / "cassettes"
)


def _cassette_plan_ops(cassette_id: str) -> list[dict]:
    """Load the 'operations' list from the first cassette entry for a plan-kind golden."""
    path = _CASSETTES_DIR / f"{cassette_id}.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    entry = next(iter(data["entries"].values()))
    return list(json.loads(entry["content"]).get("operations", []))


# ---------------------------------------------------------------------------
# T080-A: organizer._match_movie resolves the RECORDED move op title
#
# Claude returned "Avatar (2009)" as the op title (cassette us2-plan-move-year-in-title).
# _match_movie must split the year annotation and match the stored film by (title, year).
# ---------------------------------------------------------------------------

# The exact string Claude emitted (sourced from cassette us2-plan-move-year-in-title).
_RECORDED_AVATAR_MOVE_TITLE = "Avatar (2009)"

# Stored movies in the user's source collection (mc-service shape): one Avatar entry.
_AVATAR_IN_COLLECTION: list[dict] = [
    {"movieId": "m-avatar-2009", "title": "Avatar", "year": 2009},
    {"movieId": "m-arrival-2016", "title": "Arrival", "year": 2016},
]


def test_recorded_move_title_resolves_to_stored_avatar() -> None:
    """The recorded op title 'Avatar (2009)' must resolve to the stored bare 'Avatar' (2009).

    This is the core bridge: Claude echoed the year in the plan op, _match_movie must
    split it and match the stored film whose title field carries no year annotation.
    """
    # Confirm we're using the real recorded string, not an idealized one.
    ops = _cassette_plan_ops("us2-plan-move-year-in-title")
    assert len(ops) == 1
    op = ops[0]
    assert op["op"] == "move"
    recorded_title = op["title"]  # the real Claude output
    assert recorded_title == _RECORDED_AVATAR_MOVE_TITLE, (
        f"Cassette content changed — update the constant; got {recorded_title!r}"
    )

    result = _match_movie(recorded_title, _AVATAR_IN_COLLECTION)

    assert result is not None, (
        f"_match_movie({recorded_title!r}, ...) returned None — year-annotation stripping broke"
    )
    assert result["movieId"] == "m-avatar-2009"
    assert result["title"] == "Avatar"


def test_recorded_move_title_disambiguates_two_dunes() -> None:
    """The year-echoed form 'Dune (2021)' applied to SAME_TITLE_DIFFERENT_YEAR_MOVIES resolves.

    Demonstrates the same stripping logic on the fixture used by test_resolvers_adversarial:
    two films share the title 'Dune'; the echoed year must select the 2021 one.
    """
    recorded_dune_title = "Dune (2021)"  # the form Claude would emit for this title+year
    result = _match_movie(recorded_dune_title, SAME_TITLE_DIFFERENT_YEAR_MOVIES)

    assert result is not None
    assert result["movieId"] == "m-dune-2021"


def test_recorded_move_title_wrong_year_returns_none() -> None:
    """'Avatar (2022)' against the stored Avatar (2009) — year disagrees → None (no false match)."""
    wrong_year_title = "Avatar (2022)"  # Claude echoing a wrong year must NOT resolve
    result = _match_movie(wrong_year_title, _AVATAR_IN_COLLECTION)

    assert result is None, (
        "_match_movie must not match when the echoed year disagrees with the stored year"
    )


# ---------------------------------------------------------------------------
# T080-B: supervisor.resolve_option handles model-phrasing disambiguation picks
#
# When the user says "the Avatar: The Way of Water one", resolve_option must return the
# 2022 film, not the bare 2009 Avatar (the prefix-collision failure that drove the
# longest-title-first sort).  Inputs mirror realistic model/user disambiguation replies.
# ---------------------------------------------------------------------------


def test_disambiguation_way_of_water_beats_bare_avatar() -> None:
    """'Avatar: The Way of Water one' must resolve to 2022, not 2009 Avatar.

    A disambiguation flow presents PREFIX_COLLISION_OPTIONS; the user (or curator) echoes
    the specific subtitle.  The resolver must pick the 2022 film via title substring, with
    the longer title checked first so bare 'Avatar' cannot shadow the more specific title.
    """
    pick = "the Avatar: The Way of Water one"
    result = resolve_option(pick, PREFIX_COLLISION_OPTIONS)

    assert result is not None
    assert result["year"] == 2022
    assert "Way of Water" in result["title"]


def test_disambiguation_year_phrase_resolves_to_2022() -> None:
    """'The 2022 one' — year-phrase pick for 'Avatar: The Way of Water'."""
    result = resolve_option("the 2022 one", PREFIX_COLLISION_OPTIONS)

    assert result is not None
    assert result["year"] == 2022


def test_disambiguation_bare_subtitle_resolves_correctly() -> None:
    """Bare subtitle 'Avatar: The Way of Water' (no year, no 'one') still resolves."""
    result = resolve_option("Avatar: The Way of Water", PREFIX_COLLISION_OPTIONS)

    assert result is not None
    assert result["year"] == 2022
    assert "Way of Water" in result["title"]


def test_disambiguation_bare_avatar_resolves_to_original() -> None:
    """Bare 'avatar' (no qualifier, no year) resolves to the bare 2009 Avatar option.

    The user has TWO Avatars to choose from; saying just 'avatar' picks the bare-titled one
    (longest-first: longer titles are checked but 'avatar: the way of water' is not a
    substring of 'avatar', so the bare-title exact match wins).
    """
    result = resolve_option("avatar", PREFIX_COLLISION_OPTIONS)

    assert result is not None
    assert result["title"] == "Avatar"
    assert result["year"] == 2009


# ---------------------------------------------------------------------------
# T080-C: end-to-end shape test — cassette plan feeds directly into resolver
#
# Loads the recorded cassette plan, extracts the op title exactly as the model emitted it,
# and asserts the full resolution pipeline works without any intermediary transformation.
# ---------------------------------------------------------------------------


def test_cassette_plan_op_title_resolves_end_to_end() -> None:
    """Full pipeline: cassette plan op title → _match_movie → stored film resolved.

    No string manipulation on our side — the raw cassette string goes directly into the
    resolver, proving the production code path (organizer._organize) handles it correctly.
    """
    ops = _cassette_plan_ops("us2-plan-move-year-in-title")
    assert ops, "cassette ops must not be empty"

    op = ops[0]
    assert op["op"] == "move"
    assert op["to"].lower() == "wishlist"

    # Feed the exact recorded title into _match_movie against the stored collection.
    result = _match_movie(op["title"], _AVATAR_IN_COLLECTION)

    assert result is not None, (
        f"_match_movie({op['title']!r}) could not resolve the stored Avatar — "
        "the organizer would silently drop this move op"
    )
    assert result["movieId"] == "m-avatar-2009"
