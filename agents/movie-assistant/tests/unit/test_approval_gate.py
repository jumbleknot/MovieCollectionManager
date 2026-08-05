"""Unit tests for the approval gate apply-on-resume logic (T042, US1).

The gate pauses the graph (LangGraph `interrupt()`) with an AG-UI approval-request and holds
NO token while paused; on approved resume it executes the proposal's writes via the injected
`execute` (a closure over invoke_tool→movie-mcp in production). The interrupt/resume runtime
is exercised in T036 (integration); here we unit-test the deterministic pieces:

- `build_approval_request(proposal)` — the preview payload (per-item visible; no token).
- `apply_proposal(proposal, execute)` — code-orchestrated apply: create-collection first,
  thread the new id into the add, aggregate applied/skipped, mark per-item revalidation,
  pass each item's deterministic idempotency key (SC-006).
- `to_movie_payload(candidate)` — shape an EnrichedMovieCandidate to the mc-service add payload.
"""

from __future__ import annotations

from typing import Any

from src.nodes.approval_gate import (
    ApplyResult,
    ExecOutcome,
    apply_proposal,
    build_approval_request,
)
from src.proposals import (
    CollectionRef,
    EnrichedMovieCandidate,
    Operation,
    OrganizeOp,
    Revalidation,
    build_add_proposal,
    build_organize_proposal,
    to_movie_payload,
)

_CANDIDATE = EnrichedMovieCandidate(
    source_id="tmdb:603", title="The Matrix", year=1999, genres=["Science Fiction"],
    overview="A hacker learns the truth.", language="English",
)


def _existing_proposal() -> Any:
    return build_add_proposal(
        thread_id="t1", proposal_id="p1", candidate=_CANDIDATE,
        target=CollectionRef(collection_id="0123456789abcdef01234567", name="Sci-Fi"),
    )


def _create_if_missing_proposal() -> Any:
    return build_add_proposal(
        thread_id="t1", proposal_id="p2", candidate=_CANDIDATE,
        target=CollectionRef(name="Brand New", create_if_missing=True),
    )


# ── apply_proposal ───────────────────────────────────────────────────────────

async def test_apply_single_add_to_existing_collection() -> None:
    calls: list[tuple[str, dict[str, Any], str]] = []

    async def execute(operation: Any, args: dict[str, Any], key: str) -> ExecOutcome:
        calls.append((str(operation), args, key))
        return ExecOutcome(status="applied", data={"movieId": "m1"})

    result = await apply_proposal(_existing_proposal(), execute=execute)

    assert isinstance(result, ApplyResult)
    assert result.applied_item_ids == ["add-movie"]
    assert result.skipped_item_ids == []
    op, args, key = calls[0]
    assert args["collectionId"] == "0123456789abcdef01234567"
    assert args["movie"]["title"] == "The Matrix"
    assert key  # deterministic idempotency key forwarded
    # 040 US4: the created movie's id + collection are captured so the gate can navigate to it.
    assert result.added_movie_id == "m1"
    assert result.added_collection_id == "0123456789abcdef01234567"


async def test_apply_create_if_missing_threads_new_collection_id_into_add() -> None:
    seen: dict[str, Any] = {}

    async def execute(operation: Any, args: dict[str, Any], key: str) -> ExecOutcome:
        if str(operation) == "create_collection":
            return ExecOutcome(status="applied", data={"collectionId": "newcol123"})
        seen["add_collection_id"] = args["collectionId"]
        return ExecOutcome(status="applied", data={"movieId": "m1"})

    result = await apply_proposal(_create_if_missing_proposal(), execute=execute)

    assert result.created_collection_id == "newcol123"
    assert seen["add_collection_id"] == "newcol123"  # add used the just-created collection
    assert set(result.applied_item_ids) == {"create-collection", "add-movie"}


