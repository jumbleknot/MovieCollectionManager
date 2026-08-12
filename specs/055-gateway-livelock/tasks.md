# Tasks: the agent gateway wedges at 100% CPU and reports itself healthy

**Feature**: 055-gateway-livelock · **Backlog**: item #179
**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md)

## The rule that shapes this feature

**US3 may not be started until T009 has produced a stack.** A fix for an unobserved cause cannot be
distinguished from a change that happens to move the symptom, and three sessions of this repository's
history are that mistake. If the wedge does not reproduce, the honest outcome is an uncaptured report
and an unstarted US3 — not the most plausible-looking loop, patched.

---

## Phase 1 — US1: a wedged gateway cannot pass for a healthy one (P1)

- [x] **T001** [US1] Add a `healthcheck` to the `movie-assistant-gateway` service in
      `infrastructure-as-code/docker/agents/compose.prod.yaml`, probing `GET /health` with the
      interpreter already in the image (no `curl`, which the slim image lacks — do not add a package
      for a probe). Interval 30 s / timeout 5 s / retries 3 / start_period 40 s. (FR-001, FR-003)
      *(Done 2026-08-12. **DEVIATION**: placed in the **Dockerfile**, not compose. Checked rather than
      assumed — `scripts/agent-stack.mjs` starts the local gateway with `docker run`, so a compose-only
      healthcheck would have covered NEITHER of the two places it actually wedged.)*
- [x] **T002** [US1] **Prove the probe works without waiting for a real wedge**: `docker pause` the
      gateway, confirm `docker ps` turns `unhealthy`, then unpause. A healthcheck nobody has seen fail
      is a healthcheck nobody knows is wired up. (SC-001)
      *(Done 2026-08-12: `healthy` → paused → `unhealthy` → unpaused → `healthy`. **Caveat**: while
      paused, `docker ps` prints `(Paused)` and MASKS health; the `unhealthy` reading appeared on
      unpause. A real livelock spins rather than freezes, so it shows `Up X (unhealthy)` directly.)*
- [ ] **T003** [US1] Make the E2E stack bring-up wait on gateway health and FAIL naming it, rather
      than proceeding. Check how the agent stack is composed before editing — `scripts/agent-stack.mjs`
      and the compose `depends_on` are two different levers and only one may be in play. (FR-002)
- [x] **T004** [US1] Confirm the healthcheck does **not** silently restart the container: a wedged
      gateway must stay wedged and visible. Docker does not restart merely-unhealthy containers, so
      this is a verification that nothing else in the stack does it. (FR-004)
      *(Done 2026-08-12: nothing restarted it — it stayed paused-and-unhealthy until unpaused by hand,
      which is the intended behaviour.)*

---

## Phase 2 — US2: the next wedge leaves a stack trace behind (P1)

- [x] **T005** [US2] Install a `faulthandler` signal handler in `create_app()`
      (`agents/movie-assistant/src/gateway.py`) so `SIGUSR1` dumps every thread's Python stack to
      stderr. Frames only — no locals, no environment (FR-005, FR-008).
      *(Done 2026-08-12. Self-inflicted bug found and fixed: the call sat BEFORE `logging.basicConfig`,
      so the "armed" confirmation went nowhere — it worked and was invisible.)*
- [x] **T006** [US2] **Prove the dump mechanism against a HEALTHY gateway** — `docker kill -s USR1`,
      then read `docker logs`. Proving it before it is needed is the entire point; a mechanism first
      exercised during an incident is a mechanism that fails during an incident. (FR-005)
      *(Done 2026-08-12: `docker kill -s USR1` produced a full per-thread stack in `docker logs` and the
      gateway kept serving. **Idle baseline recorded**: the main thread parks in `selectors.select` /
      `_run_once`. When it wedges, THAT frame is the answer.)*
- [x] **T007** [US2] Add a unit test pinning that the handler is registered and that the dump carries
      no environment or credential material. (FR-008)
      *(Done 2026-08-12: 3 cases; unit tier **1127 passed / 2 skipped / 0 failed**. The dump test needed
      a real temp file — `faulthandler` writes through a file DESCRIPTOR, the very property that lets it
      work on a starved loop, so `StringIO` raises `io.UnsupportedOperation: fileno`.)*
- [x] **T008** [US2] Write `scripts/capture-gateway-wedge.sh`: poll `/health`, and on the FIRST failure
      capture the `faulthandler` dump, `py-spy dump`, `py-spy top`, `docker stats` and
      `docker inspect`, then stop. Exit cleanly and SAY SO when no wedge occurred — an absent capture
      must never read as a capture that found nothing. (FR-006, FR-007)
      *(Done 2026-08-12, DRILLED both ways. The drill found a real defect in it: `benfred/py-spy` is NOT
      a Docker Hub image — py-spy ships on PyPI — and the failure read as `pull access denied`, which
      looks like permissions and is a wrong name. Now pip-installed into a throwaway `python:3.13-slim`
      sharing the target's PID namespace, and verified attaching to the live gateway.)*
- [ ] **T009** [US2] **Arm the watcher and run one full web E2E suite.** Record whether a wedge
      occurred and attach the captured stack to this feature's artifacts.
      **If no wedge occurs: stop. Report it uncaptured and leave US3 unstarted.** (SC-002)

---

## Phase 3 — US3: the gateway cannot enter the state (P1) — ⛔ GATED ON T009

- [ ] **T010** [US3] From the captured stack, state the cause: the specific loop and the condition
      that makes it spin. Record the stack itself alongside the statement, so the reasoning stays
      checkable rather than being re-derived. (FR-009, SC-003)
- [ ] **T011** [US3] Write a failing test that reproduces the condition at the smallest scope it can
      be reproduced at — unit if the loop is reachable directly, integration if it needs the graph.
      **Verify RED.**
- [ ] **T012** [US3] Fix it. **Verify GREEN (T011).**
- [ ] **T013** [US3] `pnpm nx test:unit movie-assistant` and `pnpm nx test:integration movie-assistant`
      — record counts, not exit status.
- [ ] **T014** [US3] **Two consecutive full web E2E suites without restarting the gateway**, with
      `/health` answering throughout. One is not a sample: the reproduction is load-driven. (SC-004)

---

## Phase 4 — Closure

- [ ] **T015** Update `docs/runbooks/e2e-testing.md`: the one-command stack dump, the healthcheck's
      meaning, and the rule that a gateway reporting `Up` is not evidence it is serving.
- [ ] **T016** Close item **#179** on its acceptance criteria, verified, with the stack recorded.
      If US3 was never started for want of a capture, say so on the item and leave it open.
- [ ] **T017** Unblock feature 054's **T028** — its two-run US4 verification, which this feature
      exists to make possible — and record the link on both.

---

## Dependencies

```text
US1 (T001-T004) ── independent, ships regardless of cause ──┐
                                                            ├─> T009 (the capture run) ─> US3 (T010-T014) ─> Phase 4
US2 (T005-T008) ── the capture machinery ───────────────────┘
```

- **US1 and US2 are independent of each other** and both are independent of the cause. Either could
  ship alone and both are worth having.
- **T009 is the gate.** Everything in US3 is downstream of a real captured stack.
- **T014 is downstream of 054's harness**, which is what makes a local full-suite run valid at all.
