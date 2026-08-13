# Feature Specification: the agent gateway wedges at 100% CPU and reports itself healthy

**Feature Branch**: `054-app-e2e-reliability-cluster` (shared — see [Branching](#branching))

**Created**: 2026-08-12

**Status**: Draft

**Input**: Backlog item **#179** (`node scripts/backlog.mjs show 179`), filed 2026-08-12 during feature
054's local verification, after it invalidated three consecutive runs.

## Context

`movie-assistant-gateway` stops serving under sustained web-E2E agent load while reporting itself
healthy to every check that does not actually call it. Measured three times on 2026-08-12:

| | |
| --- | --- |
| `docker inspect .State.Status` | `running` |
| `.State.OOMKilled` | `false` |
| `.State.ExitCode` / `.State.RestartCount` | `0` / `0` |
| memory | **173 MiB / 15.5 GiB (1.09%)** |
| **CPU** | **100.4%** — one core, indefinitely |
| `/health` from inside the BFF container | **times out** |
| last log line | ~40 minutes stale, mid-run |

### The one inference the evidence supports

**100% CPU means a spin, not a deadlock.** A lock wait or an unresolved await sits near 0% CPU. One
core pegged with memory flat means something is executing a tight loop.

The gateway is a single uvicorn process and asyncio is single-threaded, so a spin *in the event loop*
starves every other coroutine on it — which is precisely why `/health` cannot be answered while the
process stays alive. Every other observation follows from that and none contradicts it.

**What is NOT established**: which loop. No stack dump was ever taken, and the host reboot on
2026-08-12 killed the wedged process (`Exited (255)`), destroying the only instance that existed.
This spec does not guess. US2 exists to capture the stack; US3 is gated on what it says.

### What it costs

It is indistinguishable from the outside from the intermittent whole-suite collapse tracked as #173 —
every agent/dock spec fails together, the dock shows an echoed message and no reply, and the gateway
receives a fraction of its usual turns. Two full local suites were measured against the dead process
before a liveness check caught it; both read `verdict=collapsed` from `scripts/e2e-turn-tally.sh`, one
with `gateway_posts=0`.

This is the trap `docs/runbooks/e2e-testing.md` already records — `Up 37 hours`, five specs
"reproduced deterministically" against a dead stack. It has now recurred three times, so it is a live
defect rather than a historical anecdote.

### Why `restart: always` does not help

The service sets it ([agents/compose.prod.yaml](../../infrastructure-as-code/docker/agents/compose.prod.yaml)),
and it is irrelevant here: the process never exits, so Docker never observes a failure to restart
from. `RestartCount=0` across every occurrence is that fact, measured.

There is **no healthcheck** on the gateway service. That is why `docker ps` prints a bare `Up` for a
process answering nothing, and it is the single change that would have saved three invalidated runs.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A wedged gateway cannot pass for a healthy one (Priority: P1)

Today a livelocked gateway is reported as `Up` by `docker ps`, satisfies the E2E stack bring-up, and
is indistinguishable from a working one until a test fails for reasons that look like an application
defect. Anyone — an engineer, a bring-up script, or CI — must be able to see that it is not serving.

**Why this priority**: It is deterministic, it ships regardless of what the cause turns out to be, and
it is what makes every later claim in this feature legible. It also unblocks feature 054's local
verification, which cannot distinguish its own changes from this defect.

**Independent Test**: Wedge or stop the gateway, then confirm `docker ps` reports it `unhealthy` and a
stack bring-up refuses to proceed rather than continuing against it.

**Acceptance Scenarios**:

1. **Given** a gateway that is not answering `/health`, **When** `docker ps` is read, **Then** it
   reports `unhealthy` rather than `Up`.
2. **Given** the same state, **When** the E2E stack is brought up, **Then** bring-up fails naming the
   gateway rather than proceeding.
3. **Given** a HEALTHY gateway, **When** the suite runs normally, **Then** the healthcheck adds no
   material load and does not itself perturb the run.
4. **Given** the gateway becomes unhealthy mid-run, **When** the run finishes, **Then** the result
   names the gateway — it must not be reported as a test failure.

---

### User Story 2 - The next wedge leaves a stack trace behind (Priority: P1)

The wedge has occurred three times and been diagnosed zero times, because capturing it requires acting
on the live process and nobody was watching. It reproduces reliably — 3 of 3 full-suite runs — so the
capture can be automated rather than waited for.

**Why this priority**: US3 cannot start without it. This is the difference between fixing the defect
and guessing at it, and this repository has a documented history of the second.

**Independent Test**: Run the suite with the watcher armed; confirm that when `/health` first fails, a
Python stack dump for the wedged process is written and retained.

**Acceptance Scenarios**:

1. **Given** the watcher is armed, **When** `/health` first fails, **Then** a per-thread Python stack
   dump of the gateway process is captured within seconds, while it is still wedged.
2. **Given** a capture, **When** it is read, **Then** it identifies the frame the process is spinning
   in, not merely that it is busy.
3. **Given** the gateway is wedged, **When** an operator wants the same information by hand, **Then**
   one documented command produces it without installing anything into the image.
4. **Given** no wedge occurs during a run, **When** the run ends, **Then** the watcher says so and
   exits cleanly — an absent capture must not read as a capture that found nothing.

---

### User Story 3 - The gateway cannot enter the state (Priority: P1)

Fix the cause identified in US2.

**Why this priority**: It is the actual defect. It is listed last and **evidence-gated**: nothing in
this story may be implemented before US2 produces a stack, because a fix for an unobserved cause is
indistinguishable from a change that happens to move the symptom.

**Independent Test**: Reproduce the conditions that wedged it and confirm it does not wedge — with the
run count stated, since the reproduction is load-driven.

**Acceptance Scenarios**:

1. **Given** the stack dump from US2, **When** the cause is stated, **Then** it names the specific loop
   and the condition that makes it spin.
2. **Given** the fix, **When** the full web E2E suite runs **twice in succession without restarting the
   gateway**, **Then** it answers `/health` throughout both.
3. **Given** the fix, **When** the failure mode recurs anyway, **Then** the healthcheck from US1 makes
   that visible rather than silent.

### Edge Cases

- **The wedge does not reproduce during the capture run.** It has been 3 for 3, but that is three
  samples. The honest outcome is to report it uncaptured and leave US3 unstarted — not to fix the most
  plausible-looking loop.
- **The healthcheck itself perturbs the process.** A probe against a single-threaded event loop is not
  free. It must be cheap and infrequent enough that it cannot become the thing it is measuring.
- **The dump shows the spin inside a third-party library.** Then the fix is a usage change or a pin,
  and the spec should say so rather than reaching into a dependency.
- **Auto-restarting a wedged container would hide the defect.** A healthcheck that silently recovers
  the process would also silently erase the evidence and the incidence rate.

---

## Requirements *(mandatory)*

- **FR-001**: The gateway service MUST define a container healthcheck that exercises the HTTP path,
  so a process that is running but not serving reports `unhealthy`.
- **FR-002**: The E2E stack bring-up MUST wait on that health and MUST fail naming the gateway rather
  than proceeding against an unhealthy one.
- **FR-003**: The healthcheck MUST NOT materially perturb the process it measures.
- **FR-004**: A wedged gateway MUST NOT be silently restarted. Recovery that erases the evidence and
  the incidence rate is not a fix; the state must be reported.
- **FR-005**: The gateway MUST be able to dump every thread's Python stack **on demand**, without
  restarting it and without adding tooling to the image at incident time.
- **FR-006**: The capture MUST be automatable — armed before a run, triggered by the first `/health`
  failure, and retained.
- **FR-007**: An absent capture MUST be distinguishable from a capture that found nothing.
- **FR-008**: No diagnostic added here may carry credential material into a log or artifact.
- **FR-009**: The cause fixed in US3 MUST be the one the captured stack identifies, and the stack MUST
  be recorded alongside the fix.

## Success Criteria *(mandatory)*

- **SC-001**: A gateway that does not answer `/health` reports `unhealthy` in `docker ps`, and a stack
  bring-up refuses to continue against it.
- **SC-002**: A per-thread Python stack dump of the wedged process is captured and recorded in this
  feature's artifacts.
- **SC-003**: The captured stack names the spinning frame, and the fix addresses that frame.
- **SC-004**: The full web E2E suite runs **twice in succession without restarting the gateway**, with
  `/health` answering throughout.
- **SC-005**: Item #179's acceptance criteria are met and verified, and #179 is closed on them.

## Assumptions

- The wedge reproduces at roughly the rate observed (3 of 3 full-suite runs, appearing after ~one
  suite's worth of agent traffic). If it stops reproducing, SC-002 is unmet and US3 stays unstarted.
- `py-spy` can attach from a sibling container sharing the target's PID namespace, given
  `SYS_PTRACE`. If the rootless daemon refuses that, the in-process signal handler (FR-005) is the
  fallback and is why both mechanisms are specified rather than one.
- The defect is in the gateway or its direct dependencies, not in the MCP servers — they were
  responsive on every occasion the gateway was not.

## Out of scope

- **Item #173.** CI's collapsed runs record the gateway answering everything it received with `200`,
  so the CI collapse is a different failure. This feature makes local reproduction of #173
  trustworthy; it does not claim to explain it.
- Production deployment behaviour beyond the healthcheck. If the same wedge can occur in production,
  that is worth its own item once the cause is known.
- Any change to feature 054's stories.

## Branching

Shares feature 054's branch rather than taking its own, because 054's remaining verification (its
T028) is blocked on this fix and would have to wait for a separate PR to merge regardless. The
[PR-batching rule](../../openwiki/process/pull-request-batching.md) asks whether a red run would be
ambiguous between the two: it would not, because this feature's changes are the gateway and its
healthcheck, while 054's are the harness and the CI signal — and 054's own run-health verdict now
distinguishes a stack failure from a client-side one, which is the distinction that would otherwise
be ambiguous.
