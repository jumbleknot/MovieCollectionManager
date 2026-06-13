"""Import-collection node: orchestrate a spreadsheet import (US2/US4, feature 014).

Pipeline (all PURE CODE — the LLM is used only by the supervisor to classify the `import`
intent; column mapping / article normalization / dedup / tab→collection match are deterministic
resolvers in import_resolvers.py):

    parse_spreadsheet (handle) → eligible tabs → resolve columns → transform rows →
    dedup within import → match against the chosen collection's existing movies →
    compose payloads (create / update-without-blanking) → ImportPreview → HITL confirm → writes

This module owns the PURE preview assembly (`build_import_preview`, `resolve_tab_collection`).
The runtime wiring (reading collections/movies via movie-mcp, parsing via spreadsheet-mcp,
threading identity, and the approval-gate write loop) lives in runtime_nodes.py and composes
these functions. Keeping the planning pure makes it exhaustively unit-testable and keeps writes
behind the HITL gate (FR-020 — nothing here calls a write tool).
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

from src.nodes.import_resolvers import (
    apply_create_defaults,
    build_row_payload,
    compose_import_payload,
    dedup_import_rows,
    match_existing_movie,
    resolve_columns,
)
from src.proposals import (
    BATCH_CAP,
    Operation,
    Proposal,
    ProposalItem,
    ProposalKind,
    idempotency_key,
)

# Required-for-import attributes (FR-008 row level): a row missing any is skipped + counted.
_REQUIRED = ("title", "year", "contentType")


class ImportStage:
    """The deterministic import flow stages (parse → resolve → preview → confirm → write)."""

    PARSE = "parse"
    RESOLVE = "resolve"
    AWAIT_COLLECTION = "await_collection"
    PREVIEW = "preview"
    WRITE = "write"
    DONE = "done"
    CANCELLED = "cancelled"
    FAILED = "failed"


_TERMINAL_STAGES = frozenset({ImportStage.DONE, ImportStage.CANCELLED, ImportStage.FAILED})

# (stage, signal) → next stage. The ONLY edge into WRITE is PREVIEW+confirm (SC-009/FR-020).
_STAGE_TRANSITIONS: dict[tuple[str, str], str] = {
    (ImportStage.PARSE, "parsed"): ImportStage.RESOLVE,
    (ImportStage.PARSE, "parse_error"): ImportStage.FAILED,
    (ImportStage.RESOLVE, "targets_resolved"): ImportStage.PREVIEW,
    (ImportStage.RESOLVE, "needs_collection_choice"): ImportStage.AWAIT_COLLECTION,
    (ImportStage.AWAIT_COLLECTION, "collection_chosen"): ImportStage.RESOLVE,
    (ImportStage.PREVIEW, "confirm"): ImportStage.WRITE,
    (ImportStage.PREVIEW, "exclude_tab"): ImportStage.PREVIEW,
    (ImportStage.PREVIEW, "cancel"): ImportStage.CANCELLED,
    (ImportStage.WRITE, "complete"): ImportStage.DONE,
}


def next_import_stage(stage: str, signal: str) -> str:
    """Advance the import stage machine. Terminal stages absorb any signal; an undefined
    (stage, signal) raises ValueError so a drift from the spec table surfaces as a failure."""
    if stage in _TERMINAL_STAGES:
        return stage
    try:
        return _STAGE_TRANSITIONS[(stage, signal)]
    except KeyError:
        raise ValueError(f"no import transition from {stage!r} on signal {signal!r}") from None


@dataclass(frozen=True)
class ImportPlanItem:
    """One movie to create (movie_id None) or update (movie_id set) on confirm."""

    title: str
    movie_id: str | None
    payload: dict[str, Any]
    idempotency_key: str


@dataclass(frozen=True)
class TabPlan:
    """The planned import for one eligible tab — surfaced in the preview, gated before write."""

    tab_name: str
    target_collection_id: str | None
    target_collection_name: str | None
    to_create: list[ImportPlanItem]
    to_update: list[ImportPlanItem]
    skipped: list[dict[str, Any]]
    needs_collection_choice: bool = False
    collection_options: list[dict[str, Any]] = field(default_factory=list)
    excluded: bool = False


@dataclass(frozen=True)
class ImportPreview:
    """The whole preview (FR-020) — eligible TabPlans + the names of ignored ineligible tabs."""

    tabs: list[TabPlan]
    ignored_tabs: list[str] = field(default_factory=list)


def resolve_tab_collection(
    tab_name: str, collections: Sequence[dict[str, Any]]
) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    """Resolve a tab name to a target collection by EXACT (case-insensitive) name (FR-009/010).

    Exactly one match → (collection, []). Zero matches → (None, all collections to choose from).
    More than one match → (None, the matching collections) so the user disambiguates. The pick
    itself is resolved later in pure code (US4).
    """
    target = tab_name.strip().casefold()
    matches = [c for c in collections if str(c.get("name", "")).strip().casefold() == target]
    if len(matches) == 1:
        return matches[0], []
    if len(matches) > 1:
        return None, matches
    return None, list(collections)


def build_import_preview(
    *,
    tabs: Sequence[dict[str, Any]],
    collections: Sequence[dict[str, Any]],
    existing_by_collection: dict[str, list[dict[str, Any]]],
    thread_id: str,
) -> ImportPreview:
    """Assemble the import preview from parsed tabs + the user's collections/movies. No writes."""
    tab_plans: list[TabPlan] = []
    ignored: list[str] = []

    for tab in tabs:
        name = str(tab.get("name", ""))
        if not tab.get("eligible"):
            ignored.append(name)
            continue

        target, options = resolve_tab_collection(name, collections)
        mappings = resolve_columns(tab.get("columns", []))

        # Transform rows → typed supplied payloads, skipping rows missing a required field.
        supplied_rows: list[dict[str, Any]] = []
        skipped: list[dict[str, Any]] = []
        for row in tab.get("rows", []):
            payload = build_row_payload(row, mappings)
            missing = [field_ for field_ in _REQUIRED if not _present(payload.get(field_))]
            if missing:
                skipped.append({"title": payload.get("title") or "(untitled)",
                                "reason": f"missing required: {', '.join(missing)}"})
            else:
                supplied_rows.append(payload)

        # Within-import dedup (FR-017) — duplicates are skipped, counted.
        unique, duplicates = dedup_import_rows(supplied_rows)
        skipped.extend(
            {"title": d.get("title") or "(untitled)", "reason": "duplicate within import"}
            for d in duplicates
        )

        if target is None:
            # FR-010: cannot target a collection yet — defer create/update until the user picks.
            tab_plans.append(
                TabPlan(
                    tab_name=name,
                    target_collection_id=None,
                    target_collection_name=None,
                    to_create=[],
                    to_update=[],
                    skipped=skipped,
                    needs_collection_choice=True,
                    collection_options=options,
                )
            )
            continue

        collection_id = str(target["collectionId"])
        existing = existing_by_collection.get(collection_id, [])
        to_create, to_update = _plan_writes(unique, existing, thread_id, name)
        tab_plans.append(
            TabPlan(
                tab_name=name,
                target_collection_id=collection_id,
                target_collection_name=str(target.get("name") or ""),
                to_create=to_create,
                to_update=to_update,
                skipped=skipped,
            )
        )

    return ImportPreview(tabs=tab_plans, ignored_tabs=ignored)


