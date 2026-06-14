"""T031: spec-derived transition table for the import stage machine.

Encodes the EXPECTED next stage for each `(stage, signal)` of the deterministic import flow
parse → resolve → preview → confirm → write — derived from the SPEC (US2/US4 acceptance
criteria + FR-010/020/022), NOT the implementation. A table written from the spec turns "the
code drifted" into a failing test. Adding an import transition = adding a row here.
"""

from __future__ import annotations

import pytest

from src.nodes.import_collection import ImportStage, next_import_stage

# (from_stage, signal, expected_next_stage, traces-to)
TRANSITIONS = [
    # parse
    (ImportStage.PARSE, "parsed", ImportStage.RESOLVE, "US2-AC1"),
    (ImportStage.PARSE, "parse_error", ImportStage.FAILED, "FR-022"),
    # resolve (tab→collection)
    (ImportStage.RESOLVE, "targets_resolved", ImportStage.PREVIEW, "US2-AC1/AC8"),
    (ImportStage.RESOLVE, "needs_collection_choice", ImportStage.AWAIT_COLLECTION, "FR-010"),
    # await user's collection pick
    (ImportStage.AWAIT_COLLECTION, "collection_chosen", ImportStage.RESOLVE, "US4-AC4"),
    # preview (HITL)
    (ImportStage.PREVIEW, "confirm", ImportStage.WRITE, "US2-AC8/FR-020"),
    (ImportStage.PREVIEW, "exclude_tab", ImportStage.PREVIEW, "US2-AC10/FR-020a"),
    (ImportStage.PREVIEW, "cancel", ImportStage.CANCELLED, "SC-009/FR-020"),
    # write
    (ImportStage.WRITE, "complete", ImportStage.DONE, "US2-AC9/FR-021"),
]


@pytest.mark.parametrize("from_stage,signal,expected,trace", TRANSITIONS)
def test_transition(from_stage: str, signal: str, expected: str, trace: str) -> None:
    assert next_import_stage(from_stage, signal) == expected, f"({from_stage},{signal}) [{trace}]"


@pytest.mark.parametrize("terminal", [ImportStage.DONE, ImportStage.CANCELLED, ImportStage.FAILED])
def test_terminal_states_are_absorbing(terminal: str) -> None:
    assert next_import_stage(terminal, "anything") == terminal


def test_no_write_before_confirm() -> None:
    """SC-009 / FR-020: the only path into WRITE is an explicit confirm at PREVIEW."""
    into_write = [
        (s, sig) for (s, sig, nxt, _) in TRANSITIONS if nxt == ImportStage.WRITE
    ]
    assert into_write == [(ImportStage.PREVIEW, "confirm")]


def test_cancel_never_reaches_write() -> None:
    assert next_import_stage(ImportStage.PREVIEW, "cancel") == ImportStage.CANCELLED


def test_undefined_transition_raises() -> None:
    with pytest.raises(ValueError):
        next_import_stage(ImportStage.PREVIEW, "parsed")  # nonsensical signal for this stage
