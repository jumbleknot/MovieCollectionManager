# Feature Specification: a turn is never silently dropped, and a gate never waits on a branch

**Feature Branch**: `337-turn-delivery-and-branch-waits`

**Created**: 2026-09-02

**Status**: Draft

**Input**: Backlog item **#337** (`node scripts/backlog.mjs show 337`), raised to p1 after it blocked
two consecutive pull requests (#336, #339). Related: item **#323** (the tier split and the prose
rule), item **#326** (the step ceiling that made the 45-minute mobile burn diagnosable).

## Context

Item #337 was filed on a premise: that a `@gate` test waiting for `selection-options` is waiting for
**the model to take the disambiguation branch**, and that the branch is a legitimate model decision.
Investigating before designing showed the premise is wrong in a way that changes the fix.

### The branch is decided by PURE CODE, in all three cases

| flow | what decides whether `selection-options` renders |
| --- | --- |
| `agent-import-disambiguate` | `resolve_tab_collection` (`nodes/import_collection.py`) — asks whenever the tab name has **0 or >1** exact case-folded collection matches. A tab named `unmatched-<epoch>` can only ever be 0. |
| `agent-navigate-collection` | `_resolve_collection` (`nodes/navigator.py`) — returns a target only when `len(matches) == 1`. Two `<prefix>`-matching collections force the ask. |
| `agent-card-navigate` | `_run_owned` (`nodes/search.py`) — emits `render_selection` on **both** branches, matches and no-matches alike. There is no resolve-directly path at all. |

The only model input anywhere in these three flows is the **supervisor's intent classification**
(`graph.py`), which decides *which node answers*, not what that node then renders.

So "the agent sometimes chooses to resolve directly" does not describe what is happening. Something
else is stopping the turn from reaching the node.

### The turn is being dropped in the CLIENT, before it is ever sent

Features 053 and 054 fixed exactly this defect once already: a message sent while the assistant was
still answering was silently lost. The fix was a queue in `useAssistantRun` (`hooks/use-assistant.tsx`)
that holds the message and flushes it from an effect when the run completes.

**That fix was applied to two of the five assistant send paths.** Three still hold their own
`useAgent` handle and return early when the agent is busy:

| component | line | what is lost |
| --- | --- | --- |
| `request-import-file.tsx` | `if (!ok || !agent || agent.isRunning) return;` | the import turn, **after** the upload has already succeeded |
| `disambiguation-options.tsx` | `if (!agent \|\| isRunning) return;` | a disambiguation pick (the `disambig-option-N` tap) |
| `render-movie-card.tsx` | `if (actioned \|\| !agent \|\| (agent.isRunning ?? false)) return;` | a card action |

`selection-options.tsx` and `multi-select-options.tsx` already route through `useAssistantRun`.

The captured client evidence from run 2541 fits this exactly. For the failing
`agent-import-disambiguate` attempt: a `/agent/run` was already in flight at `49.183`, the upload
completed at `49.241`, and **there is no `/agent/run` POST afterwards** — the ring is marked
`complete — nothing dropped`. The file was staged server-side and no turn was ever sent to consume
it. The spec then waited 150 s for an element that could not appear.

The same run's gateway log contains exactly **one** `import_collection parse_spreadsheet` for what
should have been up to four import turns (two import specs x two attempts).

### Why nobody could tell

`record_turn(intent)` (`observability.py`) is an OTel counter. The classified intent is written to no
log, so a failure bundle cannot distinguish "the supervisor routed this elsewhere" from "the node
took the other branch" from "the turn never arrived". Three sessions have now guessed at this class
because the instrument to settle it does not exist.

### What this feature must not do

Reach green by weakening what the gate proves. Item #337's own criterion 4 states it: the behaviours
currently gated — the write landing in the **chosen** collection, tap-to-open-collection rather than
in-collection-search, the search-result deep link — must still be verified before merge, on some
surface.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A turn taken while the assistant is answering is delivered, not lost (Priority: P1)

A member taps "Choose file…", picks a spreadsheet, and the upload succeeds while the assistant is
still finishing its previous reply. The import turn is delivered when that reply completes. The
member is never left looking at a staged file and a silent dock.

The same holds for a disambiguation pick and a movie-card action.

**Acceptance scenarios**

1. **Given** the assistant is mid-answer, **when** a spreadsheet upload completes, **then** the
   import turn is queued and sent once the run finishes.
2. **Given** the assistant is mid-answer, **when** a disambiguation candidate is tapped, **then** the
   pick is queued and sent once the run finishes.
3. **Given** the agent registry is momentarily empty (the `runtime_info_fetch_failed` window), **when**
   any of these actions fires, **then** it self-heals on the next render rather than being dropped.
4. **Given** the queue is at its bound, **when** another action fires, **then** it is refused and
   surfaced — never silently displaced.

### User Story 2 - A failure bundle says which intent the supervisor chose (Priority: P1)

