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
    Revalidation,
    build_add_proposal,
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
