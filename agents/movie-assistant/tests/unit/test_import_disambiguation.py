"""T050/T052/T054: pure-code import disambiguation (US4, feature 014).

When the import node can't confidently resolve a tab→collection target (0 or >1 name match), a
medium-confidence column, or an uncertain trailing sorting word, it must PROMPT with buttons
rather than guess (SC-006/SC-007). Detection of what to ask, the button options offered, and the
resolution of a tapped button are all DETERMINISTIC pure code (no LLM → no golden re-record) —
the import intent is the only golden surface. This mirrors the 013 button + pure-pick pattern.

Covers: US4-AC1/2/3, FR-010/012/015.
"""

from __future__ import annotations

import pytest

from src.nodes.import_disambiguation import (
    CANCEL_IMPORT_LABEL,
    ImportPrompt,
    apply_import_pick,
    collect_import_disambiguations,
    is_cancel_import,
    render_question,
    resolve_import_pick,
    to_selection_options,
)
from tests.fixtures.adversarial import MULTI_WORD_COMMA_TITLE, TRAILING_SPACE_TITLE

_COLLECTIONS = [
    {"collectionId": "c-fav", "name": "Favourites"},
    {"collectionId": "c-scifi", "name": "Sci-Fi"},
    {"collectionId": "c-scifi2", "name": "Sci-Fi"},  # duplicate name → >1 match
]


def _tab(name: str, columns: list[dict] | None = None, rows: list[dict] | None = None) -> dict:
    return {
        "name": name,
        "eligible": True,
        "columns": columns or [{"header": "Title"}, {"header": "Year"}, {"header": "Video Type"}],
        "rows": rows or [],
    }


# ---------------------------------------------------------------------------
# T050: tab → collection disambiguation (0-match and >1-match)
# ---------------------------------------------------------------------------


def test_unmatched_tab_prompts_to_pick_a_collection() -> None:
    prompts = collect_import_disambiguations([_tab("My Movies")], _COLLECTIONS, {})
    coll = [p for p in prompts if p.kind == "collection"]
    assert len(coll) == 1
    assert coll[0].key == "My Movies"
    # 0 name match → all collections offered as buttons.
    offered = {o["collectionId"] for o in coll[0].options}
    assert offered == {"c-fav", "c-scifi", "c-scifi2"}


def test_ambiguous_tab_offers_only_the_matching_collections() -> None:
    prompts = collect_import_disambiguations([_tab("Sci-Fi")], _COLLECTIONS, {})
    coll = [p for p in prompts if p.kind == "collection"]
    assert len(coll) == 1
    offered = {o["collectionId"] for o in coll[0].options}
    assert offered == {"c-scifi", "c-scifi2"}  # the two same-named collections only


def test_exact_single_match_tab_needs_no_collection_prompt() -> None:
    prompts = collect_import_disambiguations([_tab("Favourites")], _COLLECTIONS, {})
    assert [p for p in prompts if p.kind == "collection"] == []


def test_resolved_collection_choice_suppresses_its_prompt() -> None:
    resolutions = {"collection": {"My Movies": "c-fav"}}
    prompts = collect_import_disambiguations([_tab("My Movies")], _COLLECTIONS, resolutions)
    assert [p for p in prompts if p.kind == "collection"] == []


# ---------------------------------------------------------------------------
# T052: medium-confidence column disambiguation
# ---------------------------------------------------------------------------


def test_generic_rating_column_prompts_to_confirm_attribute() -> None:
    tab = _tab(
        "Favourites",
        columns=[
            {"header": "Title"},
            {"header": "Year"},
            {"header": "Video Type"},
            {"header": "Rating", "sampleValues": ["loved it", "ok"]},  # not MPAA, not numeric
        ],
    )
    prompts = collect_import_disambiguations([tab], _COLLECTIONS, {})
    col = [p for p in prompts if p.kind == "column"]
    assert len(col) == 1
    assert col[0].key == "Rating"
    labels = {o["attribute"] for o in col[0].options}
    assert "rated" in labels  # the offered candidate
    assert "__ignore__" in labels  # always an "ignore this column" choice


