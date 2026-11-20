# Tasks: Four small backlog fixes (items #941, #955, #530, #243)

**Input**: [spec.md](./spec.md), [plan.md](./plan.md). `APP` = `frontend/mcm-app`, `MA` =
`agents/movie-assistant`. Worktree `/home/coder/worktrees/backlog-small-fixes` (real
`CI=true pnpm install --frozen-lockfile`, no symlinked `node_modules`).

`UNIT <path…>` = `npx --no-install jest --maxWorkers=1 --watchAll=false <path…>` in `APP`;
`PYUNIT <path>` = `python -m pytest -q <path>` in `MA` with the movie-assistant venv.

## Phase 1: Setup

- [X] T001 **Doc-impact sweep**. Identifiers changed: none renamed or removed (no paths, targets,
  env vars, labels). Searched `*.md` outside `specs/`, `docs/proposals/`, `docs/decisions/` for
  `rgb(242,242,242)`, item #243, the settings-layout workaround, and the delete-challenge "Please try
  again" text: no hits in a doc that states current procedure.

## Phase 2: Tests first

- [X] T002 [US1] `MA/tests/unit/test_resolvers_adversarial.py`: `SHARED_YEAR_OPTIONS` + shared-year
  re-ask, full-title-with-year, and wrong-year tests.
  **Verify RED**: `PYUNIT tests/unit/test_resolvers_adversarial.py -k shared_year` — 2 failed
  (`Avatar (2022)` resolved to the 2009 film; `Avatar: Fire and Ash (2022)` resolved), 6 passed.
- [X] T003 [US2] `APP/src/screens/settings/account-settings-screen.test.tsx`: 409 explains the
  last-administrator refusal; a 503 stays generic and leaks no detail.
  **Verify RED**: `UNIT src/screens/settings/account-settings-screen.test.tsx` — 1 failed (409), 14 passed.
- [X] T004 [US4] `APP/src/utils/unit-tests/navigation-theme.test.ts` (helper) and
  `APP/tests/e2e/web/theme.spec.ts` (no painted ancestor of `settings-profile-screen` computes
  rgb(242, 242, 242) in dark, or in light after a runtime toggle).
  **Verify RED**: the E2E assertion cannot pass on `main` — the navigator container IS
  rgb(242, 242, 242) there (item #243's measurement, depth 6); run in CI's gate tier.

## Phase 3: Implementation

- [X] T005 [US1] `MA/src/nodes/supervisor.py`: `_full_title_in`; shared year → `_full_title_in(matches)`.
  **Verify GREEN**: `PYUNIT tests/unit` — 1264 passed, 1 skipped; ruff + mypy clean.
- [X] T006 [US1] `MA/tests/integration/test_resolution_realistic.py`: assert the year-bearing pick
  either way (unique year → the film; shared → `None`) instead of skipping; full title + year always
  resolves.
- [X] T007 [US2] `APP/src/screens/settings/account-settings-screen.tsx`: `lastAdmin` message on 409.
  **Verify GREEN**: T003 command — 15 passed.
- [X] T008 [US3] `APP/tests/e2e/mobile/agent-search.yaml`, `assistant-disambiguate.yaml`: bounded waits
  with a why-comment. **Verify GREEN**: `agent-search` in this PR's CI agent flows.
- [X] T009 [US4] `APP/src/utils/navigation-theme.ts`; root `_layout.tsx` wraps `<Stack>` in
  `NavigationThemeProvider`; settings `_layout.tsx` loses its background.
  **Verify GREEN**: `UNIT src/utils/unit-tests/navigation-theme.test.ts` 3/3; T004 E2E in CI.

## Phase 4: Polish

- [X] T010 `tsc --noEmit` clean; eslint clean on changed files (one pre-existing `import/first`
  warning in the screen test, item #939); related unit suites 24/214 passed;
  `agent-test-classification` guard 19/19.
- [X] T011 **Close-out re-search**: re-ran T001's searches — no hits outside `specs/`.
- [X] T012 `node scripts/wiki-refresh.mjs --stale` — empty.
- [X] T013 **Open the PR** from a real branch: `fix/backlog-small-fixes`; PR number and sha in the PR
  and in each item's closing comment.
