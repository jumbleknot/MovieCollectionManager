# Feature Specification: Keep the terminal run error sanitised across agent-runtime upgrades

**Feature Branch**: `079-run-error-sanitiser`

**Created**: 2026-10-04

**Status**: Draft

**Input**: Backlog item #641 — "ag-ui-langgraph 0.0.46 forwards str(exc) in RUN_ERROR — bypasses the
FR-010 sanitiser, blocks lock refresh #638".

## Measured Baseline *(evidence for every claim in this spec)*

Measured 2026-10-04 in a worktree of `origin/main` @ `348068e4`, with the gateway's integration
suite (`tests/integration/test_gateway_provider_error.py`) plus the run-override unit tests
(`tests/unit/test_agui_identity.py`):

| Agent runtime (`ag-ui-langgraph`) | Lock | Result |
|---|---|---|
| 0.0.45 | `main` | 5 passed (integration file alone), 0 skipped |
| 0.0.46 | PR #638's `uv.lock` @ `3fdf4a30` | **1 failed**, 18 passed — `assert 'Nosferatu' not in 'data: {"typ...collection"}'` |

**What changed in the runtime.** The PyPI wheels of 0.0.45 and 0.0.46 differ in `agent.py` by one
hunk: `LangGraphAgent.run()` now wraps its stream in its own `except Exception` that yields
`RunErrorEvent(message=str(exc) or type(exc).__name__)` (re-raising only if a terminal event was
already sent). That handler sits *inside* the call our sanitising override (feature 065, FR-010)
wraps, so our handler never sees the exception any more.

**A second leak, not named in the item.** The same handler also calls
`logger.exception("LangGraph run failed")`, which writes the provider's message — member text — into
the gateway's log through the traceback. Measured: the leaked title appears in the captured log of
the failing run. That breaks feature 065's FR-004 / the never-log list just as the client-side leak
breaks FR-010.

**A third path, pre-existing in both versions.** When the graph stream itself delivers an upstream
`error` event, the runtime emits `RUN_ERROR` with that event's message and the raw event attached.
Nothing in this repository sanitises it today.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — A provider failure still tells the member nothing about their own data (Priority: P1)

A provider refuses a request and echoes request content in its error message. The member's client
receives a terminal error that names the provider status and error type, and the exception class,
and never the echoed content, whatever version of the agent runtime is installed.

**Why this priority**: it is the only blocker on the Python lock refresh (#638), and the leak crosses
the network to a client.

**Independent Test**: inject a provider 400 whose message names a film, stream one turn over real
HTTP, and inspect the terminal event.

**Acceptance Scenarios**:

1. **Given** the agent runtime at 0.0.46 or later, **When** a node raises a provider 400 whose
   message contains member text, **Then** the stream ends with exactly one `RUN_ERROR` whose message
   contains no member text.
2. **Given** the same failure, **When** the client reads the `RUN_ERROR`, **Then** it carries the
   provider status (`400`) and error type (`invalid_request_error`).
3. **Given** the runtime emits a `RUN_ERROR` of its own (one this repository did not build), **When**
   it passes out of the gateway, **Then** its message is replaced by a fixed, content-free one.

### User Story 2 — The gateway log stays free of member text on the error path (Priority: P1)

**Independent Test**: the same injected failure, with the gateway's log captured.

**Acceptance Scenarios**:

1. **Given** the agent runtime at 0.0.46 or later, **When** a node raises a provider 400 whose
   message contains member text, **Then** no gateway log record contains that text, and one record
   names the provider status, type and exception class.

### User Story 3 — The 065 error-path guarantees are unchanged (Priority: P1)

**Acceptance Scenarios**:

1. **Given** a provider 400, **Then** the stream closes cleanly with a `RUN_ERROR`, within the
   existing fail-fast bound.
2. **Given** a non-provider exception, **Then** the stream also closes with a `RUN_ERROR`, coded as
   unexpected, not as a provider status.
3. **Given** a successful run, **Then** it ends `RUN_FINISHED` with no `RUN_ERROR`.
4. **Given** a cancelled run, **Then** nothing is yielded into the cancelled generator.
5. **Given** a failure before the run has started, **Then** the client still sees `RUN_STARTED`
   before `RUN_ERROR` (the protocol requires a started run before a terminal).

### Edge Cases

- A failure after a terminal event was already sent: no second terminal is emitted.
- The older runtime (0.0.45), where the exception still escapes the runtime's `run()`: behaviour is
  identical to the new runtime.
- A failure raised inside the runtime's `run()` before its stream begins (input conversion): the
  runtime's own `RUN_ERROR` is replaced per US1-AC3. Its log record is outside this repository's
  reach; no provider call has happened at that point, so it cannot carry a provider echo.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001** An exception raised by the graph stream MUST be converted to the sanitised terminal
  `RUN_ERROR` *before* the agent runtime's own handler can see it, so the provider facts are kept.
- **FR-002** The sanitised `RUN_ERROR` MUST carry the provider status, error type and exception class
  for a provider HTTP error, and the exception class only otherwise (065 FR-003, FR-010).
- **FR-003** Any `RUN_ERROR` leaving the gateway that this repository did not build MUST have its
  message replaced by a fixed, content-free message and its raw event removed.
- **FR-004** No gateway log record on the error path MUST contain the provider's message.
- **FR-005** If no `RUN_STARTED` has been emitted when the failure occurs, one MUST be emitted before
  the `RUN_ERROR`. If a terminal event was already emitted, no second terminal may follow.
- **FR-006** `CancelledError` / `GeneratorExit` MUST NOT be converted (065 FR-008).
- **FR-007** The fix MUST live in repository code, not in a patch to the agent runtime (065 FR-007),
  and MUST behave identically on 0.0.45 and 0.0.46.
- **FR-008** A successful run MUST be unchanged (065 FR-009).

### Key Entities

- **Terminal run error**: the `RUN_ERROR` event that ends an AG-UI stream; crosses the network to the
  member's client.

## Success Criteria *(mandatory)*

- **SC-001** With PR #638's lock (runtime 0.0.46), the full provider-error integration file passes,
  including `test_the_terminal_error_message_leaks_no_member_text`, with 0 skipped.
- **SC-002** The same file passes on `main`'s lock (runtime 0.0.45).
- **SC-003** PR #638 (or its successor lock-maintenance PR) is green on `agent-integration`, with
  `app-e2e` having actually run.

## Assumptions

- The agent runtime's private stream method (`_handle_stream_events`) keeps re-raising. If a future
  runtime catches inside it instead, FR-003 still prevents the leak (at the cost of the provider
  facts), and the integration test's facts assertion (US1-AC2) fails loudly, rather than the leak
  returning silently.
- Holding the runtime below 0.0.46 was considered and rejected as the fix: it unblocks #638 only by
  forgoing the upgrade, and leaves the next upgrade to rediscover the same break.
