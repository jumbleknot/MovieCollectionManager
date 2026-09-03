# Tasks: 064 — agent turn delivery and branch-free gate waits

**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Item**: #337

Every test task records **Verify RED** then **Verify GREEN**
(`openwiki/process/test-authoring-conventions.md`). The three component fixes change behaviour in
already-shipping code, so RED is a real failing assertion — never a compile error.

## Phase 1 — one send path (US1, FR-001 … FR-004)

- **T001** [RED] `components/agent/unit-tests/request-import-file.test.tsx`: with the agent
  `isRunning`, a successful upload must still deliver `IMPORT_PROMPT` once the run completes.
  Expect RED against today's `if (… agent.isRunning) return`.
- **T002** [GREEN] `request-import-file.tsx` routes through `useAssistantRun().run(...)`; drop its
  `useAgent`/`useCopilotKit` handles.
- **T003** [RED] the same assertion for `disambiguation-options.tsx` — a pick taken mid-answer is
  delivered, not dropped.
- **T004** [GREEN] `disambiguation-options.tsx` routes through `useAssistantRun`.
- **T005** [RED] the same for `render-movie-card.tsx`, plus: a **second** tap during the queued
  window must NOT enqueue a second action (`actioned` latches at enqueue).
- **T006** [GREEN] `render-movie-card.tsx` routes through `useAssistantRun`, latch retained.
- **T007** Tooling guard: `scripts/__tests__/agent-send-path.test.mjs` fails if any file under
  `frontend/mcm-app/src` other than `hooks/use-assistant.tsx` calls `copilotkit.runAgent`, or
  guards an assistant send on `isRunning`. Include a meta-test proving the detector fires against a
  sample, per the #323 discipline.

## Phase 2 — the instrument (US2, FR-005 … FR-007)

- **T008** [RED] `agents/movie-assistant/tests/unit/test_graph.py`: every `_classify` return path
  emits one INFO record naming intent + node; the record carries no user text.
- **T009** [GREEN] `graph.py` logs it, including `disabled`, `degraded`, `noop` and the cancel
  short-circuit.

## Phase 3 — the shared wait (US3, FR-008, FR-009)

- **T010–T011** ~~an `assistant-turn-<n>` marker in the dock~~ — **WITHDRAWN after CI run 2566.**
  Android never exposed the 1 px `opacity: 0` View (an alpha-0 node is not `visibleToUser`), so
  `agent-card-navigate.yaml` failed 3/3 against a marker present in the React tree throughout. The
  dock is unchanged and the product gains no test-only surface.
- **T012** `tests/e2e/web/setup/assistant-turn.ts` — `beginTurn(page)` / `awaitTurn(page, token)`,
  counting `assistant-msg-assistant`.
- **T013** `tests/e2e/mobile/_await-turn.yaml` — waits for an `assistant-msg-assistant` bubble.
  Proven on Android by `assistant-add.yaml` and `assistant-config-enable*.yaml`, which already do
  it. Weaker than the web helper (existence, not a count) and documented as such.

## Phase 4 — adaptive continuations (FR-010, FR-011)

- **T014** `agent-card-navigate.spec.ts` — await the turn, continue via the offered result button or
  the rendered card, assert `movie-detail-title`.
- **T015** `agent-navigate-collection.spec.ts` — await the turn, tap the offered collection button,
  assert the collection screen; a turn that produced no collection offer fails naming the branch.
- **T016** `agent-import-disambiguate.spec.ts` — await the turn before waiting on the offer; the
  end-state poll (the movie in the chosen collection) is unchanged.
- **T017 … T019** the three mobile flows, same shape via `_await-turn.yaml`.

## Phase 5 — the allowlist and the record (FR-012, SC-001)

- **T020** `KNOWN_BRANCH_WAITS = []`; both guard assertions unchanged; full guard suite green.
- **T021** `openwiki/invariants/testing-tiers.md` — replace the grandfathering passage with what was
  found: the branch is pure code, the drop was in the client, and the intent line is the instrument.

## Phase 6 — verification and measurement (NFR-001, NFR-002, SC-004)

- **T022** Tiers derived from the diff: `nx test mcm-app`, `nx lint mcm-app`,
  `nx test movie-assistant`, `nx lint movie-assistant`, `node --test scripts/__tests__/…`.
- **T023** Full `E2E_TIER=gate` web run — NFR-002: a subset pass is not evidence about a shared hook.
- **T024** Repeated runs of the three affected specs on one unchanged tree, `--retries=0`; record the
  rate **with the worker count** on item #337, and state that mobile was not re-measured and why.
