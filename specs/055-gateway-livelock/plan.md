# Implementation Plan: the agent gateway wedges at 100% CPU and reports itself healthy

**Branch**: `054-app-e2e-reliability-cluster` (shared) | **Date**: 2026-08-12 | **Spec**: [spec.md](./spec.md)

## Summary

Three stories, and the ordering is the whole design: make the wedge **visible** (US1), then **capture**
it (US2), then **fix what the capture names** (US3). US3 is evidence-gated and must not be started
before US2 produces a stack — a fix for an unobserved cause is indistinguishable from a change that
moves the symptom, which is the error this repository has made repeatedly.

## Technical Context

| | |
| --- | --- |
| **Surface** | `agents/movie-assistant/src/gateway.py` (uvicorn factory), `infrastructure-as-code/docker/agents/compose.prod.yaml`, `scripts/` (the capture watcher) |
| **Runtime** | Python 3, FastAPI + uvicorn, single process, asyncio single-threaded; `ag_ui_langgraph` bridges LangGraph over AG-UI/SSE |
| **Observed** | one core at 100.4%, memory 1%, `/health` timing out, logs stale, `RestartCount=0` |
| **Reproduction** | 3 of 3 full web-E2E suites, appearing after ~one suite's worth of agent traffic |
| **Tests** | `pnpm nx test:unit movie-assistant` / `test:integration movie-assistant`; the capture is verified against a deliberately wedged process |

## Constitution Check

| Principle | Bearing | Verdict |
| --- | --- | --- |
| **No Vibe Coding** | US3 is gated on a captured stack; the plan refuses to name a cause before US2 runs. | Pass |
| **Behavior-Descriptive Identifiers** | New symbols name behaviour (`install_stack_dump_signal`, `capture-gateway-wedge.sh`). | Pass |
| **Logging — never log credentials** | FR-008: a stack dump prints frames and locals-free tracebacks only; the watcher captures `/health`, `docker stats` and the dump, never env. | Pass — pinned |
| **Safe Error Responses** | The dump goes to the container's own stderr and to a scratch file, never to an HTTP response. | Pass |
| **Documentation** | `docs/runbooks/e2e-testing.md` gains the one-command recipe as part of the work. | Pass |

---

## US1 — A wedged gateway cannot pass for a healthy one

**Healthcheck on the service.** `movie-assistant-gateway` has none today, which is why `docker ps`
prints a bare `Up` for a process answering nothing. It exposes `GET /health` already
([gateway.py](../../agents/movie-assistant/src/gateway.py)), so the check is a request against it.

The image is `python:*-slim`-derived and has no `curl`. Rather than adding a package for a healthcheck,
the probe runs the interpreter already present:

```yaml
healthcheck:
  test: ["CMD", "python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8000/health', timeout=4).status==200 else 1)"]
  interval: 30s
  timeout: 5s
  retries: 3
  start_period: 40s
```

**30 s, not 5 s** (FR-003): the probe runs *inside* the wedged process's container but as a separate
process, so it costs a fork and a socket — cheap, but a single-threaded event loop under E2E load is
exactly where a needless probe becomes the perturbation the spec warns about. 30 s × 3 retries detects
a wedge inside ~90 s, which is far below the ~7-minute suite it needs to catch.

**Deliberately NOT `restart: always`-driven recovery** (FR-004). Docker does not restart merely-unhealthy
containers, and that is the behaviour we want: a wedged gateway must stay wedged and visible. Silently
recovering it would erase both the evidence and the incidence rate — the same objection this feature
raises against re-running a red suite.

Bring-up then gains `depends_on: { movie-assistant-gateway: { condition: service_healthy } }` where the
E2E stack composes it, so a run cannot start against a gateway that is not serving.

---

## US2 — The next wedge leaves a stack trace behind

Two mechanisms, deliberately, because they fail in different ways and the wedge is rare enough that a
missed capture costs a whole run.

### (a) In-process, signal-triggered — `faulthandler`

Registered at startup in `create_app()`:

```python
faulthandler.register(signal.SIGUSR1, all_threads=True, chain=False)
```

Then `docker kill -s USR1 movie-assistant-gateway` writes every thread's stack to the container's
stderr, where `docker logs` already collects it. No attach, no privileges, no tooling added at incident
time (FR-005).

**Why this works on a spinning event loop specifically**: `faulthandler` writes from the C signal
handler, so it does not need the interpreter to reach a safe point in Python-level scheduling — which
is exactly what a busy loop denies to anything scheduled on it.

It prints frames only — no locals, no environment — which is what makes it safe to leave enabled
permanently (FR-008).

### (b) Out-of-process — `py-spy`, from a sibling container

```bash
docker run --rm --pid=container:movie-assistant-gateway --cap-add SYS_PTRACE \
  benfred/py-spy dump --pid 1
```

Needs nothing in the image, and `py-spy top` additionally shows *where the CPU is going*, which for a
spin is the direct answer. Kept as the second mechanism because a rootless daemon may refuse
`SYS_PTRACE`; the spec records that as the assumption it is hedging.

### (c) The watcher — `scripts/capture-gateway-wedge.sh`

Armed before a suite, polls `/health`, and on the FIRST failure captures, in this order: the
`faulthandler` dump (via `docker kill -s USR1` then the tail of `docker logs`), a `py-spy dump`, a
`py-spy top` sample, `docker stats`, and `docker inspect`. Then it **stops** — one capture per run,
because the state persists and repeated dumps would bury the first.

It exits cleanly and says so when no wedge occurred (FR-007): an absent capture must never be
mistaken for a capture that found nothing. That distinction is the same `0`-vs-`unavailable` rule the
E2E tallies already enforce.

---

## US3 — The gateway cannot enter the state

**Deliberately unplanned.** The approach is whatever the captured stack names, and writing a candidate
fix here would invite implementing it before the evidence exists.

What is already ruled out, and must not be re-derived: memory exhaustion (1% of limit), a crash
(`ExitCode=0`, `RestartCount=0`), a deadlock or blocked await (a lock wait sits near 0% CPU, not
100%). The last logged activity on two of three occasions was `agent_tool_call agent=organizer
tool=add_movie status=ok` followed by an Anthropic `200`, so the wedge follows a tool-calling turn —
recorded as a starting point for reading the stack, **not** as a hypothesis to test first.

## Verification

| Claim | Standard |
| --- | --- |
| The healthcheck reports a non-serving gateway | Wedge it artificially (`docker pause`) and read `docker ps` — a real wedge is not needed to prove the probe works |
| Bring-up refuses an unhealthy gateway | Same artificial state, then run bring-up |
| The dump mechanism works | Trigger `SIGUSR1` against a HEALTHY gateway and confirm a full stack reaches `docker logs` — proves the mechanism before it is needed |
| The watcher captures a real wedge | One full suite with the watcher armed |
| The fix holds | **Two consecutive full suites without restarting the gateway** (SC-004) — the reproduction is load-driven, so one is not a sample |

## Risks

| Risk | Mitigation |
| --- | --- |
| The wedge does not reproduce during the capture run | Report it uncaptured; leave US3 unstarted. 3-of-3 is three samples, not a guarantee |
| The rootless daemon refuses `SYS_PTRACE` | `faulthandler` is the primary mechanism precisely because it needs no privilege |
| The healthcheck perturbs the event loop | 30 s interval; the perturbation question is asked against the suite's own wall clock, as 054's T019 did for its capture |
| The spin is inside a dependency | Then the fix is a usage change or a pin, stated as such rather than patched into a vendored copy |