async def test_apply_duplicate_add_is_skipped_not_failed() -> None:
    async def execute(operation: Any, args: dict[str, Any], key: str) -> ExecOutcome:
        return ExecOutcome(status="skipped_duplicate")

    proposal = _existing_proposal()
    result = await apply_proposal(proposal, execute=execute)

    assert result.applied_item_ids == []
    assert result.skipped_item_ids == ["add-movie"]
    assert proposal.items[0].revalidation == Revalidation.skipped_duplicate


# ── apply_proposal: organize batch (update / remove + drift) — US2 ────────────

def _organize_batch() -> Any:
    return build_organize_proposal(
        thread_id="t1",
        proposal_id="po",
        operations=[
            OrganizeOp(
                operation=Operation.update,
                collection_id="c1",
                movie_id="mA",
                movie_payload={"title": "A", "rated": "PG-13"},
            ),
            OrganizeOp(operation=Operation.remove, collection_id="c1", movie_id="mB"),
        ],
    )


async def test_apply_organize_batch_runs_update_and_remove() -> None:
    calls: list[tuple[str, dict[str, Any], str]] = []

    async def execute(operation: Any, args: dict[str, Any], key: str) -> ExecOutcome:
        calls.append((str(operation), args, key))
        return ExecOutcome(status="applied")

    result = await apply_proposal(_organize_batch(), execute=execute)

    assert set(result.applied_item_ids) == {"update-0", "remove-1"}
    by_op = {op: args for op, args, _ in calls}
    assert by_op["update"] == {
        "collectionId": "c1",
        "movieId": "mA",
        "movie": {"title": "A", "rated": "PG-13"},
    }
    assert by_op["remove"] == {"collectionId": "c1", "movieId": "mB"}


async def test_apply_organize_skips_drifted_item_without_aborting_batch() -> None:
    # The update target drifted (deleted since the proposal) → skipped_missing; the remove
    # still applies — the batch is never aborted (FR-009a / SC-010).
    async def execute(operation: Any, args: dict[str, Any], key: str) -> ExecOutcome:
        if str(operation) == "update":
            return ExecOutcome(status="skipped_missing")
        return ExecOutcome(status="applied")

    proposal = _organize_batch()
    result = await apply_proposal(proposal, execute=execute)

    assert result.applied_item_ids == ["remove-1"]
    assert result.skipped_item_ids == ["update-0"]
    assert proposal.items[0].revalidation == Revalidation.skipped_missing


# ── apply_proposal: move = guarded add-then-remove (T070b) ────────────────────

def _move_proposal() -> Any:
    return build_organize_proposal(
        thread_id="t1",
        proposal_id="pmv",
        operations=[
            OrganizeOp(
                operation=Operation.move,
                collection_id="src1",
                movie_id="mX",
                dest_collection_id="dst1",
                movie_payload={"title": "Inception", "year": 2010, "owned": True},
                label="Inception",
            )
        ],
    )


async def test_apply_move_adds_to_dest_then_removes_from_source() -> None:
    calls: list[tuple[str, dict[str, Any], str]] = []

    async def execute(operation: Any, args: dict[str, Any], key: str) -> ExecOutcome:
        calls.append((str(operation), args, key))
        return ExecOutcome(status="applied")

    result = await apply_proposal(_move_proposal(), execute=execute)

    # add-to-dest happens BEFORE remove-from-source (no window where the movie exists nowhere).
    assert [op for op, _, _ in calls] == ["add", "remove"]
    add_args, remove_args = calls[0][1], calls[1][1]
    assert add_args == {
        "collectionId": "dst1",
        "movie": {"title": "Inception", "year": 2010, "owned": True},
    }
    assert remove_args == {"collectionId": "src1", "movieId": "mX"}
    # The two writes carry distinct at-most-once keys derived from the item key.
    assert calls[0][2] != calls[1][2]
    assert result.applied_item_ids == ["move-0"]


