# Implementation Plan: Keep the terminal run error sanitised across agent-runtime upgrades

**Branch**: `079-run-error-sanitiser` | **Date**: 2026-10-04 | **Spec**: [spec.md](./spec.md)

## Summary

Move the sanitising seam one level **inward**, from the runtime's public `run()` to the stream it
iterates (`_handle_stream_events`), so our handler converts the exception before 0.0.46's new
handler can see it. Keep a guard on the way **out** of `run()` that rewrites any `RUN_ERROR` this
repository did not build. Approach (a) from item #641. The pin (approach b) is rejected in the
spec's Assumptions.

## Technical Context

- **Language**: Python 3.14, `agents/movie-assistant`
- **Libraries**: `ag-ui-langgraph` (0.0.45 on `main`, 0.0.46 in PR #638), `copilotkit`
  (`LangGraphAGUIAgent`, which overrides `run` and `_dispatch_event` but not `_handle_stream_events`),
  `ag-ui-protocol` (`RunErrorEvent`, `RunStartedEvent`)
- **Tests**: `pnpm nx test movie-assistant` (unit), `pnpm nx run movie-assistant:test:integration`
- **Lint**: `pnpm nx lint movie-assistant` (ruff + mypy --strict on `src`)
- **No dependency change.** `pyproject.toml` and `uv.lock` are untouched; #638 carries the bump.

## Design

The call chain, outermost first:

```
IdentityAwareAGUIAgent.run          ← (2) outbound guard: rewrite any foreign RUN_ERROR
  LangGraphAGUIAgent.run (copilotkit)   filters None events
    LangGraphAgent.run (ag-ui-langgraph) ← 0.0.46: except Exception → RUN_ERROR(str(exc)) + logger.exception
      IdentityAwareAGUIAgent._handle_stream_events  ← (1) NEW: convert the exception here
        LangGraphAgent._handle_stream_events   re-raises (both versions)
```

1. **`_handle_stream_events` override** (FR-001, FR-002, FR-004, FR-005, FR-006). Iterate the base
   generator, tracking whether `RUN_STARTED` and a terminal event have passed. On `Exception`:
   - terminal already sent → `raise` (the runtime's own rule; no second terminal);
   - otherwise log once through `log_provider_error` (facts only), yield `RUN_STARTED` if the run had
     not started, then yield the sanitised `RUN_ERROR`.
   The exception then never reaches the runtime's handler, so its `logger.exception` never fires
   (FR-004). `BaseException` subclasses pass through (FR-006).
2. **The sanitised event is a marker subclass** `SanitisedRunErrorEvent(RunErrorEvent)` with no extra
   fields, so it serialises identically and `run()` can recognise its own events with `isinstance`
   rather than by matching message text.
3. **`run()` outbound guard** (FR-003). Every `RUN_ERROR` that is not a `SanitisedRunErrorEvent` is
   replaced by a copy with a fixed message (`agent run failed: upstream error`) and `raw_event=None`
   (keeping `code` and `usage`). The existing `except Exception` stays: on 0.0.45 an exception raised
   in the runtime's `run()` outside the stream still escapes, and it still must not abort the socket.
4. **One builder** `_sanitised_run_error(exc)` shared by (1) and the `run()` except, so the two
   message formats cannot drift.

**Why not filter only in `run()`**: on 0.0.46 the exception is gone by then. Only the generic message
would be possible, losing the provider facts the item requires, and the log leak would remain.

**Risk: overriding a private method.** If a future runtime renames `_handle_stream_events`, the
override goes dead. The outbound guard still prevents the client leak, and the integration test's
facts assertion fails, which turns the regression into a red gate rather than a silent leak.

## Constitution Check

- Test-first: every behaviour gets a RED before its implementation (tasks.md).
- Repository code only, no library patch (065 FR-007).
- Logging: no new log fields; the one record is `log_provider_error`'s.

## Verification

- RED→GREEN on 0.0.46 (PR #638's `uv.lock` checked out temporarily into the worktree, never
  committed), then GREEN on 0.0.45 (`main`'s lock).
- `nx lint`, `nx test`, `nx run …:test:integration` for `movie-assistant`; watch the skip count.
- CI: `app-e2e › agent-integration` on the fix PR (0.0.45), then on #638 after merging `main` in
  (0.0.46).
