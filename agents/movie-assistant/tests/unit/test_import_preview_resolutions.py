"""T051/T053/T055: build_import_preview honours resolved disambiguations (US4).

After the user taps a button, the recorded choice (collection target / column attribute / title
article) must be APPLIED when the preview is (re)built — and never re-asked. Pure: drives
`build_import_preview` with a `resolutions` dict directly (no graph, no IO).

Covers: US4-AC1/2/3, FR-010/012/015.
"""

from __future__ import annotations

from typing import Any

from src.nodes.import_collection import build_import_preview

_FAV = [{"collectionId": "c1", "name": "Favourites"}]


def _tab(name: str, columns: list[dict], rows: list[dict]) -> dict:
    return {"name": name, "eligible": True, "columns": columns, "rows": rows}


def _preview(tab: dict, collections: list[dict], resolutions: dict[str, Any]) -> Any:
    return build_import_preview(
        tabs=[tab],
        collections=collections,
        existing_by_collection={},
        thread_id="t",
        resolutions=resolutions,
    )


_BASE_COLS = [{"header": "Title"}, {"header": "Year"}, {"header": "Video Type"}]


# ---------------------------------------------------------------------------
# T051: collection target resolution
# ---------------------------------------------------------------------------


def test_resolved_collection_plans_rows_into_the_chosen_collection() -> None:
    tab = _tab("My Movies", _BASE_COLS, [{"Title": "Dune", "Year": "2021", "Video Type": "Movie"}])
    preview = _preview(tab, _FAV, {"collection": {"My Movies": "c1"}})
    plan = preview.tabs[0]
    assert plan.needs_collection_choice is False
    assert plan.target_collection_id == "c1"
    assert [item.title for item in plan.to_create] == ["Dune"]


def test_unresolved_collection_still_defers() -> None:
    tab = _tab("My Movies", _BASE_COLS, [{"Title": "Dune", "Year": "2021", "Video Type": "Movie"}])
    plan = _preview(tab, _FAV, {}).tabs[0]
    assert plan.needs_collection_choice is True
    assert plan.to_create == []


# ---------------------------------------------------------------------------
# T053: medium-confidence column resolution
# ---------------------------------------------------------------------------


def test_confirmed_column_is_applied_as_the_chosen_attribute() -> None:
    cols = _BASE_COLS + [{"header": "Rating", "sampleValues": ["PG-13", "great"]}]
    tab = _tab(
        "Favourites", cols,
        [{"Title": "Dune", "Year": "2021", "Video Type": "Movie", "Rating": "PG-13"}],
    )
    plan = _preview(tab, _FAV, {"column": {"Rating": "rated"}}).tabs[0]
    assert plan.to_create[0].payload["rated"] == "PG-13"


def test_unconfirmed_medium_column_is_not_applied() -> None:
    cols = _BASE_COLS + [{"header": "Rating", "sampleValues": ["PG-13", "great"]}]
    tab = _tab(
        "Favourites", cols,
        [{"Title": "Dune", "Year": "2021", "Video Type": "Movie", "Rating": "PG-13"}],
    )
    plan = _preview(tab, _FAV, {}).tabs[0]
    # The unconfirmed column's VALUE ("PG-13") must not be applied — `rated` is the null
    # create-default (a CreateMovieDto needs every optional scalar present, _CREATE_NULL_DEFAULTS),
    # never the column value.
    assert plan.to_create[0].payload.get("rated") is None


def test_ignored_column_is_dropped() -> None:
    cols = _BASE_COLS + [{"header": "Rating", "sampleValues": ["PG-13", "great"]}]
    tab = _tab(
        "Favourites", cols,
        [{"Title": "Dune", "Year": "2021", "Video Type": "Movie", "Rating": "PG-13"}],
    )
    plan = _preview(tab, _FAV, {"column": {"Rating": "__ignore__"}}).tabs[0]
    # The ignored column's VALUE ("PG-13") is dropped — `rated` is the null create-default, not it.
    assert plan.to_create[0].payload.get("rated") is None


# ---------------------------------------------------------------------------
# T055: article resolution
# ---------------------------------------------------------------------------


def test_article_reorder_choice_applied_to_title() -> None:
    tab = _tab(
        "Favourites", _BASE_COLS,
        [{"Title": "Goodbye, Lenin!", "Year": "2003", "Video Type": "Movie"}],
    )
    plan = _preview(tab, _FAV, {"article": {"Goodbye, Lenin!": "Lenin! Goodbye"}}).tabs[0]
    assert plan.to_create[0].payload["title"] == "Lenin! Goodbye"


def test_article_keep_choice_leaves_title_untouched() -> None:
    tab = _tab(
        "Favourites", _BASE_COLS,
        [{"Title": "Goodbye, Lenin!", "Year": "2003", "Video Type": "Movie"}],
    )
    plan = _preview(tab, _FAV, {"article": {"Goodbye, Lenin!": "Goodbye, Lenin!"}}).tabs[0]
    assert plan.to_create[0].payload["title"] == "Goodbye, Lenin!"