def test_high_confidence_columns_need_no_prompt() -> None:
    prompts = collect_import_disambiguations([_tab("Favourites")], _COLLECTIONS, {})
    assert [p for p in prompts if p.kind == "column"] == []


# ---------------------------------------------------------------------------
# T054: uncertain trailing-word (article) disambiguation
# ---------------------------------------------------------------------------


def test_uncertain_trailing_word_prompts_for_article() -> None:
    tab = _tab("Favourites", rows=[{"Title": "Goodbye, Lenin!", "Year": "2003",
                                     "Video Type": "Movie"}])
    prompts = collect_import_disambiguations([tab], _COLLECTIONS, {})
    art = [p for p in prompts if p.kind == "article"]
    assert len(art) == 1
    assert art[0].key == "Goodbye, Lenin!"
    values = {o["title"] for o in art[0].options}
    assert "Goodbye, Lenin!" in values  # keep original
    assert any(v != "Goodbye, Lenin!" for v in values)  # the reordered alternative


def test_clear_article_title_needs_no_prompt() -> None:
    tab = _tab("Favourites", rows=[{"Title": "Matrix, The", "Year": "1999",
                                    "Video Type": "Movie"}])
    prompts = collect_import_disambiguations([tab], _COLLECTIONS, {})
    assert [p for p in prompts if p.kind == "article"] == []  # auto-normalizes, no question


# ---------------------------------------------------------------------------
# Pick resolution (pure — a tapped button)
# ---------------------------------------------------------------------------


def _collection_prompt() -> ImportPrompt:
    return collect_import_disambiguations([_tab("Sci-Fi")], _COLLECTIONS, {})[0]


def test_resolve_pick_by_exact_label() -> None:
    prompt = _collection_prompt()
    assert resolve_import_pick("Sci-Fi", prompt) is not None


def test_resolve_pick_by_ordinal() -> None:
    prompt = _collection_prompt()
    chosen = resolve_import_pick("the first one", prompt)
    assert chosen == prompt.options[0]


def test_resolve_pick_returns_none_when_unmatched() -> None:
    prompt = _collection_prompt()
    assert resolve_import_pick("something else entirely", prompt) is None


def test_apply_pick_records_the_choice_into_resolutions() -> None:
    prompt = _collection_prompt()
    chosen = prompt.options[0]  # c-scifi
    resolutions = apply_import_pick({}, prompt, chosen)
    assert resolutions["collection"]["Sci-Fi"] == "c-scifi"


def test_apply_column_pick_records_attribute() -> None:
    tab = _tab(
        "Favourites",
        columns=[{"header": "Title"}, {"header": "Year"}, {"header": "Video Type"},
                 {"header": "Rating", "sampleValues": ["loved it"]}],
    )
    prompt = [p for p in collect_import_disambiguations([tab], _COLLECTIONS, {})
              if p.kind == "column"][0]
    chosen = next(o for o in prompt.options if o["attribute"] == "rated")
    resolutions = apply_import_pick({}, prompt, chosen)
    assert resolutions["column"]["Rating"] == "rated"


# ---------------------------------------------------------------------------
# 047 T023: the article prompt's key and option labels are TRIMMED
#
# The 047 US2 defect. `_article_prompt` kept the raw cell value — trailing space and
# all — as both the resolution key and the option label. A label carrying a trailing
# space is longer than the trimmed reply the member sends back, so resolve_option's
# substring test can never match it: nothing resolves, nothing is recorded, and the
# question re-fires forever with no repeat counter and no escape.
#
# There is a SECOND mismatch on the same axis: build_row_payload looks its
# `article_overrides` up by the trimmed title (_coerce_value strips), so even a
# resolution recorded under the raw key would never be applied. Trimming at the source
# closes both.
# ---------------------------------------------------------------------------


def _article_tab(title: str) -> dict:
    return _tab("Favourites", rows=[{"Title": title, "Year": "2017", "Video Type": "Movie"}])