An engineer reading a failed `app-e2e` bundle can tell, without re-running anything, whether a turn
reached the node it should have. This is the instrument whose absence is why item #337 was filed on
the wrong premise.

**Acceptance scenarios**

1. **Given** a classified turn, **when** the gateway logs, **then** the line names the classified
   intent and the node it routed to.
2. **Given** a turn that ends without classification (kill switch, degraded, noop), **when** the
   gateway logs, **then** that outcome is named too — a missing line must not be ambiguous with a
   missing turn.
3. The line carries no user text, no titles and no identifiers beyond the thread id — the
   never-log list in `openwiki/invariants/logging-and-audit.md` still holds.

### User Story 3 - There is a supported way to wait for "the assistant answered", on both surfaces (Priority: P1)

A `@gate` web spec and a Maestro flow can both wait for the turn to complete without asserting which
branch it took, and then continue into whichever branch appeared.

**Acceptance scenarios**

1. **Given** a web `@gate` spec, **when** it needs to wait for a turn, **then** a shared helper waits
   on a model-invariant signal (the reply count rising) rather than on a branch-specific testid.
2. **Given** a Maestro flow, **when** it needs the same, **then** a reusable sub-flow expresses it —
   Maestro has no helper functions, so the mechanism must be a flow file.
3. **Given** either surface, **when** the turn completes, **then** the flow can take a
   branch-adaptive continuation whose **end state** is asserted identically either way.

### User Story 4 - The grandfathered allowlist is empty (Priority: P2)

`KNOWN_BRANCH_WAITS` in `scripts/__tests__/agent-test-classification.test.mjs` names three files. When
this feature lands the list is empty and the guard still passes, both of its assertions intact: no new
branch wait may enter `@gate`, and a stale entry still fails.

---

## Requirements *(mandatory)*

### Functional

- **FR-001** Every assistant send path MUST route through `useAssistantRun` (`hooks/use-assistant.tsx`).
  No component may hold its own `useAgent` handle and return early on `isRunning`.
- **FR-002** `request-import-file.tsx` MUST NOT drop the import turn after a successful upload. The
  upload has already changed server state; dropping the turn strands it.
- **FR-003** `disambiguation-options.tsx` and `render-movie-card.tsx` MUST behave identically.
- **FR-004** A component MUST NOT fire the same action twice as a consequence of being queued —
  the existing `actioned` latch semantics are preserved.
- **FR-005** The gateway MUST log the classified intent and the routed node once per turn, at INFO.
- **FR-006** Non-classifying outcomes (`disabled`, `degraded`, `noop`, an early `search` short-circuit)
  MUST be logged with the same shape, so absence of a line means absence of a turn.
- **FR-007** The intent line MUST NOT contain user-authored text.
- **FR-008** A shared web helper MUST express "wait until the assistant has answered this turn",
  implemented as the reply-count rise that item #323 established.
- **FR-009** A reusable Maestro sub-flow MUST express the same wait for the mobile suite.
- **FR-010** The three `@gate` web specs MUST assert their end state on a path that does not require
  the selection branch to have been taken, while still asserting the branch's behaviour when it is.
- **FR-011** The three mobile flows MUST do the same.
- **FR-012** `KNOWN_BRANCH_WAITS` MUST be empty, and the guard's meta-tests MUST still demonstrate
  that the detector fires — an empty allowlist must not be reachable by the detector having stopped
  matching.
- **FR-013** No spec or flow may be skipped, deselected or deleted to reach green (051 SC-001,
  054 FR-017).

### Non-functional

- **NFR-001** The measured per-attempt failure rate for the affected specs MUST be re-taken after the
  change, on one unchanged tree, with `--retries=0`, and recorded on item #337 **with the worker
  count stated**.
- **NFR-002** A local subset pass is not evidence about a change to a shared hook (measured on
  feature 053: 6/6 unit and 5/5 E2E, then 28 and 26 failures). The full web E2E gate tier must run.

## Success Criteria

- **SC-001** `KNOWN_BRANCH_WAITS` is `[]` and `node --test scripts/__tests__/agent-test-classification.test.mjs`
  passes.
- **SC-002** No component outside `hooks/use-assistant.tsx` calls `copilotkit.runAgent`.
- **SC-003** A gateway log line names the classified intent for every turn.
- **SC-004** The three affected specs are re-measured over repeated runs on one unchanged tree, and
  the rate with its worker count is recorded on item #337.
- **SC-005** The three behaviours item #337 lists as currently gated are still asserted pre-merge.

## Out of scope

- The mobile flows are **not** empirically re-measured in this feature: the Android emulator needs
  `/dev/kvm`, which the Docker Sandbox microVM devcontainer cannot provide
  (`openwiki/runbooks/android-emulator.md`). The flows are changed and the reasoning is recorded;
  item #337 must say plainly that the mobile half was not measured.
- The supervisor's intent classification itself. This feature makes it observable, not deterministic.