# ---------------------------------------------------------------------------
# 047 T027 (SC-004): an answered title is NEVER re-asked
#
# The loop the member hit was not a single bad title — it was that no answer was ever
# recorded, so every pass re-collected the same question. Ten distinct ambiguous titles
# exercise that at scale: after each is answered once, `collect_import_disambiguations`
# must return no article prompt at all, and every recorded choice must be APPLIED to the
# planned payload (a resolution that is remembered but not applied is the same defect
# wearing a different hat — see build_row_payload's article_overrides lookup, which keys
# on the trimmed title).
# ---------------------------------------------------------------------------

# Titles whose final comma-chunk is a single non-article word → uncertain, so each asks.
_TEN_AMBIGUOUS_TITLES: list[str] = [
    "Three Billboards Outside Ebbing, Missouri ",   # the reported case, trailing space
    "Goodbye, Lenin!",
    "Cinema Paradiso, Nuovo",
    "Amelie, Le",
    "Dolls, Chinese",
    "Gladiator, El",
    "Hero, Die",
    "Solaris, Il",
    "Vertigo, Los",
    "Persona, Det",
]


def _ten_title_tab() -> dict:
    return _tab(
        "Favourites",
        _BASE_COLS,
        [
            {"Title": title, "Year": str(1990 + i), "Video Type": "Movie"}
            for i, title in enumerate(_TEN_AMBIGUOUS_TITLES)
        ],
    )


def test_ten_ambiguous_titles_each_ask_exactly_once() -> None:
    """Every distinct ambiguous title raises exactly one question — no duplicates."""
    from src.nodes.import_disambiguation import collect_import_disambiguations

    prompts = collect_import_disambiguations([_ten_title_tab()], _FAV, {})
    article = [p for p in prompts if p.kind == "article"]
    assert len(article) == len(_TEN_AMBIGUOUS_TITLES)
    keys = [p.key for p in article]
    assert len(set(keys)) == len(keys), f"a title was asked more than once: {keys}"
    for key in keys:
        assert key == key.strip(), f"prompt key {key!r} carries whitespace"


def test_answered_titles_are_never_reasked() -> None:
    """SC-004: after each of the ten is answered once, nothing is asked again."""
    from src.nodes.import_disambiguation import (
        apply_import_pick,
        collect_import_disambiguations,
        resolve_import_pick,
    )

    tab = _ten_title_tab()
    resolutions: dict[str, Any] = {}
    asked: list[str] = []

    # Answer whatever is asked, one question per pass, always by taking the FIRST option
    # (the "keep" choice). The reply is `.strip()`ed because that is how an answer actually
    # arrives: a member typing the title back does not reproduce trailing whitespace, and
    # the dock posts a trimmed value. That asymmetry — a label carrying a trailing space
    # answered by a trimmed reply — IS the reported defect, so a test that echoed the raw
    # label verbatim would round-trip happily and prove nothing.
    # Bounded well above ten so a genuine loop fails loudly rather than hanging the suite.
    for _ in range(len(_TEN_AMBIGUOUS_TITLES) * 3):
        prompts = [
            p for p in collect_import_disambiguations([tab], _FAV, resolutions)
            if p.kind == "article"
        ]
        if not prompts:
            break
        prompt = prompts[0]
        asked.append(prompt.key)
        tapped = str(prompt.options[0]["title"]).strip()
        chosen = resolve_import_pick(tapped, prompt)
        assert chosen is not None, f"tapping {tapped!r} resolved nothing — the loop is live"
        resolutions = apply_import_pick(resolutions, prompt, chosen)

    assert len(asked) == len(_TEN_AMBIGUOUS_TITLES), (
        f"expected {len(_TEN_AMBIGUOUS_TITLES)} questions, got {len(asked)}: {asked}"
    )
    assert len(set(asked)) == len(asked), f"a title was re-asked: {asked}"
    assert not [
        p for p in collect_import_disambiguations([tab], _FAV, resolutions) if p.kind == "article"
    ]


def test_answered_titles_are_applied_to_the_planned_payload() -> None:
    """A recorded decision must reach the payload — remembering it is only half the fix."""
    from src.nodes.import_disambiguation import (
        apply_import_pick,
        collect_import_disambiguations,
        resolve_import_pick,
    )

    tab = _ten_title_tab()
    resolutions: dict[str, Any] = {}
    for _ in range(len(_TEN_AMBIGUOUS_TITLES) * 3):
        prompts = [
            p for p in collect_import_disambiguations([tab], _FAV, resolutions)
            if p.kind == "article"
        ]
        if not prompts:
            break
        prompt = prompts[0]
        # Trimmed, for the same reason as the test above — that is how a reply arrives.
        chosen = resolve_import_pick(str(prompt.options[0]["title"]).strip(), prompt)
        assert chosen is not None
        resolutions = apply_import_pick(resolutions, prompt, chosen)

    plan = _preview(tab, _FAV, resolutions).tabs[0]
    planned = {item.payload["title"] for item in plan.to_create}
    expected = {t.strip() for t in _TEN_AMBIGUOUS_TITLES}
    assert planned == expected, f"planned titles {planned!r} != chosen {expected!r}"
    for title in planned:
        assert title == title.strip(), f"planned title {title!r} carries whitespace"
