"""T034 (proposal conversion): ImportPreview → a SINGLE confirm-once approval Proposal.

`build_import_proposals` flattens the eligible, collection-targeted TabPlans into ProposalItems
(create → Operation.add with a raw payload; update → Operation.update with a movie_ref) inside ONE
Proposal carrying a tab-level `import_summary`. An import has hundreds of rows, so it is NOT
chunked into per-batch approval cards (that produced an unusable wall of "Add this item" lines);
the gate previews the summary once and applies everything on a single confirm. Each item is tagged
with its source `tab` so a tab excluded at the preview is dropped at apply time. Pure code; no
writes.

Covers: US2-AC8/AC9, FR-020/FR-020a, SC-006 (idempotency keys preserved).
"""

from __future__ import annotations

from src.nodes.import_collection import (
    ImportPlanItem,
    ImportPreview,
    TabPlan,
    build_import_proposals,
)
from src.proposals import BATCH_CAP, Operation, ProposalKind


def _item(title: str, *, movie_id: str | None = None, key: str | None = None) -> ImportPlanItem:
    payload = {"title": title, "year": 2000, "contentType": "Movie"}
    if movie_id:
        return ImportPlanItem(title, movie_id, payload, key or f"k-{title}")
    return ImportPlanItem(title, None, payload, key or f"k-{title}")


def _tab(name: str, cid: str | None, create: list, update: list, **kw) -> TabPlan:
    return TabPlan(
        tab_name=name,
        target_collection_id=cid,
        target_collection_name=name,
        to_create=create,
        to_update=update,
        skipped=kw.pop("skipped", []),
        **kw,
    )


def test_single_tab_creates_and_updates_one_proposal() -> None:
    tab = _tab("Sci-Fi", "c-scifi", [_item("Dune")], [_item("The Matrix", movie_id="m1")])
    proposals = build_import_proposals(ImportPreview(tabs=[tab]), thread_id="t1")
    assert len(proposals) == 1
    p = proposals[0]
    assert p.kind == ProposalKind.batch
    ops = {i.operation for i in p.items}
    assert ops == {Operation.add, Operation.update}


def test_carries_a_tab_level_summary_not_per_item_listing() -> None:
    tab = _tab(
        "Sci-Fi",
        "c-scifi",
        [_item("Dune"), _item("Arrival")],
        [_item("The Matrix", movie_id="m1")],
        skipped=[{"title": "dup", "reason": "duplicate within import"}],
    )
    p = build_import_proposals(ImportPreview(tabs=[tab], ignored_tabs=["Lists"]), thread_id="t1")[0]
    assert p.import_summary is not None
    summary = p.import_summary
    assert summary["tabs"] == [
        {
            "tabName": "Sci-Fi",
            "collectionName": "Sci-Fi",
            "createCount": 2,
            "updateCount": 1,
            "skippedCount": 1,
        }
    ]
    assert summary["ignoredTabs"] == ["Lists"]
    assert summary["totalCreate"] == 2
    assert summary["totalUpdate"] == 1


def test_every_item_is_tagged_with_its_source_tab() -> None:
    tab = _tab("Sci-Fi", "c-scifi", [_item("Dune")], [_item("The Matrix", movie_id="m1")])
    items = build_import_proposals(ImportPreview(tabs=[tab]), thread_id="t1")[0].items
    assert all(i.diff.get("tab") == "Sci-Fi" for i in items)


def test_create_item_carries_payload_and_target_no_candidate() -> None:
    tab = _tab("Sci-Fi", "c-scifi", [_item("Dune")], [])
    item = build_import_proposals(ImportPreview(tabs=[tab]), thread_id="t1")[0].items[0]
    assert item.operation == Operation.add
    assert item.movie_candidate is None
    assert item.movie_payload["title"] == "Dune"
    assert item.movie_ref == {"collectionId": "c-scifi"}


def test_update_item_carries_movie_ref_with_id() -> None:
    tab = _tab("Sci-Fi", "c-scifi", [], [_item("The Matrix", movie_id="m1")])
    item = build_import_proposals(ImportPreview(tabs=[tab]), thread_id="t1")[0].items[0]
    assert item.operation == Operation.update
    assert item.movie_ref == {"collectionId": "c-scifi", "movieId": "m1"}
    assert item.movie_payload["title"] == "The Matrix"


def test_idempotency_keys_preserved_from_plan_items() -> None:
    tab = _tab("Sci-Fi", "c-scifi", [_item("Dune", key="kd")], [_item("X", movie_id="m", key="kx")])
    keys = {i.idempotency_key for p in build_import_proposals(ImportPreview(tabs=[tab]), "t1")
            for i in p.items}
    assert keys == {"kd", "kx"}


def test_large_import_stays_a_single_confirm_once_proposal() -> None:
    """A 200+-row import is ONE proposal (one summary card), never chunked into many cards."""
    creates = [_item(f"Movie {n}") for n in range(BATCH_CAP * 4)]
    tab = _tab("Sci-Fi", "c-scifi", creates, [])
    proposals = build_import_proposals(ImportPreview(tabs=[tab]), thread_id="t1")
    assert len(proposals) == 1
    assert len(proposals[0].items) == BATCH_CAP * 4
    assert proposals[0].import_summary is not None
    assert proposals[0].import_summary["totalCreate"] == BATCH_CAP * 4


def test_tab_needing_collection_choice_is_excluded() -> None:
    tab = _tab("Watchlist", None, [], [], needs_collection_choice=True,
               collection_options=[{"collectionId": "c1", "name": "A"}])
    assert build_import_proposals(ImportPreview(tabs=[tab]), thread_id="t1") == []


def test_excluded_tab_is_skipped() -> None:
    tab = _tab("Sci-Fi", "c-scifi", [_item("Dune")], [], excluded=True)
    assert build_import_proposals(ImportPreview(tabs=[tab]), thread_id="t1") == []


def test_empty_preview_yields_no_proposals() -> None:
    assert build_import_proposals(ImportPreview(tabs=[]), thread_id="t1") == []


def test_multiple_tabs_flatten_into_one_proposal_with_per_tab_summary() -> None:
    t1 = _tab("Sci-Fi", "c-scifi", [_item("Dune")], [])
    t2 = _tab("Horror", "c-horror", [_item("Alien")], [])
    proposals = build_import_proposals(ImportPreview(tabs=[t1, t2]), thread_id="t1")
    assert len(proposals) == 1
    p = proposals[0]
    all_refs = {i.movie_ref["collectionId"] for i in p.items}
    assert all_refs == {"c-scifi", "c-horror"}
    assert [t["tabName"] for t in p.import_summary["tabs"]] == ["Sci-Fi", "Horror"]
