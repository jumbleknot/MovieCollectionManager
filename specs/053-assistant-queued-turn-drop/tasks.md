# Tasks: A message sent while the assistant is still answering is silently lost

**Feature**: 053-assistant-queued-turn-drop
**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md)

Every test task follows the template's **Verify RED then Verify GREEN** rule: the test must be seen
failing against the unfixed code before the fix lands, or it is not evidence.

## US1 — A follow-up typed mid-answer is not lost (P1)

- [x] **T001** [US1] Add `frontend/mcm-app/src/hooks/use-assistant.test.tsx` covering `useAssistantRun`:
      a message sent while `agent.isRunning === true` is delivered once the run completes, exactly
      once. Drive the transition by flipping `isRunning` on a stable agent object and re-rendering —
      the stability is the point, since a fresh object would pass even on the broken code.
      **Verify RED.**
      *(Done 2026-08-10: RED confirmed — 2 failed / 4 passed. The first attempt was NOT red: a test double returning a fresh `copilotkit` per render invalidates the memoised callbacks and re-runs the flush effect for free, repairing the bug it was meant to catch. Checked the installed CopilotKit source — `useCopilotKit` returns the context value straight from `useContext` and `copilotkit` is one class instance — and made the double stable to match.)*
- [x] **T002** [US1] Add the idle case to the same file: a send while the agent is idle fires
      immediately (the path that already works — pins that the fix does not regress it).
      *(Done 2026-08-10: passes on the unfixed code too, which is the point — it pins the path that already worked.)*
- [x] **T003** [US1] Add the at-most-once case: after a queued message is delivered, a further
      re-render/run-completion does not deliver it again (FR-003).
      *(Done 2026-08-10: RED on the unfixed code alongside T001.)*
- [x] **T004** [US1] Fix `useAssistantRun` in `frontend/mcm-app/src/hooks/use-assistant.tsx`: hoist
      `isRunning` and add it to the flush effect's dependency list, so the queue flushes on the
      trailing edge of a run. **Verify GREEN (T001–T003).**
      *(Done 2026-08-10: hoisted `isRunning` into the effect deps. GREEN — 6/6.)*

## US2 — The agent-not-yet-registered case keeps working (P2)

- [x] **T005** [US2] Add the empty-registry case: a send with no resolvable agent is delivered once an
      agent registers. This is the behaviour the queue was originally written for; it must not be
      traded away. **Verify RED against a deliberately broken flush, then GREEN.**
      *(Done 2026-08-10: the empty-registry self-heal still passes.)*

## Validation

- [x] **T006** `pnpm nx test mcm-app` — full unit tier, no regression.
      *(Done 2026-08-10: 1185/1185 across 122 suites.)*
- [x] **T007** `pnpm nx lint mcm-app` and `pnpm nx typecheck mcm-app` clean.
      *(Done 2026-08-10: both clean.)*
- [x] **T008** Run `assistant-disambiguate.spec.ts` against the live containerized stack with
      `--retries=0`, and read the BFF contention counters for the same window. A result from a run
      with `refresh_rate_limited > 0` is about the harness, not the code, and must be discarded and
      re-run. (SC-002)
      *(Done 2026-08-10: 5/5 with --retries=0 against the live containerized stack in 23.6s (was 2.3 min — the delta is the 120s previously spent waiting for a card that could never arrive). Instrument checked alongside: refresh_rate_limited=0, 18 gateway requests. NOTE: the BFF image had to be rebuilt (`pnpm nx docker-build mcm-app`) and the container recreated first — the dev-container serves a BUILT bundle, so without that the run exercises the old code and proves nothing.)*
- [x] **T009** Two consecutive `app-ci` runs; judge by the `e2e-result-gate` line
      (`failed=0 skipped=0 did-not-run=0`), never by the job's exit status. (SC-003)
      *(Done 2026-08-10 — **SC-003 NOT MET, and the fix was REVERTED.** Runs 1621 and 1622 on the
      identical sha reported failed=28 and failed=26 against 1 on the commit before. See the banner
      in spec.md. T004's change is reverted; T001–T003's unit test is removed with it, because it
      asserts behaviour the code no longer has. The spec and plan are kept as the record of what was
      measured and what is still unexplained.)*
- [x] **T010** Record the outcome on backlog item #150, including anything still unexplained.
      *(Done 2026-08-10.)*
