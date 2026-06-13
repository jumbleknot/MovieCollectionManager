"""T034 (proposal conversion): ImportPreview → approval-gate Proposal batches.

`build_import_proposals` flattens the eligible, collection-targeted TabPlans into ProposalItems
(create → Operation.add with a raw payload; update → Operation.update with a movie_ref) and
chunks them into ≤BATCH_CAP batches the existing HITL approval gate previews + applies one at a
time (reusing the 012/013 pending_batches self-loop). Pure code; no writes.

Covers: US2-AC8/AC9, FR-020/021, SC-006 (idempotency keys preserved).
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
        skipped=[],
        **kw,
    )


def test_single_tab_creates_and_updates_one_batch() -> None:
    tab = _tab("Sci-Fi", "c-scifi", [_item("Dune")], [_item("The Matrix", movie_id="m1")])
    proposals = build_import_proposals(ImportPreview(tabs=[tab]), thread_id="t1")
    assert len(proposals) == 1
    p = proposals[0]
    assert p.kind == ProposalKind.batch
    assert p.batch_index == 0
    assert p.batch_total == 1
    ops = {i.operation for i in p.items}
    assert ops == {Operation.add, Operation.update}


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


def test_chunks_into_batches_of_at_most_cap() -> None:
    creates = [_item(f"Movie {n}") for n in range(BATCH_CAP + 10)]
    tab = _tab("Sci-Fi", "c-scifi", creates, [])
    proposals = build_import_proposals(ImportPreview(tabs=[tab]), thread_id="t1")
    assert len(proposals) == 2
    assert len(proposals[0].items) == BATCH_CAP
    assert len(proposals[1].items) == 10
    assert [p.batch_index for p in proposals] == [0, 1]
    assert all(p.batch_total == 2 for p in proposals)


def test_tab_needing_collection_choice_is_excluded() -> None:
    tab = _tab("Watchlist", None, [], [], needs_collection_choice=True,
               collection_options=[{"collectionId": "c1", "name": "A"}])
    assert build_import_proposals(ImportPreview(tabs=[tab]), thread_id="t1") == []


def test_excluded_tab_is_skipped() -> None:
    tab = _tab("Sci-Fi", "c-scifi", [_item("Dune")], [], excluded=True)
    assert build_import_proposals(ImportPreview(tabs=[tab]), thread_id="t1") == []


def test_empty_preview_yields_no_proposals() -> None:
    assert build_import_proposals(ImportPreview(tabs=[]), thread_id="t1") == []


def test_multiple_tabs_flatten_across_one_batch_sequence() -> None:
    t1 = _tab("Sci-Fi", "c-scifi", [_item("Dune")], [])
    t2 = _tab("Horror", "c-horror", [_item("Alien")], [])
    proposals = build_import_proposals(ImportPreview(tabs=[t1, t2]), thread_id="t1")
    # Both tabs' items share the sequential batch stream (one preview→approve loop).
    all_refs = {i.movie_ref["collectionId"] for p in proposals for i in p.items}
    assert all_refs == {"c-scifi", "c-horror"}