async def test_apply_move_leaves_source_intact_when_dest_add_fails() -> None:
    # A hard failure adding to the destination must NOT remove from the source — no data loss.
    calls: list[str] = []

    async def execute(operation: Any, args: dict[str, Any], key: str) -> ExecOutcome:
        calls.append(str(operation))
        if str(operation) == "add":
            return ExecOutcome(status="failed", error="boom")
        return ExecOutcome(status="applied")

    proposal = _move_proposal()
    result = await apply_proposal(proposal, execute=execute)

    assert calls == ["add"]  # remove was never attempted
    assert result.failed_item_ids == ["move-0"]
    assert result.applied_item_ids == []


async def test_apply_move_completes_when_dest_already_holds_the_movie() -> None:
    # Dest already has it (409 → skipped_duplicate): the move still completes by removing the
    # source copy. The move item is recorded as applied (the move happened).
    async def execute(operation: Any, args: dict[str, Any], key: str) -> ExecOutcome:
        if str(operation) == "add":
            return ExecOutcome(status="skipped_duplicate")
        return ExecOutcome(status="applied")

    result = await apply_proposal(_move_proposal(), execute=execute)
    assert result.applied_item_ids == ["move-0"]


async def test_apply_move_is_complete_when_source_already_gone() -> None:
    # Add succeeds, but the source copy drifted away (404 on remove) — the movie is in the dest
    # and not in the source, so the move is complete (applied, not a failure).
    async def execute(operation: Any, args: dict[str, Any], key: str) -> ExecOutcome:
        if str(operation) == "add":
            return ExecOutcome(status="applied")
        return ExecOutcome(status="skipped_missing")

    result = await apply_proposal(_move_proposal(), execute=execute)
    assert result.applied_item_ids == ["move-0"]
    assert result.failed_item_ids == []


# ── approval-request payload ─────────────────────────────────────────────────

def test_build_approval_request_lists_items_and_carries_no_token() -> None:
    payload = build_approval_request(_create_if_missing_proposal())
    assert payload["type"] == "approval_request"
    assert payload["proposalId"] == "p2"
    assert len(payload["items"]) == 2  # create + add, each individually visible (FR-006)
    # No credential anywhere in the preview.
    blob = repr(payload).lower()
    assert "token" not in blob and "bearer" not in blob and "authorization" not in blob


# ── candidate → mc-service payload ───────────────────────────────────────────

def test_to_movie_payload_maps_candidate_fields_with_defaults() -> None:
    payload = to_movie_payload(_CANDIDATE)
    assert payload["title"] == "The Matrix"
    assert payload["year"] == 1999
    assert payload["genres"] == ["Science Fiction"]
    assert payload["contentType"] == "Movie"  # default for an assistant add
    # The TMDB provenance is preserved as an external id in mc-service's shape
    # (ExternalIdentifier { system, uniqueId, url? } — camelCase). Using `source`/`id`
    # was a real defect that mc-service rejected with 422 "missing field `system`" (T036).
    ext = payload["externalIds"]
    assert any(e.get("system") == "tmdb" and e.get("uniqueId") == "603" for e in ext)


# ── 047 US3 (T043): bounded-concurrency apply ────────────────────────────────────────────────────
#
# A 2,000-row import applied strictly one write at a time is the other half of "it never finishes".
# Concurrency must not cost any of the three properties the sequential loop provides for free:
# per-item idempotency keys, create_collection FIRST with its new id threaded into every add, and
# a deterministic report.

import asyncio  # noqa: E402

from src.nodes.approval_gate import IMPORT_APPLY_CONCURRENCY  # noqa: E402
from src.proposals import Proposal, ProposalItem, ProposalKind  # noqa: E402


def _import_proposal(n: int, *, with_create_collection: bool = True) -> Proposal:
    items: list[ProposalItem] = []
    if with_create_collection:
        items.append(
            ProposalItem(
                item_id="new-collection",
                operation=Operation.create_collection,
                idempotency_key="key:create-collection",
            )
        )
    for i in range(n):
        items.append(
            ProposalItem(
                item_id=f"row-{i}",
                operation=Operation.add,
                movie_payload={"title": f"Film {i}", "year": 2000},
                idempotency_key=f"key:row-{i}",
            )
        )
    return Proposal(
        proposal_id="import:concurrent",
        kind=ProposalKind.batch,
        items=items,
        target_collection=CollectionRef(collection_id=None, name="Imported"),
    )


