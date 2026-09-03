# Feature Specification: a provider non-2xx is named in the log and terminates the stream

**Feature Branch**: `325-provider-error-surfacing`

**Created**: 2026-09-03

**Status**: Draft

**Input**: Backlog item **#325** (`node scripts/backlog.mjs show 325`), the gateway half. The digest
half shipped in PR #334 (`scripts/` only, exempt from this gate). Related: item #337 / feature 064,
whose `turn routed:` line is the instrument this feature extends.

## Context

Item #325 was filed on a premise, and — as with #337 — investigating before designing showed the
premise is wrong in a way that changes the fix.

### The premise, and what was actually measured

The item states: *"The SSE stream stays open, the client waits"*, and *"After each 400 the gateway
logged nothing at all"*. The second is true. The first is an inference from outside, and it is
wrong.

The item's own evidence is what disproves it. Run 2450 recorded **zero ERROR, zero Exception, zero
Traceback** in `movie-assistant-gateway.log` for the whole run. An exception escaping a graph node
cannot be that quiet — measured below, it produces a full uvicorn traceback every time. So no
exception escaped, and the 400 was caught by something that logged nothing.

### Measured 2026-09-03, against the real `build_app` under a real uvicorn server

Two reproductions, both driving the actual gateway app with the real
`anthropic.BadRequestError` shape an exhausted credit balance returns.

| | **Frame A** — the 400 lands in the classifier | **Frame B** — the 400 lands in a domain node |
| --- | --- | --- |
| swallowing frame | `graph.py:362` `_classify`'s `except Exception` | none — it escapes to `ag_ui_langgraph/endpoint.py:25-32` |
| HTTP status | 200 | 200 |
| SSE lines | 22 | 4 |
| terminal event | `RUN_FINISHED` | **none** |
| client outcome | stream closed cleanly | `RemoteProtocolError: peer closed connection without sending complete message body` |
| ERROR log lines | **0** | 1 (a full uvicorn traceback) |
| lines naming the 400, the credit balance, or `invalid_request_error` | **0** | 0 |
| elapsed | 0.346 s | 0.666 s |

**Frame A is what happened at run 2450**, uniquely: it is the only one of the two that produces zero
tracebacks, which is what the item measured.

### What Frame A means

`_classify` catches *any* exception and returns `{"intent": "degraded"}` — a graceful-degradation
path added by T061/FR-018 so a provider outage becomes "I couldn't complete that" rather than a
crash. That is correct product behaviour and this feature does not remove it.

What is wrong is that it makes an **infrastructure failure indistinguishable from a product
outcome**. The run completes, answers 200, emits `RUN_FINISHED`, and reports success. `record_turn_failure()`
bumps an OTel counter and writes no log. Nothing anywhere names the status code, the error type, or
the fact that a third party refused the call.

The 150-second wait the item describes was therefore **not** a hung stream. The turn completed in
well under a second with a degraded reply; Playwright then waited its full timeout for
`request-import-file-choose`, an affordance a degraded reply never renders. Two tests × 150 s of
timeout, and every observable pointing at the UI — exactly as the item describes, for a different
reason than it assigns.

### What Frame B means

Frame B is a second, genuinely distinct defect that the item's criterion 2 names correctly. The
curator, organizer and query nodes each build a chat model (`runtime_nodes.py:105/117/129`) and none
is wrapped. A provider failure there escapes `_handle_stream_events` — which re-raises by design,
"for the existing run-level error handling" — into an `event_generator` already inside a
`StreamingResponse` whose 200 and headers are long since flushed. There is no run-level error
handling. The connection is aborted mid-chunk with **no terminal AG-UI event**.

A client that reconnects or waits on a terminal event, rather than on the socket, waits for its full
timeout. That is the hang the item describes, in the frame the item did not identify.

### Why both halves are in scope

Criterion 1 (an ERROR line naming status and type) is answered by Frame A. Criterion 2 (a terminal
error instead of a hang) is answered by Frame B. Fixing either alone leaves the other occurrence of
this class silent, and the two are one user-visible symptom.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A provider refusal is named in the log, at ERROR (Priority: P1)

An engineer reading `movie-assistant-gateway.log` after a failed run can tell that the model provider
refused the call, what status it returned, and which error type — without correlating an INFO-level
`httpx` line for a third-party host against test timestamps.

**Acceptance scenarios**

1. **Given** the classifier's model call fails with an HTTP 400 `invalid_request_error`, **when** the
   turn degrades, **then** exactly one ERROR record names status `400` and type
   `invalid_request_error`.
2. **Given** the same failure, **when** the turn degrades, **then** the degraded reply is still
   delivered — the log line is additive and changes no product behaviour.
3. **Given** a 429 `rate_limit_error` and a 529 `overloaded_error`, **when** each is logged, **then**
   the records are distinguishable from the 400 and from each other by status and type.
4. **Given** a failure that is not a provider HTTP error at all (a bug in our own code), **when** it
   is logged, **then** the record says so rather than inventing a status.
5. The record carries no user text, no titles, no credential material and no request body — the
   never-log list in `openwiki/invariants/logging-and-audit.md` holds unchanged.

### User Story 2 - The client is told the run failed, immediately (Priority: P1)

