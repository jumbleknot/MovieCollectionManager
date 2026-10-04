# Tasks: Keep the terminal run error sanitised across agent-runtime upgrades

**Input**: [spec.md](./spec.md), [plan.md](./plan.md)

**Tests**: Mandatory (TDD), per `docs/templates/feature-test-tasks-template.md`.

## Path Conventions

- Source: `agents/movie-assistant/src/agui_identity.py`
- Unit: `agents/movie-assistant/tests/unit/test_agui_identity.py`
- Integration: `agents/movie-assistant/tests/integration/test_gateway_provider_error.py`

### Running against runtime 0.0.46 before #638 merges

From `agents/movie-assistant` in the worktree:

```bash
git show 3fdf4a30:agents/movie-assistant/uv.lock > uv.lock && uv sync --frozen   # 0.0.46
git checkout -- uv.lock && uv sync --frozen                                        # back to 0.0.45
```

The lock swap is **never committed**. `nx test` excludes the integration tier; use
`test:integration`, and read the skip count, because a skip reads as a pass.

---

## Phase 1: User Stories 1 and 2 — no member text to the client or the log (P1)

### T001 — Pin the provider facts and the clean log in the integration file

**Type**: Test | **Time**: 20 min | **Risk**: Low

**Spec reference**: US1-AC1, US1-AC2, US2-AC1

**File(s)**: `tests/integration/test_gateway_provider_error.py`

Extend `test_the_terminal_error_message_leaks_no_member_text` to assert that the `RUN_ERROR` carries
`status=400` and `type=invalid_request_error`. Add `test_the_gateway_log_carries_no_member_text`:
the same injected 400 with `caplog` at DEBUG. No record may contain the leaked title, and one record
must name the status.

**Verify RED** (on 0.0.46):
```bash
uv run --frozen pytest tests/integration/test_gateway_provider_error.py -q -rs
```
**Expected RED**: 2 failing — `assert 'Nosferatu' not in …` (both the stream and the log).

### T002 — Pin the two seams at unit level

**Type**: Test | **Time**: 30 min | **Risk**: Low

**Spec reference**: US1-AC3, US3-AC4, US3-AC5, edge case "after a terminal"

**File(s)**: `tests/unit/test_agui_identity.py`

- a foreign `RUN_ERROR` (message with member text, a `raw_event`) yielded by the base `run()` comes
  out with the fixed message and no raw event;
- `_handle_stream_events`: a provider 400 before `RUN_STARTED` yields `RUN_STARTED` then a sanitised
  `RUN_ERROR` carrying the facts; after `RUN_STARTED`, only the `RUN_ERROR`;
- a failure after a terminal event re-raises (no second terminal), at the inner seam and again at
  `run()` (on both runtimes the inner re-raise escapes the runtime's `run()` and reaches ours);
- `CancelledError` from the stream is not converted.

**Verify RED** (either runtime, since these test seams that do not exist yet):
```bash
uv run --frozen pytest tests/unit/test_agui_identity.py -q
```
**Expected RED**: the new tests fail. The base `_handle_stream_events` raises instead of yielding,
and the foreign message passes through unchanged.

**Observed** (2026-10-04, runtime 0.0.46): 5 failed with T001's 2. The inner after-terminal test and
the cancellation test passed before T003 because no override existed yet. They were proven by
mutation RED instead: dropping `if terminal: raise` and widening `except Exception` to
`BaseException` each turned exactly its test red. The outer after-terminal test was added after
T003's first pass and observed RED (`1 failed`) before its guard was written.

### T003 — Implement the inward seam and the outbound guard

**Type**: Implementation | **Time**: 45 min | **Risk**: Medium

**Prerequisite**: T001 and T002 verified RED.

Per plan.md Design 1–4, in `src/agui_identity.py`.

**Verify GREEN** (on 0.0.46, then again on 0.0.45):
```bash
uv run --frozen pytest tests/integration/test_gateway_provider_error.py tests/unit/test_agui_identity.py -q -rs
```
**Expected GREEN**: 0 failures, 0 skipped, on both runtimes. **Observed**: 26 passed on 0.0.46 and on 0.0.45.

**Also run the touched tiers**:
```bash
pnpm nx lint movie-assistant && pnpm nx test movie-assistant && pnpm nx run movie-assistant:test:integration
```

---

## Phase 2: Land and unblock

- [ ] T004 Open the fix PR from a real branch, wait for green with `app-e2e` actually run, and merge.
- [ ] T005 Merge `main` into #638's branch, push, and confirm the branch head is ours afterwards
      (Renovate can regenerate it). Wait for green, check that `agent-integration` ran, and merge.
- [ ] T006 Close item #641 with what was verified.

## Completion Checklist

- [x] Every test above was observed RED (directly or by mutation) before its implementation
- [x] GREEN on 0.0.46 and on 0.0.45, 0 skipped
- [x] ruff + mypy clean
- [x] No `uv.lock` / `pyproject.toml` change in the fix PR
