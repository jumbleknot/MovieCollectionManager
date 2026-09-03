# Implementation Plan: 065 — a provider non-2xx is named, and terminates the stream

**Spec**: [spec.md](./spec.md) · **Item**: #325 (p2) · **Created**: 2026-09-03

## Approach in one line

Add one provider-error description helper, call it from the frame that swallows the error today
(`_classify`), and convert an escaping exception into a terminal `RUN_ERROR` at the one seam this
repository already owns — the `IdentityAwareAGUIAgent` subclass — so a refused provider call is
both named in the log and terminal on the wire.

## Why the description helper is shared rather than inlined twice

Frame A and Frame B catch the same exceptions and must produce the same two facts (status, type).
Inlining the extraction at both sites is how the two drift, and a drifted pair is worse than no line
at all: it invites the reader to conclude the shapes genuinely differ. One helper, two callers, and
the frame is a parameter.

## Design

### 1. `src/provider_errors.py` — one place that knows the shape (FR-001 … FR-004)

```
describe_provider_error(exc) -> ProviderError(status: int | None, type: str | None, kind: str)
```

Read by **duck typing, never by importing the provider SDK**. `models.py` lazy-imports
`langchain_anthropic` precisely so an Ollama-only deployment carries no Anthropic dependency; a
top-level `import anthropic` here would undo that and fail closed on the error path — the worst
possible place for an ImportError.

The two facts come from attributes both the Anthropic and OpenAI SDK error shapes expose:

| fact | source | fallback |
| --- | --- | --- |
| status | `exc.status_code`, else `exc.response.status_code` | `None` |
| type | `exc.body["error"]["type"]` | `None` |

`kind` is `provider_http` when a status was found and `unexpected` otherwise, which is what
satisfies FR-003: a bug in our own code is logged as a bug, not as a fabricated status.

`log_provider_error(logger, exc, *, frame)` writes the single ERROR record. It formats **status,
type, frame and the exception class only** — never `str(exc)` into the structured fields and never
the request body, because a provider echoes request content in some error messages and the
never-log list has no exception for the error path (FR-004).