A caller streaming from the gateway whose turn dies on a provider refusal receives a terminal
`RUN_ERROR` event and can act on it. It never waits on a socket that will not speak again.

**Acceptance scenarios**

1. **Given** a provider 400 raised inside a domain node, **when** the caller streams the run,
   **then** it receives a `RUN_ERROR` event and the stream closes cleanly — no
   `RemoteProtocolError`, no truncated chunked body.
2. **Given** the same failure, **when** the caller measures elapsed time, **then** the terminal event
   arrives **an order of magnitude inside** the 150 s UI timeout that made the original occurrence
   undiagnosable. Asserted as a bound, not as "an error eventually appeared".
3. **Given** the same failure, **when** the gateway logs, **then** one ERROR record names the status
   and type, as in US1.
4. **Given** a run that succeeds, **when** it completes, **then** it still ends in `RUN_FINISHED` and
   emits no `RUN_ERROR` — the terminal path is not made lossy to fix the error path.
5. **Given** a client disconnect (`CancelledError` / `GeneratorExit`), **when** the generator unwinds,
   **then** nothing is yielded into a cancelled generator.

### US2 test design — settled here, not in the implementation

Item #325 flags this as the open design question, because criterion 2 wants **fail fast** and a test
that merely observes "an error appeared" would pass against the hang it exists to catch.

**Decision: a fake chat model raising the real `anthropic` exception shape, driven over a real HTTP
server, asserting a latency bound and a terminal event.** Rejected alternatives:

| option | why not |
| --- | --- |
| httpx transport mock | intercepts below the SDK, so the retry ladder (`max_retries=6`) runs inside the test — the thing that makes 429 and 529 slow. Latency stops being an assertion about our code. |
| existing cassette machinery | records and replays *successful* provider exchanges; there is no failure cassette, and adding one couples an error-path test to the golden tier's recording lifecycle. |
| a live out-of-credit account | not reproducible, and the only way to obtain it is the outage this feature exists to make legible. |

The fake raises `anthropic.BadRequestError` constructed with a real `httpx.Response(400, …)` and the
real error body, so `status_code` and `error.type` are read from the genuine attribute shape rather
than a stand-in the fix could accidentally be written against.

**The latency assertion is the point.** A bound of **≤ 10 s** is asserted, against a 150 s UI
timeout — a 15× margin, which is generous enough not to flake on a loaded CI runner and tight enough
that a regression to the hang fails it outright. The measured value today is ~0.35 s. The assertion
is a bound, never an equality.

### US3 - The three provider shapes stay distinguishable (Priority: P2)

An out-of-credit run, a rate-limited run and an overloaded run are told apart from each other and
from an app failure, from the gateway log alone.

**Acceptance scenarios**

1. **Given** each of 400 / 429 / 529, **when** logged, **then** the status and type are both present
   and differ.
2. The latency profiles differ by design and this feature does not change them: a 400 is
   non-retryable and fails on the first call; a 429/529 is retried up to `ANTHROPIC_MAX_RETRIES`
   (default 6, `models.py:160`) with exponential backoff, so it fails much later. The log line makes
   the shapes distinguishable regardless of how long each took.

---

## Requirements *(mandatory)*

- **FR-001** A provider HTTP error caught anywhere on the turn path MUST produce exactly one ERROR
  log record naming the HTTP status and the provider's error `type`.
- **FR-002** The record MUST name the frame that caught it, so Frame A and Frame B are told apart in
  a log.
- **FR-003** A non-provider exception MUST be logged as such, without a fabricated status.
- **FR-004** The record MUST contain no user text, no credential material and no request body.
- **FR-005** `_classify`'s graceful degradation MUST be preserved exactly — same intent, same reply,
  same circuit-breaker signal. Logging is additive.
- **FR-006** An exception escaping the graph MUST be converted to a terminal AG-UI `RUN_ERROR` event
  on the stream, after which the stream closes cleanly.
- **FR-007** The terminal event MUST be emitted from repository code, not by patching
  `ag_ui_langgraph`.
- **FR-008** `CancelledError` / `GeneratorExit` MUST NOT be converted — nothing may be yielded into a
  cancelled generator.
- **FR-009** A successful run MUST be unchanged: `RUN_FINISHED`, no `RUN_ERROR`.
- **FR-010** The `RUN_ERROR` message MUST NOT carry user text or credential material.

## Success Criteria *(mandatory)*

- **SC-001** Item #325 criterion 1 met: a provider non-2xx produces an ERROR line naming status and
  error type. Asserted for 400, 429, 529 and a non-provider exception.
- **SC-002** Item #325 criterion 2 met: an injected 400 produces a terminal `RUN_ERROR` within a
  10 s bound, asserted over a real HTTP server — not merely "an error appeared".
- **SC-003** A run that would have gone silent at 2450 now says, in one line, that the provider
  refused the call and why.
- **SC-004** No behaviour change on the success path, and no change to graceful degradation.

## Out of scope

- Retry-policy changes. `ANTHROPIC_MAX_RETRIES` and the 400/429/529 latency profiles are unchanged;
  this feature makes them *legible*, not different.
- BFF-side propagation of `RUN_ERROR` to the browser, and any UI rendering of it. The item's
  criteria are gateway-side; the BFF proxy is a separate component with its own tier.
- The digest half (criteria 3 and 4), shipped in PR #334.
