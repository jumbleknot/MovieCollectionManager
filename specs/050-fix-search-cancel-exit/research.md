# Phase 0 Research: Cancelling a movie search actually exits it

**Feature**: `050-fix-search-cancel-exit` | **Date**: 2026-08-09 | **Spec**: [spec.md](./spec.md)

There were no `NEEDS CLARIFICATION` markers in the spec. This phase instead answers the two
questions the spec deliberately left to design — *where does the fix belong* and *why did the
shipped tests not catch this* — because the second one changes the scope of the work.

---

## R1 — Root cause: the exit control is honoured only while a search stage is live

**Decision**: The defect is a guard condition in the agent's search node, not a client bug and not
a missing feature.

**Evidence** (`agents/movie-assistant/src/nodes/search.py`):

```python
# line 498, inside the search node's dispatcher
if stage and (CTRL_EXIT in low or low in {"exit", "cancel", "never mind", "nevermind"}):
    return _exit()
```

The control is gated on `stage` being non-empty. But the movie card is the **terminal** step of a
web search, and `_web_card()` (line 320) returns `**_SEARCH_RESET`, which sets `search_stage: ""`
*before* the card is rendered. So at the moment the member can actually see and press cancel, the
guard is false by construction.

Execution then falls through to the fresh-search branch (line 562). `_extract_search("exit search")`
strips no leading verb — `_SEARCH_VERB_RE` is anchored at `^` and "exit" is not one of its verbs —
so the title becomes the literal string `exit search`. `_resolve_scope_collection` picks the
on-screen collection, and `_run_owned` produces:

> `I couldn't find "exit search" in your "Wish List" collection. Want to look elsewhere?`

which is the reported message, verbatim, including the member's on-screen collection name.

### Measured reproduction

Driving the real `build_search_node` with stub reads, no search stage (the terminal-card
condition), and the message `exit search`:

```text
REPLY:            I couldn't find "exit search" in your "Wish List" collection. Want to look elsewhere?
TOOL CALLS:       ['render_selection']
READS PERFORMED:  [('wish', 'exit search')]
search_stage after: 'awaiting_pick'
```

Three things beyond the reported symptom, all of which raise the severity:

1. **A real read is issued.** `list_movies("wish", "exit search")` goes out over MCP to
   mc-service. A cancel is supposed to be a read-nothing turn (FR-003, FR-005).
2. **A `render_selection` call is emitted** — the reply is not merely wrong text, it re-offers the
   search controls. The member who asked to leave is handed the workflow again (FR-007).
3. **`search_stage` ends at `awaiting_pick`.** The cancel does not fail *neutrally*; it puts the
   member **back inside** the search workflow they were trying to leave, from a state where they
   had already left it. So the member's *next* message is now captured as a search reply too —
   FR-006 is violated as well, and the escape hatch is not just useless but actively trapping.

Point 3 is the one that matters for prioritisation: the reported message understates the defect.
The item is filed p2 as a wrong-answer bug; the measured behaviour is a member being pulled into a
workflow loop by the control that exists to end it.

**Rationale for calling this the root cause**: the two remaining hypotheses are both refuted by the
same code. The client is correct — `render-movie-card.tsx` posts exactly `SEARCH_CANCEL_TEXT =
'exit search'`, which matches `CTRL_EXIT`. And the intent classifier did route the turn to the
search node (otherwise the reply could not have come from `_run_owned`). Nothing upstream is
broken; the destination simply refuses the message it was sent.

**A note on the code comments**: `_web_card_props` (lines 310–313) and the test file both assert
in prose that *"the search node already treats it as a universal control, so no new agent-side
parsing is introduced"*. That reasoning is what shipped the bug — the control is universal across
*stages*, not across *no stage at all*, and the terminal card is the one place with no stage. The
comments must be corrected along with the code, or the next reader inherits the same false premise.

---

## R2 — Why the shipped tests passed while the feature was broken

**Decision**: Strengthening two existing tests is **in scope and mandatory**, not optional polish.
This is the same class of failure the repository's own gate warns about — a green check that was
never evidence for the claim being made.