The 400-is-operator-action vs 429/529-is-retry distinction is **not** re-derived here. The digest
half already owns that mapping (`e2e-turn-tally.sh`, PR #334) and two copies of a remediation table
is how they disagree. This layer emits the facts; the digest classifies them.

### 2. `graph.py` — name what the degradation is degrading from (FR-005)

`_classify`'s `except Exception` gains one `log_provider_error(..., frame="classifier")` call before
its existing three statements. The returned intent, the `_ADD_STATE_RESET`, the circuit-breaker
signal and `record_turn_failure()` are untouched — a graceful-degradation path whose behaviour
changes is a different feature, and the 064 `turn routed: intent=degraded` line still follows it.

The two lines together are the readable pair the 2450 bundle lacked:

```
ERROR src.provider_errors provider call failed: status=400 type=invalid_request_error frame=classifier exc=BadRequestError
INFO  src.graph turn routed: intent=degraded node=degrade thread=…
```

### 3. `agui_identity.py` — the terminal event (FR-006 … FR-010)

`IdentityAwareAGUIAgent` already subclasses `LangGraphAGUIAgent` to bridge identity at
`prepare_stream`. It overrides `run()` as well:

```
async def run(self, input):
    try:
        async for event in super().run(input):
            yield event
    except Exception as exc:
        log_provider_error(logger, exc, frame="stream")
        yield RunErrorEvent(type=EventType.RUN_ERROR, message=…, code=…)
```

Three properties, each load-bearing:

- **`except Exception`, deliberately not `BaseException`** — `CancelledError` and `GeneratorExit`
  inherit from `BaseException`, and yielding into a cancelled generator raises
  `RuntimeError: async generator ignored GeneratorExit`. This is the same reasoning the library
  applies at `agent.py:2136`, and FR-008 is exactly it.
- **It is our subclass, not a library patch** (FR-007). `endpoint.py` calls `agent.clone()` per
  request and `clone()` re-creates via `type(self)(...)`, so the override survives the per-request
  clone — the same mechanism that already keeps `prepare_stream` in place.
- **The message is the exception class and the provider facts, never `str(exc)` unfiltered**
  (FR-010), for the reason given in §1: this one crosses the network to a client.

**Measured feasibility, 2026-09-03**: this exact shape was probed against the real app under real
uvicorn. The aborted `RemoteProtocolError` became
`data: {"type":"RUN_ERROR","message":…,"code":"provider_error"}` with a clean close, in 0.340 s.
The design is not speculative.

### What this does NOT do

It does not wrap the domain nodes individually. A per-node `try` would have to be added to every
node and to every node added later, and the one that gets forgotten is the one that hangs. The
stream boundary is the single place every node's failure must pass through, so it is the place the
guarantee belongs.

## Test strategy

| tier | what it proves | how |
| --- | --- | --- |
| unit | FR-001 … FR-005 | `describe_provider_error` against real `anthropic` error objects for 400 / 429 / 529, a non-provider exception, and an exception with no body; `_classify` logs once and still degrades |
| integration | FR-006 … FR-009, SC-002 | real `build_app` + real uvicorn on a loopback port, real `httpx` client, a graph node raising the real 400 shape — asserts `RUN_ERROR`, a clean close, and the ≤ 10 s bound |

The integration test carries **no `@golden` marker and needs no model, no key and no network** — it
binds loopback and raises locally, so it runs in the ordinary unit/integration gate rather than the
model tier. That is deliberate: an error-path guarantee gated behind a live-model marker is a
guarantee that stops running the moment the tier is skipped.

`anthropic` is already a transitive dependency of `langchain-anthropic`, which is a direct
dependency — so constructing the real error shape in a test adds nothing to the lockfile.

## Risks

| risk | mitigation |
| --- | --- |
| `RunErrorEvent` import path differs across `ag_ui` versions | imported from `ag_ui.core`, the same module `agent.py` imports it from; a version bump that moves it breaks at import, loudly, in the unit gate |
| the override changes success-path behaviour | FR-009 is asserted directly — a successful run still ends `RUN_FINISHED` with no `RUN_ERROR` |
| a future node adds its own broad `except` and re-swallows | out of scope to prevent structurally; the ERROR line makes the next occurrence a one-line read rather than an hour |

## Files

| file | change |
| --- | --- |
| `agents/movie-assistant/src/provider_errors.py` | new — description + the single ERROR record |
| `agents/movie-assistant/src/graph.py` | one call in `_classify`'s existing `except` |
| `agents/movie-assistant/src/agui_identity.py` | `run()` override emitting the terminal `RUN_ERROR` |
| `agents/movie-assistant/tests/unit/test_provider_errors.py` | new — FR-001 … FR-004 |
| `agents/movie-assistant/tests/unit/test_graceful_degradation.py` | extended — FR-005, and that nothing else moved |
| `agents/movie-assistant/tests/unit/test_agui_identity.py` | extended — FR-008 (cancellation) and FR-010, at the override |
| `agents/movie-assistant/tests/integration/test_gateway_provider_error.py` | new — FR-006, FR-009, FR-010, SC-002 |

## As-built notes

Three things the implementation settled that the plan left open.

**FR-008 is pinned at the unit tier, not the integration tier.** A real client disconnect is hard to
provoke deterministically over loopback; the property that matters is which exception class the
override catches. `tests/unit/test_agui_identity.py` patches the base class's `run` and asserts a
`CancelledError` propagates un-converted. **Mutation-checked**: flipping `except Exception` to
`except BaseException` fails that test, so the guard demonstrably fires against the regression it
exists to catch.

**`super().run(...)` needs `# type: ignore[no-untyped-call]`.** `LangGraphAGUIAgent.run` carries no
annotations and `mypy --strict` (the second half of `nx lint movie-assistant`) rejects the call —
the same reason `gateway.py` imports `add_langgraph_fastapi_endpoint` under
`type: ignore[import-untyped]`.

**The tier that runs this is `test:integration`, not `test`.** `nx test movie-assistant` is
`pytest tests/unit` only; the new integration file runs via `app-ci.yml:618`
(`nx test:integration movie-assistant -- -m "not golden"`). Verified under that exact invocation:
5 passed, 0 skipped. Carrying no marker is what keeps it inside `not golden`.