def test_article_prompt_trimmed_key_has_no_surrounding_whitespace() -> None:
    """The prompt key is the TRIMMED title, so it matches what a reply resolves to."""
    assert TRAILING_SPACE_TITLE.endswith(" "), "fixture lost its significant trailing space"
    prompts = collect_import_disambiguations([_article_tab(TRAILING_SPACE_TITLE)], _COLLECTIONS, {})
    art = [p for p in prompts if p.kind == "article"]
    assert len(art) == 1
    assert art[0].key == TRAILING_SPACE_TITLE.strip()
    assert art[0].key == art[0].key.strip()


def test_article_prompt_trimmed_key_option_labels_carry_no_whitespace() -> None:
    """Every option label is trimmed, so a tap posts back a value that can resolve."""
    prompts = collect_import_disambiguations([_article_tab(TRAILING_SPACE_TITLE)], _COLLECTIONS, {})
    art = [p for p in prompts if p.kind == "article"][0]
    for option in art.options:
        label = str(option["title"])
        assert label == label.strip(), f"option label {label!r} carries whitespace"
    # The "keep" option offers the trimmed original.
    assert TRAILING_SPACE_TITLE.strip() in {str(o["title"]) for o in art.options}


def test_article_prompt_trimmed_key_resolves_a_tapped_reply() -> None:
    """End to end for the reported defect: the tapped label resolves against the prompt."""
    prompts = collect_import_disambiguations([_article_tab(TRAILING_SPACE_TITLE)], _COLLECTIONS, {})
    art = [p for p in prompts if p.kind == "article"][0]
    chosen = resolve_import_pick(TRAILING_SPACE_TITLE.strip(), art)
    assert chosen is not None, "the trailing-space title did not resolve — the loop is still live"
    recorded = apply_import_pick({}, art, chosen)
    assert recorded["article"][TRAILING_SPACE_TITLE.strip()] == TRAILING_SPACE_TITLE.strip()


def test_article_prompt_trimmed_key_question_text_is_trimmed() -> None:
    """The question quotes the trimmed title — a trailing space inside quotes reads as a typo."""
    prompts = collect_import_disambiguations([_article_tab(TRAILING_SPACE_TITLE)], _COLLECTIONS, {})
    art = [p for p in prompts if p.kind == "article"][0]
    assert f'"{TRAILING_SPACE_TITLE.strip()}"' in art.question


def test_article_prompt_trimmed_key_suppressed_by_a_recorded_trimmed_resolution() -> None:
    """A resolution recorded under the trimmed key suppresses the prompt for a raw row.

    This is the re-ask half of the loop: the row still carries the raw cell value, so the
    suppression scan must compare trimmed titles on BOTH sides.
    """
    resolutions = {"article": {TRAILING_SPACE_TITLE.strip(): TRAILING_SPACE_TITLE.strip()}}
    prompts = collect_import_disambiguations(
        [_article_tab(TRAILING_SPACE_TITLE)], _COLLECTIONS, resolutions
    )
    assert [p for p in prompts if p.kind == "article"] == []


def test_multi_word_comma_title_raises_no_sorting_question() -> None:
    """FR-012: a genuine multi-word comma suffix is a real title comma, not a sorting article."""
    prompts = collect_import_disambiguations(
        [_article_tab(MULTI_WORD_COMMA_TITLE)], _COLLECTIONS, {}
    )
    assert [p for p in prompts if p.kind == "article"] == []


# ---------------------------------------------------------------------------
# 047 T033 (FR-008): the question states how many decisions remain
#
# Without it the member has no way to tell a three-question import from a
# thirty-question one, which is what made the loop feel unbounded even before the
# resolution bug was understood.
# ---------------------------------------------------------------------------


def _three_ambiguous_tab() -> dict:
    return _tab(
        "Favourites",
        rows=[
            {"Title": "Goodbye, Lenin!", "Year": "2003", "Video Type": "Movie"},
            {"Title": "Amelie, Le", "Year": "2001", "Video Type": "Movie"},
            {"Title": TRAILING_SPACE_TITLE, "Year": "2017", "Video Type": "Movie"},
        ],
    )


