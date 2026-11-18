# Tasks 102: Agent thread lifetime

**Input**: [spec.md](./spec.md), [plan.md](./plan.md)

## Phase 1: Setup

- [ ] **T001** **Doc-impact sweep**. Identifiers this feature changes or adds: the configurable key
  `subject_token` (now `__mcm_subject_token`), `file_handle` (now `__mcm_file_handle`), `MemorySaver`
  as the gateway checkpointer, `claimAgentThreadOwner`'s semantics, the claim TTL, and the new
  `AGENT_THREAD_RETENTION_SECONDS`, `AGENT_CHECKPOINT_MAX_THREADS`, `agent.checkpoint.threads` and
  `conversation_expired`. Search every `*.md` outside `specs/`, `docs/proposals/` and `docs/decisions/`.
  Record the hits and their verdicts here.

## Phase 2: US1 — the token is never checkpointed (#973)

- [ ] **T002** [US1] `tests/unit/test_checkpoint_token_absence.py`.
  - **Scenarios covered**: US1-AC1, US1-AC2
  - **Verify RED**: `uv run pytest tests/unit/test_checkpoint_token_absence.py` → fails:
    the token is found in checkpoint metadata.
- [ ] **T003** [US1] `SUBJECT_TOKEN_KEY` / `FILE_HANDLE_KEY` in `agui_identity.py`, the readers in
  `runtime_nodes.py`, and hand-built test configs switched to the constants.
  - **Verify GREEN**: T002 passes, and `tests/unit/test_agui_identity.py`,
    `tests/integration/test_gateway_identity_bridge.py`, `tests/unit/test_runtime_nodes.py`,
    `tests/unit/test_import_runtime.py` pass.

## Phase 3: US2 — bounded, observable retention (#974)

- [ ] **T004** [US2] `tests/unit/test_checkpoint_retention.py`.
  - **Scenarios covered**: US2-AC1, US2-AC2, US2-AC4
  - **Verify RED**: `uv run pytest tests/unit/test_checkpoint_retention.py` → collection error,
    `src.checkpoint_retention` does not exist.
- [ ] **T005** [US2] `src/checkpoint_retention.py`, the `graph.py` default, and
  `observability.register_checkpoint_gauge` registered by `gateway.create_app`.
  - **Verify GREEN**: T004 passes.
- [ ] **T006** [US2] `tests/unit/test_expired_resume.py` (two expired cases and two controls).
  - **Scenarios covered**: US2-AC3
  - **Verify RED**: `uv run pytest tests/unit/test_expired_resume.py` → fails: no
    `conversation_expired` `RUN_ERROR`.
- [ ] **T007** [US2] The `prepare_stream` expired-resume branch.
  - **Verify GREEN**: T006 passes.

## Phase 4: US3 — the claim outlives the checkpoint (#975)

- [ ] **T008** [US3] `cache-service.test.ts` (one `eval`, its arguments, nil → 503) and
  `agent-thread-owner.test.ts` (TTL = 2 × retention), plus
  `tests/integration/agent-thread-owner.integration.test.ts` against real Redis (claim, refresh on
  the owner's use past the old TTL, no refresh by another user, B refused).
  - **Scenarios covered**: US3-AC1 to US3-AC4
  - **Verify RED**: `npx jest --maxWorkers=1 src/bff-server/unit-tests/cache-service.test.ts
    src/bff-server/unit-tests/agent-thread-owner.test.ts` → the new cases fail; the integration file
    fails on the refresh case (TTL not extended).
- [ ] **T009** [US3] `env.agentThreadRetentionSeconds`, the Lua `claimAgentThreadOwner`, and the TTL
  in `agent-thread-owner.ts`.
  - **Verify GREEN**: T008's commands pass, with `agent-run-api`, `agent-stop-ownership` and
    `tests/app/bff-api/agent/run.test.ts`.

- [ ] **T009a** [US2] FR-007: the `conversation_expired` case in
  `src/components/agent/assistant-run-failure.test.ts`, then the notice.
  - **Verify RED**: `npx jest --maxWorkers=1 src/components/agent/assistant-run-failure.test.ts` →
    1 failing: received the generic "try again" text.
  - **Verify GREEN**: the same command passes.

## Phase 5: Polish

- [ ] **T010** Doc task for each T001 hit.
- [ ] **T011** **Close-out re-search**: re-run T001's searches for the old identifiers. Every remaining
  hit in a doc that states current procedure is fixed, or justified here.
- [ ] **T012** Refresh any `openwiki/` page whose `resource` changed (`wiki-refresh.mjs --stale`).
- [ ] **T013** Run the touched tiers one at a time: `nx lint movie-assistant`, `nx test movie-assistant`,
  `nx lint mcm-app`, `nx typecheck mcm-app`, the touched `mcm-app` jest suites, the integration file,
  `okf-lint`, `okf-governance`.
- [ ] **T014** Open the PR and get green CI. **Quote** the run numbers. Close items #973, #974, #975
  once their criteria are verified.

## Evidence

| Task | Result | Run |
|---|---|---|