Feature 047 shipped three pieces of coverage for US5. Each is green today, on the broken code:

| Test | What it asserts | Why the bug slips past |
|---|---|---|
| `test_cancel_no_writes_produces_an_acknowledgement_and_zero_write_calls` (`tests/unit/test_search.py:623`) | Calls `_exit()` **directly** and checks its return value | It tests the *destination*, never the *route*. `_exit()` was always correct; nothing ever asserted that pressing cancel reaches it. |
| `test_cancelable_is_emitted_by_the_terminal_web_card` (`tests/unit/test_search.py:602`) | The card carries `cancelable: true` | Asserts the button exists, not what pressing it does. |
| `agent-search.spec.ts:133` "cancel from the web card ends the search…" | After clicking cancel: the Add button is disabled, no approval request appears, the card is still visible, a later message works | **Every one of these passes on the broken behaviour.** The disabled Add button is client-local state (`setActioned(true)`) set before the agent replies at all; a *failed search* also produces no approval request. The test never asserts what the assistant actually said. |

**Rationale**: A regression test that cannot fail on the reported bug does not protect the fix.
Spec FR-011 requires the new test to sit "at the level where the defect actually occurs", and
SC-006 requires a demonstrated RED. Both are satisfied only by asserting the *dispatcher's*
behaviour (unit) and the *assistant's reply text* (E2E).

**Alternative considered and rejected**: leaving the E2E as-is and relying on the new unit test.
Rejected because the E2E is the artifact that gave false confidence in the first place; leaving it
asserting client-local state means the next member-visible regression in this flow is equally
invisible.

---

## R3 — Where to place the fix

**Decision**: Fix in the agent, in two places — the search node's dispatcher (so the control is
honoured with no live stage) **and** the supervisor's router (so reaching that dispatcher does not
depend on a model classification). No client change.

**Rationale**:

- **Agent, not client.** A client-only fix (dismiss the card locally, post nothing) would break
  047 FR-033, which requires the member to be *acknowledged*. Silence is not an acknowledgement.
- **Agent-only gives FR-008 for free.** Web and mobile post the same canonical value through the
  same agent, so a fix in the shared agent is identical on both surfaces *by construction* rather
  than by a second implementation that has to be kept in step. This also means US3 is verified,
  not built.
- **Two places, because FR-010.** Fixing only the search node leaves the route to it decided by
  `classifier(messages)` — an LLM call. Today it happens to classify `exit search` as `search`;
  that is a provider-dependent accident of exactly the kind that has bitten this repository before
  (047's ownership-reply guard exists because prose-like replies classified differently on Ollama
  and Anthropic). Worse, `_classify` returns `degraded` when the classifier *raises*, before any
  routing runs — so a provider outage would answer a cancel with "I couldn't complete that". An
  escape hatch that needs a working LLM to be honoured is not an escape hatch.

**Alternatives considered**:

| Alternative | Rejected because |
|---|---|
| Client dismisses the card, posts nothing | No acknowledgement → violates 047 FR-033 / this spec's FR-002. Also leaves any typed "exit search" still broken. |
| Add "exit"/"cancel" to `_SEARCH_VERB_RE` so the title extracts to empty | Turns a control into a parsing accident, and the empty-title branch asks "What movie would you like to search for?" — the opposite of exiting. |
| Send a structured non-text signal instead of a message | A real improvement in the abstract, but it changes the client↔agent contract, the transcript shape, and both surfaces, for a p2 bug fix. Out of proportion; noted as possible future work. |
| Fix the search node only | Leaves routing dependent on the classifier — fails FR-010. |

---

## R4 — Exact match, not substring, for the deterministic route

**Decision**: The stage-free route matches the canonical value **exactly** (trimmed, case-folded).
The looser in-stage synonyms (`exit`, `cancel`, `never mind`, `nevermind`) stay scoped to a live
search stage, exactly where they are today.

**Rationale**: This is what keeps the fix from causing two new bugs.

