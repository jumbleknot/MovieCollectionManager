# Tasks: 065 — a provider non-2xx is named, and terminates the stream

**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Item**: #325

Every test task records **Verify RED** then **Verify GREEN**
(`openwiki/process/test-authoring-conventions.md`). Both fixes touch already-shipping code, so RED
is a real failing assertion — never a collection error.

**Instrument warning for RED runs.** `pytest -k` is safe here, but
`node --test <file> --test-name-pattern` is not (CLAUDE.md); nothing in this feature uses the latter.
A RED run must show the assertion failing, not the module failing to import.

## Phase 1 — the description helper (US1, FR-001 … FR-004)

- **T001** [RED] `tests/unit/test_provider_errors.py`: `describe_provider_error` returns
  `status=400, type="invalid_request_error"` for a real `anthropic.BadRequestError` built from a
  real `httpx.Response(400, json=<the credit-balance body>)`. Expect RED — the module does not exist
  yet, so add the assertions alongside T002's skeleton rather than as a collection error.
- **T002** [GREEN] `src/provider_errors.py` — `ProviderError`, `describe_provider_error`,
  `log_provider_error`. Duck-typed; no provider SDK import at module scope.
- **T003** [RED→GREEN] the same for `RateLimitError` (429 `rate_limit_error`) and a 529
  `overloaded_error` — SC-001's "distinguishable" is asserted as *both fields differ*, not as
  "an error was returned".
- **T004** [RED→GREEN] a plain `ValueError` yields `kind="unexpected"`, `status=None`, `type=None`
  (FR-003) — no fabricated status. Also: a provider error whose `body` is absent or not a mapping
  still yields its status and does not raise.
- **T005** [RED→GREEN] `log_provider_error` emits exactly ONE record, at ERROR, whose message names
  status, type and frame — and contains neither the user text nor any request body (FR-004).

## Phase 2 — the swallowing frame is named (US1, FR-005)

- **T006** [RED] `tests/unit/test_graceful_degradation.py`: a classifier raising a provider 400
  produces one ERROR record naming `400` and `invalid_request_error`. Expect RED against today's
  silent `except`.
- **T007** [GREEN] `graph.py` `_classify` calls `log_provider_error(..., frame="classifier")` inside
  its existing handler, above the unchanged three statements.
- **T008** [GREEN, regression] the same turn still returns `intent="degraded"`, still resets the add
  state, still records the breaker failure. FR-005 is a guarantee that nothing moved — assert it,
  do not assume it.

## Phase 3 — the terminal event (US2, FR-006 … FR-010)

- **T009** [RED] `tests/integration/test_gateway_provider_error.py`: real `build_app` over a real
  uvicorn loopback server; a graph node raises the real 400. Assert the client receives a
  `RUN_ERROR` event and the stream closes cleanly. Expect RED with
  `RemoteProtocolError: peer closed connection without sending complete message body` — the measured
  behaviour today.
- **T010** [GREEN] `agui_identity.py` — `IdentityAwareAGUIAgent.run()` override: `except Exception`
  (never `BaseException`), log via `log_provider_error(frame="stream")`, yield `RunErrorEvent`.
- **T011** [RED→GREEN] **the fail-fast assertion** (SC-002): the terminal event arrives within
  **10 s**, asserted as a bound against the 150 s UI timeout that made run 2450 undiagnosable.
  This is the assertion item #325 asks to be settled in the spec rather than improvised — a test
  that only checks "an error appeared" passes against the hang and must not be written.
- **T012** [RED→GREEN] the success path is unchanged (FR-009): an echo graph still ends in
  `RUN_FINISHED` and emits no `RUN_ERROR`.
- **T013** [GREEN] FR-008: a cancelled/disconnected client unwinds without yielding into a cancelled
  generator. Asserted at the unit level against the override — `CancelledError` propagates and no
  `RunErrorEvent` is produced.

## Phase 4 — tiers and the record

- **T014** `nx test movie-assistant` and `nx lint movie-assistant` both green. Ruff is not optional
  here: CLAUDE.md records eight findings from a session that ran the test tier and not the lint tier.
- **T015** Record the outcome on item #325 — the two remaining criteria, the frame the investigation
  actually found, and the measured fail-fast number. Close only if both criteria are met; if the
  injected-400 test cannot demonstrate fail-fast, say so and leave the item open.
