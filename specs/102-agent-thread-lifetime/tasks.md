# Tasks 102: Agent thread lifetime

**Input**: [spec.md](./spec.md), [plan.md](./plan.md)

## Phase 1: Setup

- [X] **T001** **Doc-impact sweep**. Identifiers this feature changes or adds: the configurable key
  `subject_token` (now `__mcm_subject_token`), `file_handle` (now `__mcm_file_handle`), `MemorySaver`
  as the gateway checkpointer, `claimAgentThreadOwner`'s semantics, the claim TTL, and the new
  `AGENT_THREAD_RETENTION_SECONDS`, `AGENT_CHECKPOINT_MAX_THREADS`, `agent.checkpoint.threads` and
  `conversation_expired`. Search every `*.md` outside `specs/`, `docs/proposals/` and `docs/decisions/`.
  Record the hits and their verdicts here.
  **Result**: `subject_token` appears in `openwiki/projects/{keycloak,bff}.md` and
  `{docs,openwiki}/runbooks/backups.md` only as Keycloak's `subject_token validation failure` reason,
  the token-exchange form field, which is unchanged. No doc task. `MemorySaver`:
  `docs/runbooks/agent-layer.md` (the light stack) → T010. Thread-owner TTL: `openwiki/projects/bff.md`
  (twice) and `openwiki/architecture/agent-layer.md` state "the session's absolute window" → T010.
  `docs/MCM-Architecture.md` and `.specify/memory/constitution.md` name the ownership check only, with
  no TTL. They need no change. The new variables, gauge and code have no prior doc. They are
  documented in T010.

## Phase 2: US1 — the token is never checkpointed (#973)

- [X] **T002** [US1] `tests/unit/test_checkpoint_token_absence.py`.
  - **Scenarios covered**: US1-AC1, US1-AC2
  - **Verify RED**: `uv run pytest tests/unit/test_checkpoint_token_absence.py` → fails:
    the token is found in checkpoint metadata.
- [X] **T003** [US1] `SUBJECT_TOKEN_KEY` / `FILE_HANDLE_KEY` in `agui_identity.py`, the readers in
  `runtime_nodes.py`, and hand-built test configs switched to the constants.
  - **Verify GREEN**: T002 passes, and `tests/unit/test_agui_identity.py`,
    `tests/integration/test_gateway_identity_bridge.py`, `tests/unit/test_runtime_nodes.py`,
    `tests/unit/test_import_runtime.py` pass.

## Phase 3: US2 — bounded, observable retention (#974)

- [X] **T004** [US2] `tests/unit/test_checkpoint_retention.py`.
  - **Scenarios covered**: US2-AC1, US2-AC2, US2-AC4
  - **Verify RED**: `uv run pytest tests/unit/test_checkpoint_retention.py` → collection error,
    `src.checkpoint_retention` does not exist.
- [X] **T005** [US2] `src/checkpoint_retention.py`, the `graph.py` default, and
  `observability.register_checkpoint_gauge` registered by `gateway.create_app`.
  - **Verify GREEN**: T004 passes.
- [X] **T006** [US2] `tests/unit/test_expired_resume.py` (two expired cases and two controls).
  - **Scenarios covered**: US2-AC3
  - **Verify RED**: `uv run pytest tests/unit/test_expired_resume.py` → fails: no
    `conversation_expired` `RUN_ERROR`.
- [X] **T007** [US2] The `prepare_stream` expired-resume branch.
  - **Verify GREEN**: T006 passes.

## Phase 4: US3 — the claim outlives the checkpoint (#975)