async def test_concurrent_apply_preserves_every_idempotency_key() -> None:
    """Each item keeps ITS OWN key — a shared or reused key would make retries collide."""
    seen: list[tuple[str, str | None]] = []

    async def execute(operation: Any, args: dict[str, Any], key: str) -> ExecOutcome:
        seen.append((key, args.get("collectionId")))
        if operation == Operation.create_collection:
            return ExecOutcome(status="applied", data={"collectionId": "c-new"})
        return ExecOutcome(status="applied", data={"movieId": "m"})

    result = await apply_proposal(_import_proposal(50), execute=execute)

    keys = [k for k, _ in seen]
    assert len(keys) == 51, f"expected 51 writes, got {len(keys)}"
    assert len(set(keys)) == 51, "idempotency keys collided under concurrency"
    assert len(result.applied_item_ids) == 51


async def test_concurrent_apply_creates_the_collection_first_and_threads_its_id() -> None:
    """create_collection must complete BEFORE any add, and every add must target the new id."""
    order: list[str] = []
    add_targets: list[str | None] = []

    async def execute(operation: Any, args: dict[str, Any], _key: str) -> ExecOutcome:
        if operation == Operation.create_collection:
            order.append("create")
            await asyncio.sleep(0.01)  # slow: a concurrent add would overtake it
            return ExecOutcome(status="applied", data={"collectionId": "c-new"})
        order.append("add")
        add_targets.append(args.get("collectionId"))
        return ExecOutcome(status="applied", data={"movieId": "m"})

    await apply_proposal(_import_proposal(30), execute=execute)

    assert order[0] == "create", f"an add ran before the collection existed: {order[:3]}"
    assert "create" not in order[1:], "create_collection ran more than once"
    assert add_targets and all(t == "c-new" for t in add_targets), (
        f"an add did not target the newly created collection: {set(add_targets)}"
    )


async def test_concurrent_apply_reports_in_deterministic_item_order() -> None:
    """Completion order must not leak into the report — finishing order is nondeterministic."""

    async def execute(operation: Any, args: dict[str, Any], _key: str) -> ExecOutcome:
        if operation == Operation.create_collection:
            return ExecOutcome(status="applied", data={"collectionId": "c-new"})
        # Later rows finish FIRST — if the report follows completion it will be reversed.
        title = str((args.get("movie") or {}).get("title") or "")
        index = int(title.rsplit(" ", 1)[-1] or 0)
        await asyncio.sleep((20 - index) * 0.001)
        return ExecOutcome(status="applied", data={"movieId": "m"})

    result = await apply_proposal(_import_proposal(20), execute=execute)

    expected = ["new-collection", *[f"row-{i}" for i in range(20)]]
    assert result.applied_item_ids == expected, "report order followed completion, not item order"


async def test_concurrent_apply_is_actually_concurrent_and_bounded() -> None:
    """It must overlap writes — and never exceed IMPORT_APPLY_CONCURRENCY at once."""
    in_flight = 0
    peak = 0

    async def execute(operation: Any, _args: dict[str, Any], _key: str) -> ExecOutcome:
        nonlocal in_flight, peak
        if operation == Operation.create_collection:
            return ExecOutcome(status="applied", data={"collectionId": "c-new"})
        in_flight += 1
        peak = max(peak, in_flight)
        try:
            await asyncio.sleep(0.01)
            return ExecOutcome(status="applied", data={"movieId": "m"})
        finally:
            in_flight -= 1

    await apply_proposal(_import_proposal(64), execute=execute)

    assert peak > 1, "writes were still strictly sequential"
    assert peak <= IMPORT_APPLY_CONCURRENCY, (
        f"exceeded the bound: {peak} writes in flight, limit {IMPORT_APPLY_CONCURRENCY}"
    )
