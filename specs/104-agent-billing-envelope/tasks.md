# Tasks: Bill the model run, not the CopilotKit handshake (item #806)

**Input**: [spec.md](./spec.md), [plan.md](./plan.md). `APP` = `frontend/mcm-app`. Worktree
`/home/coder/worktrees/backlog-806` (real `CI=true pnpm install --frozen-lockfile`).
`UNIT <path…>` = `npx --no-install jest --maxWorkers=1 --watchAll=false <path…>` in `APP`.

## Phase 1: Setup

- [X] T001 **Doc-impact sweep**. Identifiers changed: `NON_BILLABLE_AGENT_OPS` →
  `NON_BILLABLE_AGENT_METHODS`; the documented rule "billability by GraphQL `operationName`
  (`availableAgents`, `loadAgentState`, `hello`)". Hits outside `specs/`, `docs/proposals/` and
  `docs/decisions/`: `openwiki/projects/bff.md`, `openwiki/architecture/agent-layer.md`.

## Phase 2: Tests first

- [X] T002 `APP/src/bff-server/unit-tests/agent-rate-limiter.test.ts`: per-method classification;
  default-deny cases; GraphQL `operationName` no longer honoured.
- [X] T003 `APP/src/bff-server/unit-tests/agent-run-api.test.ts`: posts envelopes; each handshake
  method leaves the import-file handle and UI snapshot in place; `agent/run` consumes it once.
- [X] T004 GraphQL-shaped bodies in `agent-identity-refusal.test.ts`, `tests/app/bff-api/agent/run.test.ts`
  and the three forced-run bodies in `APP/tests/e2e/web/assistant-config.spec.ts` → `agent/run`
  envelopes; that E2E also asserts an unconfigured member's `{method:"info"}` handshake is NOT
  short-circuited as `assistant_not_configured` (live check of the classification through the BFF).
  **Verify RED** (T002–T004): see Evidence.

## Phase 3: Implementation

- [X] T005 `APP/src/bff-server/agent-rate-limiter.ts`: classify by `method`, remove the
  `operationName` branch. Comment updates in `APP/src/app/bff-api/agent/run+api.ts`.
  **Verify GREEN**: T002–T004 commands.

## Phase 4: Polish

- [X] T006 [P] Doc task: `openwiki/projects/bff.md` (billability rule + diagram node).
- [X] T007 [P] Doc task: `openwiki/architecture/agent-layer.md` (handshake list).
- [X] T008 **Close-out re-search**: `operationName`, `availableAgents`, `loadAgentState`,
  `NON_BILLABLE_AGENT_OPS` outside `specs/` — remaining hits only say the GraphQL key is retired
  (the classifier's doc comment, the test proving it is no longer honoured, the bff.md history note).
- [X] T009 Lint, typecheck, related unit suites; `wiki-refresh --stale` empty.
- [X] T010 **Open the PR** from a real branch: `fix/agent-billing-envelope`.

## Evidence

| Check | Result |
| --- | --- |
| T002–T004 Verify RED (old classifier) | 14 failed / 28 passed: every handshake method classified billable, five handshakes consumed the import-file handle, the handshake resolved the UI snapshot, upload → handshake → turn lost the file |
| T005 Verify GREEN | `src/bff-server` + `tests/app/bff-api`: 75 suites / 912 tests passed |
| T009 | `tsc --noEmit` clean; eslint: 0 errors (4 pre-existing `import/first` warnings in `agent-run-api.test.ts`, item #939); prettier clean; okf, governance, speckit-overrides gates pass; `wiki-refresh --stale` empty |