1. **Substring matching would capture real titles.** The current in-stage check uses
   `CTRL_EXIT in low` — a substring test. Promoted to a global route, any message *containing*
   "exit search" would be hijacked. Spec edge case "cancel wording appearing inside a genuine
   request" forbids this. Exact match is also how the repository's existing precedent works:
   `is_cancel_import` (`src/nodes/import_disambiguation.py:210`) is
   `text.strip().casefold() in _CANCEL_IMPORT_REPLIES`.
2. **Routing bare `cancel` globally would steal other workflows' cancels.** `cancel` is a
   plausible reply during an import prompt or an organize disambiguation, both of which have their
   own cancel handling (`is_cancel_import`, `is_organize_cancel`). Only the canonical
   `exit search` — a value a member can only produce by choosing a search control — is
   unambiguous enough to route without a stage.

**Precedent**: this is the same shape as 047 FR-009/FR-010's cancel-import control, routed
explicitly in `graph.py:387` with the comment *"an escape that depends on a model call is not an
escape"*. This feature applies that already-ratified reasoning to the search control.

---

## R5 — Blast radius: what a stage-free exit must not destroy

**Decision**: Guard the deterministic route on there being **no in-progress add** (`add_stage`).
No guard is needed for the import, organize, or navigate workflows.

**Rationale**: `_exit()` returns `**_LIFECYCLE_RESET, **_SEARCH_RESET`.

- `_SEARCH_RESET` clears search state — the point of the change.
- `_LIFECYCLE_RESET` clears `pending_proposal` / `add_stage` / `resolved_pick` — so a stage-free
  exit taken while an add is mid-flight would silently discard the member's half-finished add.
  That is the failure mode 047's ownership guard was written to prevent, so the new route must not
  reintroduce it. One guard clause, stated with its reason.
- `import_stage`, `organize_stage` and `navigate_stage` are **not** in either reset dict, so those
  workflows survive an exit untouched. This satisfies the spec's "stale card" edge case — a late
  cancel acknowledges and does not disturb what the member is doing now — without further code.

**Verification owed**: the tasks must assert this rather than assume it. A test that cancels while
an import is pending and confirms the import still resumes is cheap and pins the claim.

---

## R6 — Test placement

**Decision**: Reuse the existing table-driven transition suite; add a supervisor-routing test
alongside the existing escape-guard tests; strengthen the E2E assertion.

| Level | File | Why here |
|---|---|---|
| Unit — dispatcher | `tests/unit/test_state_machine_transitions.py` (`_SEARCH_TRANSITIONS`) | The table already has a `pick-exit→exit` row for the *in-stage* case; the missing case is one more row with empty state. The RED is a single table entry, which is the clearest possible statement of the bug. |
| Unit — router | `tests/unit/test_graph.py` | Already contains the pattern needed for FR-010: `test_non_user_turn_ends_without_declining` (line 47) records classifier calls and asserts `calls == []`. The new test asserts the same for a cancel, plus that the search node is reached. |
| Unit — reply content | `tests/unit/test_search.py` | Replaces the direct `_exit()` call with a dispatcher-level assertion, and pins that the reply names no collection and offers no further search (FR-003 / FR-007). |
| E2E — web | `frontend/mcm-app/tests/e2e/web/agent-search.spec.ts` | The existing cancel test, strengthened to assert the assistant's actual reply. |
| E2E — mobile | `frontend/mcm-app/tests/e2e/mobile/agent-search.yaml` | Parity check for FR-008 / US3. |

**Rationale**: every one of these files already exists and already covers this flow; the work is
tightening what they assert, not building a new harness. Constitution *Test Type Integrity* is
satisfied — these are genuinely unit tests of pure functions with injected stubs, and the E2E
mocks nothing.

**No golden-tier work.** The fix removes the classifier from this path entirely, so there is no new
model decision to record. Adding a golden pair here would assert the opposite of what the feature
requires.

---

## Open questions

None. No `NEEDS CLARIFICATION` remains.