def test_decisions_remaining_is_rendered_in_the_question() -> None:
    prompts = collect_import_disambiguations([_three_ambiguous_tab()], _COLLECTIONS, {})
    assert len(prompts) == 3
    rendered = render_question(prompts[0], remaining=len(prompts))
    assert "3" in rendered, f"question does not state the remaining count: {rendered!r}"
    assert prompts[0].question in rendered, "the original question text was lost"


def test_decisions_remaining_counts_down_as_answers_are_recorded() -> None:
    tab = _three_ambiguous_tab()
    resolutions: dict = {}
    seen: list[int] = []
    for _ in range(6):
        prompts = collect_import_disambiguations([tab], _COLLECTIONS, resolutions)
        if not prompts:
            break
        seen.append(len(prompts))
        prompt = prompts[0]
        chosen = resolve_import_pick(str(prompt.options[0]["title"]).strip(), prompt)
        assert chosen is not None
        resolutions = apply_import_pick(resolutions, prompt, chosen)
    assert seen == [3, 2, 1], f"remaining count did not count down: {seen}"


def test_decisions_remaining_singular_reads_naturally() -> None:
    """User-facing copy must never read "1 decisions".

    At remaining=2 exactly one question follows this one, which is the only place the
    singular can appear — so that is where it is pinned.
    """
    prompts = collect_import_disambiguations([_article_tab(TRAILING_SPACE_TITLE)], _COLLECTIONS, {})
    rendered = render_question(prompts[0], remaining=2)
    assert "1 decisions" not in rendered
    assert "1 more decision" in rendered


def test_decisions_remaining_plural_reads_naturally() -> None:
    prompts = collect_import_disambiguations([_article_tab(TRAILING_SPACE_TITLE)], _COLLECTIONS, {})
    rendered = render_question(prompts[0], remaining=3)
    assert "2 more decisions" in rendered


@pytest.mark.parametrize("remaining", [0, 1])
def test_decisions_remaining_omits_the_count_when_it_is_the_only_question(remaining: int) -> None:
    """Zero/one-of-one is noise; the count earns its place only when more follow."""
    prompts = collect_import_disambiguations([_article_tab(TRAILING_SPACE_TITLE)], _COLLECTIONS, {})
    assert render_question(prompts[0], remaining=remaining) == prompts[0].question


# ---------------------------------------------------------------------------
# 047 T035 (FR-009/FR-010): an escape after two non-resolving replies
# ---------------------------------------------------------------------------


def test_cancel_control_absent_on_the_first_ask() -> None:
    """A question nobody has failed to answer yet needs no escape."""
    prompt = _collection_prompt()
    labels = {o["label"] for o in to_selection_options(prompt, unresolved_replies=0)}
    assert CANCEL_IMPORT_LABEL not in labels


@pytest.mark.parametrize("unresolved", [1, 2, 3])
def test_cancel_control_appended_from_the_first_unresolved_reply(unresolved: int) -> None:
    """FR-009/AC4: the re-ask after ANY non-matching reply offers a way to abandon.

    FR-010 additionally forbids a third identical re-ask without the escape, which a
    threshold of 1 satisfies a fortiori. See the constant's comment for why the plan's
    "after two" reading was not taken.
    """
    prompt = _collection_prompt()
    labels = [o["label"] for o in to_selection_options(prompt, unresolved_replies=unresolved)]
    assert CANCEL_IMPORT_LABEL in labels
    # The escape is appended, never replacing a real choice.
    assert {o["label"] for o in to_selection_options(prompt)} <= set(labels)
    assert labels[-1] == CANCEL_IMPORT_LABEL


def test_cancel_control_resolves_as_a_pick() -> None:
    """Tapping the escape must resolve — an unresolvable escape is not an escape."""
    prompt = _collection_prompt()
    assert is_cancel_import(CANCEL_IMPORT_LABEL)
    assert is_cancel_import("  cancel import  ")
    assert not is_cancel_import("Sci-Fi")
    # It must not collide with a real option label.
    assert CANCEL_IMPORT_LABEL not in {str(o["title"]) for o in prompt.options}