def build_import_proposals(preview: ImportPreview, thread_id: str) -> list[Proposal]:
    """Convert an approved-shape ImportPreview into ≤BATCH_CAP approval-gate Proposal batches.

    Creates → Operation.add carrying a raw `movie_payload` + `movie_ref={collectionId}`; updates
    → Operation.update with `movie_ref={collectionId, movieId}`. All targeted tabs' items share
    ONE sequential batch stream so the existing approval gate previews + applies them chunk by
    chunk (pending_batches self-loop). Tabs awaiting a collection choice (FR-010) or excluded by
    the user (FR-020a) contribute nothing. No writes happen here (FR-020).
    """
    items: list[ProposalItem] = []
    for plan in preview.tabs:
        if plan.excluded or plan.needs_collection_choice or plan.target_collection_id is None:
            continue
        collection_id = plan.target_collection_id
        for create in plan.to_create:
            items.append(
                ProposalItem(
                    item_id=create.idempotency_key[:16],
                    operation=Operation.add,
                    movie_payload=create.payload,
                    movie_ref={"collectionId": collection_id},
                    diff={"add_movie": create.title, "to": plan.target_collection_name or ""},
                    idempotency_key=create.idempotency_key,
                )
            )
        for update in plan.to_update:
            items.append(
                ProposalItem(
                    item_id=update.idempotency_key[:16],
                    operation=Operation.update,
                    movie_payload=update.payload,
                    movie_ref={"collectionId": collection_id, "movieId": update.movie_id},
                    diff={"update_movie": update.title},
                    idempotency_key=update.idempotency_key,
                )
            )

    if not items:
        return []

    batches = [items[i : i + BATCH_CAP] for i in range(0, len(items), BATCH_CAP)]
    total = len(batches)
    return [
        Proposal(
            proposal_id=f"import:{thread_id}:{index}",
            kind=ProposalKind.batch,
            items=batch,
            batch_index=index,
            batch_total=total,
        )
        for index, batch in enumerate(batches)
    ]


def _plan_writes(
    supplied_rows: Sequence[dict[str, Any]],
    existing: Sequence[dict[str, Any]],
    thread_id: str,
    tab_name: str,
) -> tuple[list[ImportPlanItem], list[ImportPlanItem]]:
    """Split transformed rows into create / update items against the target's existing movies."""
    to_create: list[ImportPlanItem] = []
    to_update: list[ImportPlanItem] = []
    for supplied in supplied_rows:
        title = str(supplied["title"])
        match = match_existing_movie(title, supplied.get("year"), existing)
        item_id = f"{title}:{supplied.get('year')}"
        key = idempotency_key(thread_id, tab_name, item_id)
        if match is None:
            to_create.append(
                ImportPlanItem(title, None, apply_create_defaults(supplied), key)
            )
        else:
            to_update.append(
                ImportPlanItem(title, str(match["movieId"]),
                               compose_import_payload(match, supplied), key)
            )
    return to_create, to_update


def _present(value: Any) -> bool:
    """A required field is present when it is non-None and not an empty/whitespace string."""
    if value is None:
        return False
    if isinstance(value, str):
        return value.strip() != ""
    return True