- [X] **T008** [US3] `cache-service.test.ts` (one `eval`, its arguments, nil → 503) and
  `agent-thread-owner.test.ts` (TTL = 2 × retention), plus
  `tests/integration/agent-thread-owner.integration.test.ts` against real Redis (claim, refresh on
  the owner's use past the old TTL, no refresh by another user, B refused).
  - **Scenarios covered**: US3-AC1 to US3-AC4
  - **Verify RED**: `npx jest --maxWorkers=1 src/bff-server/unit-tests/cache-service.test.ts
    src/bff-server/unit-tests/agent-thread-owner.test.ts` → the new cases fail; the integration file
    fails on the refresh case (TTL not extended).
- [X] **T009** [US3] `env.agentThreadRetentionSeconds`, the Lua `claimAgentThreadOwner`, and the TTL
  in `agent-thread-owner.ts`.
  - **Verify GREEN**: T008's commands pass, with `agent-run-api`, `agent-stop-ownership` and
    `tests/app/bff-api/agent/run.test.ts`.

- [X] **T009a** [US2] FR-007: the `conversation_expired` case in
  `src/components/agent/assistant-run-failure.test.ts`, then the notice.
  - **Verify RED**: `npx jest --maxWorkers=1 src/components/agent/assistant-run-failure.test.ts` →
    1 failing: received the generic "try again" text.
  - **Verify GREEN**: the same command passes.

## Phase 5: Polish

- [X] **T010** Doc task for each T001 hit. A new "Conversation thread lifetime" section in
  `docs/runbooks/agent-layer.md`, where "MemorySaver" became "the in-memory checkpointer". Both
  variables are in `agents/movie-assistant/.env.local.example`. The three openwiki pages are under T012.
- [X] **T011** **Close-out re-search**: re-run T001's searches for the old identifiers. Every remaining
  hit in a doc that states current procedure is fixed, or justified here. Re-run: "session's absolute"
  near the owner claim, `MemorySaver` and `SET NX` outside `specs/` have no remaining hits that
  describe the thread-owner claim or the gateway checkpointer.
- [X] **T012** Refresh any `openwiki/` page whose `resource` changed (`wiki-refresh.mjs --stale`).
- [X] **T013** Run the touched tiers one at a time: `nx lint movie-assistant`, `nx test movie-assistant`,
  `nx lint mcm-app`, `nx typecheck mcm-app`, the touched `mcm-app` jest suites, the integration file,
  `okf-lint`, `okf-governance`.
- [X] **T014** Open the PR and get green CI. **Quote** the run numbers. Close items #973, #974, #975
  once their criteria are verified. Ticked after the merge, in a later docs PR: the CI evidence lives
  in the closing comments of PR #1059 and items #973, #974 and #975, per the tasks template's
  **Open the PR** rule (a commit recording it on the branch would have rerun every required job).

## Evidence

| Task | Result | Run |
|---|---|---|
| T002 RED | Constants added holding the OLD key names, then `pytest tests/unit/test_checkpoint_token_absence.py`: `1 failed`, `secret(s) found in the checkpoint store: [run token, resume token, 'import-handle-SECRET-d']`. The provider key (a dict value) was not found | Local |
| T003 GREEN | Keys `__mcm_subject_token` / `__mcm_file_handle`: the same test passes. The token reached the exchange on the run AND on the resume (a second token). `test_gateway_identity_bridge.py` (over the real AG-UI HTTP endpoint) `2 passed`. The 9 touched unit files `99 passed` | Local |
| T004 RED | `pytest tests/unit/test_checkpoint_retention.py`: `ModuleNotFoundError: No module named 'src.checkpoint_retention'` | Local |
| T005 GREEN | `12 passed` (idle eviction of checkpoints, writes and blobs; a read evicts with no write; the window slides; LRU cap; the written thread spared; async path; env parsing; gauge 3 → 1 through `InMemoryMetricReader`). On the first run 1 failed: the base `get_tuple` re-created an empty `defaultdict` entry for the evicted thread. Fixed by short-circuiting the read | Local |
| T006 RED | `pytest tests/unit/test_expired_resume.py`: `2 failed, 2 passed`. The legacy resume of an unknown thread streamed `RAW`, `STEP_STARTED` …, so the graph RAN as a fresh thread. The two controls passed | Local |
| T007 GREEN | `4 passed` | Local |
| T008 RED | Unit: `8 failed, 34 passed` (7 `claimAgentThreadOwner` cases; the TTL got `Received: 86400`, expected `2468`). Integration against a throwaway `redis:8.10.3-alpine` (the BFF compose pin) on 127.0.0.1:6379: `2 failed, 2 passed`. The refresh case got TTL `5`, expected `> 7195`. **B took A's live thread** (`Expected: "user-A" / Received: "user-B"`), which is #975 reproduced. The first version of the AC4 case passed on the old code because no real time passed, so it was rewritten to let the old TTL lapse for real (1.5 s) | Local |
| T009 GREEN | Integration `4 passed`. Unit: `cache-service`, `agent-thread-owner`, `agent-run-api`, `agent-stop-ownership`, `agent-identity-refusal`, `tests/app/bff-api/agent/run.test.ts`: 6 suites, `63 passed` | Local |
| T009a | RED `1 failed, 8 passed` (received the generic text). GREEN `9 passed` | Local |
| T012 | `wiki-refresh.mjs --stale` listed `architecture/agent-layer.md` and `projects/agent-gateway.md` (both from the runbook). Edited, then `--record`. `projects/bff.md` text corrected (its resource is unchanged). `--stale` prints nothing. `check-openwiki-okf.mjs`: `77 concepts conformant` | Local |
| T013 | One at a time, `--skip-nx-cache`: `nx okf-governance` + `okf-lint` exit 0; `nx lint movie-assistant`: `160 files already formatted`, ruff `All checks passed!`, mypy `no issues found in 46 source files`; `nx test movie-assistant`: `1256 passed, 1 skipped` (the same single skip as spec 097); `nx lint mcm-app`: `0 errors, 168 warnings` (baseline 168); `nx typecheck mcm-app` exit 0; `doc-env-example-citations`, `gen-dev-env`, `relocated-docs-links` guards: `27 pass, 0 fail, 0 skipped`. The full `nx test mcm-app` is left to CI, because other sessions share this VM | Local |
| T014 | PR #1059, head `b181bd90`: `ci-status.mjs` verdict mergeable, run ids 7848–7850 (`app-e2e`, `dast`, `android-launch` passed). Merged as `c6bdbfae`. Items #973, #974, #975 closed with per-criterion evidence comments | CI, PR #1059 |
