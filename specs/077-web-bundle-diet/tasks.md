# Tasks: Web bundle diet — take the assistant runtime off the cold-load path

**Input**: Design documents from `/specs/077-web-bundle-diet/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [contracts/bundle-budget.md](./contracts/bundle-budget.md)

**Tests**: Mandatory. The constitution's Test-Driven Development principle is NON-NEGOTIABLE, so
every test task below carries a Verify RED with its expected failure output and every paired
implementation task a Verify GREEN, per `docs/templates/feature-test-tasks-template.md`.

## Format: `[ID] [P?] [Story] Description`

`[P]` marks tasks that may run in parallel with the task beside it (different files, no shared state).

## Path Conventions

- App source: `frontend/mcm-app/src/`
- Unit tests: colocated (`*.test.ts`, `*.test.tsx`), run by `pnpm nx test mcm-app`
- Web E2E: `frontend/mcm-app/tests/e2e/web/*.spec.ts`, run by `pnpm exec playwright test` from `frontend/mcm-app`
- Mobile E2E: `frontend/mcm-app/tests/e2e/mobile/*.yaml` (Maestro)
- Gate scripts: `scripts/check-*.mjs`, their tests `scripts/__tests__/*.test.mjs`, run by `node --test`

### Two command traps that apply to every task below

- **`node --test <file> --test-name-pattern "x"` silently runs EVERYTHING** — everything after the
  script path becomes the script's own `argv`. Node's flags go **before** the path.
- **`--testPathPattern` matches the whole worktree path.** In `/home/coder/worktrees/077-web-bundle-diet`
  a pattern like `backup` matches the directory and runs every suite. Match the file stem and
  **check the reported suite count** against what you expected.

### Running web E2E from this worktree

The Playwright stack's bind mount silently yields an empty directory when run from a worktree, and
`.env.local` credentials are **not** loaded by Playwright. Stage a Docker volume per
[docs/runbooks/e2e-testing.md](../../docs/runbooks/e2e-testing.md) before the E2E tasks, and set
`MCM_REQUIRE_LIVE_STACK=1` so a skip becomes a failure — **a skipped test reads as a pass; watch
the skip count.**

---

## Phase 1: User Story 2 — Server-only code stops shipping to the browser (Priority: P2)

**Goal**: No `src/bff-server/**` module reaches the client, and `luxon` (70 KB) leaves the client graph.

**Independent Test**: Export the bundle and confirm `luxon` and `src/bff-server` contribute zero
modules; the backups run-history renders identically.

**Why first**: independent of the boundary work and lowest risk. Landing it first means US1's
measurement is taken against a tree where the leak is already gone, so the two effects never have
to be disentangled.

### T001 — Move the run-summary unit tests to the Utils-Layer and cover the `Intl` invalid-zone path

**Type**: Test refactor | **Time**: 30 min | **Risk**: Low

**Spec reference**: [spec.md#user-story-2](./spec.md) — US2-AC2

**Scenarios covered**:
- US2-AC2: Given the backups settings screen, when a user views run history, then run summaries and their timestamps render exactly as they do today.

**File(s)**: `frontend/mcm-app/src/utils/unit-tests/backup-run-summary.test.ts` (moved from `src/bff-server/unit-tests/`)

Move the existing test file and repoint its import to `@/utils/backup-run-summary`. Keep every
existing assertion **unchanged** — they are the behavioural contract for the `luxon` → `Intl`
replacement, and exact-string assertions across time zones are exactly what catches formatting drift.

Add two cases the current suite does not have, both of which a naive replacement fails:
- An **unknown time zone** (e.g. `'Not/AZone'`) returns `'Not scheduled'`. Luxon returned an invalid
  `DateTime`; `Intl.DateTimeFormat` throws `RangeError`, so without a catch this becomes an
  unhandled exception in a settings screen.
- A **DST-transition** instant in `Europe/London` formats to the post-transition wall clock
  (`2026-07-03T03:00:00Z` → `3 Jul 2026, 04:00`), pinning the offset handling.

**Verify RED** (run before implementing — test must fail):
```bash
cd /home/coder/worktrees/077-web-bundle-diet/frontend/mcm-app
pnpm exec jest --watchAll=false src/utils/unit-tests/backup-run-summary.test.ts
```
**Expected RED**: 1 suite failing to resolve — `Cannot find module '@/utils/backup-run-summary' from 'src/utils/unit-tests/backup-run-summary.test.ts'`

> If this shows 0 failures, the test is trivially passing and must be fixed before implementation.

---

### T002 — Move the module to the Utils-Layer and replace `luxon` with `Intl.DateTimeFormat`

**Type**: Implementation | **Time**: 45 min | **Risk**: Medium

**Spec reference**: US2-AC1, US2-AC2 · FR-009, FR-010

**Prerequisite**: T001 complete and verified RED.

1. `git mv frontend/mcm-app/src/bff-server/backup-run-summary.ts frontend/mcm-app/src/utils/backup-run-summary.ts`.
2. In `formatNextRun`, replace `DateTime.fromISO(nextRunAt, { zone: timeZone })` with
   `Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })`.
   Verified byte-identical to Luxon's `d LLL yyyy, HH:mm` across five zones — see
   [research.md](./research.md) R4. Wrap in `try/catch` returning `'Not scheduled'` on `RangeError`,
   and keep the existing `'Not scheduled'` return for a missing/unparseable instant.
3. Remove the `luxon` import. **Do not remove `luxon` from `package.json`** —
   `src/bff-server/backup-schedule.ts` still uses it server-side.
4. Update `frontend/mcm-app/src/components/backups/run-history.tsx` to import from
   `@/utils/backup-run-summary`. Update the comment on line 10 that names the old location.
5. Preserve the module's header comment — its statement that every input is an argument is why it
   belongs in the Utils-Layer, and it is the justification for this move.

**Verify GREEN**:
```bash
cd /home/coder/worktrees/077-web-bundle-diet/frontend/mcm-app
pnpm exec jest --watchAll=false src/utils/unit-tests/backup-run-summary.test.ts
```
**Expected GREEN**: 0 failures — all assertions pass, including the two new cases.

**Also run the touched suite** (regression check):
```bash
pnpm exec jest --watchAll=false src/components/backups
pnpm nx typecheck mcm-app && pnpm nx lint mcm-app
```
**Expected**: previously passing tests still pass; no unresolved import of the old path anywhere.

---

### T003 [P] — Write the server-import gate's tests

**Type**: Test | **Time**: 40 min | **Risk**: Low

**Spec reference**: US2-AC3 · FR-011

**Scenarios covered**:
- US2-AC3: Given a new client-side import of a `src/bff-server/**` module, when the repository's checks run, then they fail and name the importing file.

**File(s)**: `scripts/__tests__/check-no-server-imports.test.mjs`

Cover, against fixture trees in a temp directory rather than the real tree:
- A client component importing `@/bff-server/x` → flagged, and the **importing file and the
  specifier both appear in the output**.
- A relative import that resolves into `src/bff-server/` (`../../bff-server/x`) → flagged. A gate
  that only matches the `@/` alias is trivially bypassed.
- A file **inside** `src/bff-server/**` importing a sibling → not flagged.
- An API route (`src/app/**/*+api.ts`) importing `@/bff-server/x` → not flagged; that is the
  sanctioned server-side path.
- A type-only import (`import type { T } from '@/bff-server/x'`) → **not** flagged; it is erased at
  compile time and ships nothing.
- `--selftest` exits 0 on a healthy gate.
- An unrecognised flag exits **2** and does not scan (the `argv-contract` rejection).

**Verify RED**:
```bash
cd /home/coder/worktrees/077-web-bundle-diet
node --test scripts/__tests__/check-no-server-imports.test.mjs
```
**Expected RED**: all tests failing — `Cannot find module '.../scripts/check-no-server-imports.mjs'`

---

### T004 — Implement the server-import gate

**Type**: Implementation | **Time**: 50 min | **Risk**: Low

**Spec reference**: US2-AC3 · FR-011

**Prerequisite**: T003 complete and verified RED.

Create `scripts/check-no-server-imports.mjs`:
- Walk git-tracked files under `frontend/mcm-app/src`, excluding `src/bff-server/**`,
  `src/app/**/*+api.ts`, and `**/*.test.*` / `**/unit-tests/**`.
- Flag any `import`/`require`/`export … from` whose specifier is `@/bff-server/…`, or a relative
  path resolving inside `src/bff-server/`. Skip `import type`.
- Print one line per hit: the importing file, the line number and the specifier. Exit 1 on any hit.
- Add `--selftest` proving both paths (a planted import is detected; a clean tree yields none), per
  the convention every other gate in the `naming` job follows.
- Parse arguments through `scripts/lib/argv-contract.mjs` so an unknown flag raises instead of
  leaving the scan running.
- Header comment: state the constitution clause it enforces ("BFF-Layer must run server-side and
  never be included client-side") and the measured cost of the violation it was written for
  (70 KB of `luxon` on every route, feature 077).

**Verify GREEN**:
```bash
cd /home/coder/worktrees/077-web-bundle-diet
node --test scripts/__tests__/check-no-server-imports.test.mjs
node scripts/check-no-server-imports.mjs --selftest
node scripts/check-no-server-imports.mjs
```
**Expected GREEN**: 0 failures; `--selftest` exits 0; the real scan exits 0 (T002 removed the only violation).

**Sanity check the gate actually bites**:
```bash
node scripts/check-no-server-imports.mjs   # after temporarily re-adding the old import
```
**Expected**: exit 1, naming `src/components/backups/run-history.tsx` and `@/bff-server/backup-run-summary`. Revert the temporary edit.

---

### T005 — Wire the server-import gate into CI

**Type**: Config change | **Time**: 15 min | **Risk**: Low

**Spec reference**: FR-011

Add to `.forgejo/workflows/guardrails.yml`, in the `naming` job, beside the other gates and in
their exact idiom (selftest then scan, both through `ci-log-step.sh`):

```yaml
      - name: Server-import gate (selftest + scan — no client-side import of src/bff-server, feature 077)
        run: |
          bash scripts/ci-log-step.sh naming-server-import-gate-selftest node scripts/check-no-server-imports.mjs --selftest
          bash scripts/ci-log-step.sh naming-server-import-gate node scripts/check-no-server-imports.mjs
```

**Done when**: the step exists in the `naming` job, and `node scripts/check-ci-digest-coverage.mjs`
still passes (every job must publish a failure digest — a new step must not break that gate).

**Checkpoint**: US2 is complete and independently verifiable — `luxon` and `src/bff-server` are out
of the client graph, and the gate prevents recurrence.

---

## Phase 2: User Story 1 — A first visit to /home stops downloading the assistant (Priority: P1) 🎯 MVP

**Goal**: The assistant runtime ships in its own chunk, fetched on idle or on open, never before
`/home` is interactive.

**Independent Test**: Export and confirm two chunks with the assistant packages absent from entry;
then drive `/home` under Slow-3G and confirm the deferred chunk is not among the responses observed
before interactive, with the assistant still openable.

### T006 [P] — Write the runtime loader's tests

**Type**: Test | **Time**: 35 min | **Risk**: Low

**Spec reference**: US1-AC4, US1-AC5 · FR-004, FR-006

**Scenarios covered**:
- US1-AC4: the runtime is fetched in the background on idle, at most once per page session.
- US1-AC5: a press during loading opens the panel without a second press.

**File(s)**: `frontend/mcm-app/src/utils/unit-tests/assistant-runtime-loader.test.ts`

Cover:
- Two calls to `loadAssistantRuntime()` produce **one** underlying import (single-flight) and
  resolve to the same module.
- Concurrent calls before the first settles also produce one import.
- **After a rejection, the next call retries** — it does not replay the rejected promise. This is the
  behaviour a bare `inFlight ??= import(...)` gets wrong, and FR-006 depends on it.
- `resetAssistantRuntimeForTest()` clears the cached promise.

Inject the importer as a parameter (defaulting to the real dynamic import) so the test can count
calls without mocking the module system — keeping this a genuine unit test.

**Verify RED**:
```bash
cd /home/coder/worktrees/077-web-bundle-diet/frontend/mcm-app
pnpm exec jest --watchAll=false src/utils/unit-tests/assistant-runtime-loader.test.ts
```
**Expected RED**: 1 suite failing to resolve — `Cannot find module '@/utils/assistant-runtime-loader'`

---

### T007 — Implement the single-flight runtime loader

**Type**: Implementation | **Time**: 25 min | **Risk**: Low

**Spec reference**: FR-004, FR-006

**Prerequisite**: T006 complete and verified RED.

Create `frontend/mcm-app/src/utils/assistant-runtime-loader.ts` per [plan.md](./plan.md) D2: a
module-scoped promise, a `loadAssistantRuntime()` that returns it, **clearing it on rejection** so a
later attempt retries, and a test-only reset. No React import — this is a Utils-Layer module.

**Verify GREEN**:
```bash
cd /home/coder/worktrees/077-web-bundle-diet/frontend/mcm-app
pnpm exec jest --watchAll=false src/utils/unit-tests/assistant-runtime-loader.test.ts
```
**Expected GREEN**: 0 failures — 4 passed.

---

### T008 [P] — Write the idle-prefetch hook's tests

**Type**: Test | **Time**: 30 min | **Risk**: Low

**Spec reference**: US1-AC4 · FR-004

**File(s)**: `frontend/mcm-app/src/hooks/unit-tests/use-assistant-runtime.test.tsx`

Cover:
- On mount the hook schedules the load via `requestIdleCallback` and **does not call it synchronously**
  — a synchronous call would put the fetch back inside the critical path, which is the whole failure
  this feature exists to avoid.
- Where `requestIdleCallback` is absent, a `setTimeout` fallback schedules it.
- Unmount before the callback fires cancels it and never loads.
- The hook returns no UI (constitution: hooks never return UI components).

**Verify RED**:
```bash
cd /home/coder/worktrees/077-web-bundle-diet/frontend/mcm-app
pnpm exec jest --watchAll=false src/hooks/unit-tests/use-assistant-runtime.test.tsx
```
**Expected RED**: 1 suite failing to resolve — `Cannot find module '@/hooks/use-assistant-runtime'`

---

### T009 — Implement the idle-prefetch hook

**Type**: Implementation | **Time**: 30 min | **Risk**: Low

**Spec reference**: FR-004

**Prerequisite**: T008 complete and verified RED.

Create `frontend/mcm-app/src/hooks/use-assistant-runtime.ts` per [plan.md](./plan.md) D3 —
`requestIdleCallback` with a `setTimeout` fallback, cancelled on unmount, calling the same
`loadAssistantRuntime()` the render path uses so the prefetch genuinely warms it.

**Verify GREEN**:
```bash
cd /home/coder/worktrees/077-web-bundle-diet/frontend/mcm-app
pnpm exec jest --watchAll=false src/hooks/unit-tests/use-assistant-runtime.test.tsx
```
**Expected GREEN**: 0 failures — 4 passed.

---

### T010 — Write the dock-boundary tests

**Type**: Test | **Time**: 50 min | **Risk**: Medium

**Spec reference**: US1-AC2, US1-AC5 · FR-003, FR-005, FR-006

**Scenarios covered**:
- US1-AC2: pressing the toggle opens the panel and accepts input, as before.
- US1-AC5: a press before the fetch completes shows a loading state, then opens — never a blank panel, never a dropped press.

**File(s)**: `frontend/mcm-app/src/components/agent/assistant-dock.test.tsx` (extend the existing suite)

Add:
- The toggle renders with its existing `assistant-dock-toggle` testID and label **without** the panel
  module having been imported.
- Pressing the toggle renders the loading fallback, and after the import resolves renders
  `assistant-dock-panel`.
- A rejected import renders the recoverable error state, the toggle stays interactive, and a retry
  re-attempts the load and succeeds.

Keep every existing assertion in the file passing — they are the dock's current contract.

**Verify RED**:
```bash
cd /home/coder/worktrees/077-web-bundle-diet/frontend/mcm-app
pnpm exec jest --watchAll=false src/components/agent/assistant-dock.test.tsx
```
**Expected RED**: 3 tests failing — the loading fallback and error-state testIDs do not exist, and the panel is imported eagerly so the "not imported" assertion fails.

---

### T011 — Extract the panel, add the fallback states, move the provider

**Type**: Implementation | **Time**: 2 h | **Risk**: High

**Spec reference**: US1-AC1, US1-AC2, US1-AC3, US1-AC5, US1-AC6 · FR-001, FR-002, FR-003, FR-005, FR-006, FR-007, FR-008

**Prerequisite**: T010 complete and verified RED.

Per [plan.md](./plan.md) D1 and D4:

1. **New `src/components/agent/assistant-panel.tsx`** — move `AssistantPanel`, `buildDockItems`,
   `useScrollToEndOnChange`, the tool-render hook wiring and every `@copilotkit/*` / `@ag-ui/*`
   import out of `assistant-dock.tsx`. **Default-export** a component that wraps the panel in
   `AssistantProvider`, so the provider is inside the deferred chunk.
2. **`src/app/(app)/_layout.tsx`** — remove the `AssistantProvider` import and the wrapper.
   `AuthedAssistant` renders `<AssistantDock/>` alone, keeping its existing `isAuthenticated && runnable`
   gate untouched (FR-007). **This step is load-bearing**: leaving the provider here keeps
   `@copilotkit/react-native` in the entry chunk and nothing is deferred (research.md R2).
3. **`src/components/agent/assistant-dock.tsx`** — keep only the toggle. Replace
   `{open && <AssistantPanel/>}` with the lazy element inside `React.Suspense` plus an error
   boundary. Call `useAssistantRuntime()` for the idle prefetch. After this, the file must import
   nothing from `@copilotkit/*`, `@ag-ui/*` or `@/hooks/use-assistant`.
4. **New `src/components/agent/assistant-panel-fallback.tsx`** — the loading and recoverable-error
   states, composed from `@mcm/design-system`, with new stable testIDs
   (`assistant-dock-panel-loading`, `assistant-dock-panel-error`, `assistant-dock-panel-retry`).
5. Keep `src/assistant-polyfills.ts` **unchanged** — native needs it (FR-013), and changing it
   achieves nothing on web (research.md R2).

**Verify GREEN**:
```bash
cd /home/coder/worktrees/077-web-bundle-diet/frontend/mcm-app
pnpm exec jest --watchAll=false src/components/agent src/hooks src/utils
pnpm nx typecheck mcm-app && pnpm nx lint mcm-app
```
**Expected GREEN**: 0 failures.

**Verify the split actually happened** (this is the feature, and no unit test can see it):
```bash
cd /home/coder/worktrees/077-web-bundle-diet/frontend/mcm-app
npx expo export --platform web --source-maps --output-dir /tmp/dist-077
ls -l /tmp/dist-077/client/_expo/static/js/web/*.js
```
**Expected**: **two** JS chunks. The `entry-*.js` is ≤ 2,400,000 B (probe measured 1,831,422 B).
A single chunk means the boundary did not take — check step 2 first.

```bash
node -e "
const g=require('glob'),fs=require('fs');
const m=JSON.parse(fs.readFileSync(g.sync('/tmp/dist-077/client/_expo/static/js/web/entry-*.js.map')[0],'utf8'));
for (const p of ['text-encoding','web-streams-polyfill','zod','graphql','@copilotkit/','@ag-ui/','luxon','bff-server'])
  console.log(p, m.sources.filter(s=>s.includes(p)).length);
"
```
**Expected**: every line prints `0`.

---

### T012 — Tighten the perf test to prove the deferral

**Type**: Test | **Time**: 40 min | **Risk**: Medium

**Spec reference**: US1-AC1, US3-AC3 · FR-002, FR-014, SC-002, SC-003

**Scenarios covered**:
- US1-AC1: a cold Slow-3G `/home` load reaches interactive without the assistant runtime chunk.
- US3-AC3: the test still attaches `perf-metrics`, with ≥50% headroom against its ceiling.

**File(s)**: `frontend/mcm-app/tests/e2e/web/perf.spec.ts`

- Lower `TTI_CEILING_MS` from `150_000` to `75_000` — the ≥50%-headroom criterion (SC-002). The
  constant already feeds both the `waitForSelector` timeouts and the assertion, so the ceiling stays
  reachable (the defect 076 fixed); do not reintroduce a separate wait.
- Lower the transferred-JS sanity ceiling from `8000` KB to `2600` KB.
- Add the assertion that **no response observed before the interactive mark** has a URL matching the
  deferred chunk (`/_expo/static/js/web/assistant-`). This is what proves deferral rather than
  merely benefiting from it — and it is the assertion that would have caught the boundary-too-high
  mistake in research.md R3.
- Keep the `perf-metrics` attachment and its fields; add the deferred-chunk verdict to the payload
  so the PR carries the evidence.

**Verify RED** — run against the tree **before** T011 (`git stash` T011's changes, or run on
`origin/main`), with the stack up:
```bash
cd /home/coder/worktrees/077-web-bundle-diet/frontend/mcm-app
MCM_REQUIRE_LIVE_STACK=1 pnpm exec playwright test tests/e2e/web/perf.spec.ts
```
**Expected RED**: 1 test failing — the deferred-chunk assertion fails (there is no second chunk, so
the whole bundle is on the critical path) and/or `Slow-3G TTI sanity ceiling: expected < 75000`.
**Check the skip count is 0** — a skipped perf test reads as a pass.

---

### T013 — Confirm the perf test GREEN and the assistant flows unregressed

**Type**: Implementation (verification) | **Time**: 1 h | **Risk**: Medium

**Spec reference**: US1-AC1, US1-AC2, US1-AC3 · FR-008, SC-007

**Prerequisite**: T011 and T012 complete; T012 verified RED.

**Verify GREEN**:
```bash
cd /home/coder/worktrees/077-web-bundle-diet/frontend/mcm-app
MCM_REQUIRE_LIVE_STACK=1 pnpm exec playwright test tests/e2e/web/perf.spec.ts
```
**Expected GREEN**: 1 passed, 0 skipped; `perf-metrics` shows `slow3gColdTtiMs` < 75,000 and the
deferred chunk absent before interactive.

**Also run the assistant suites** — these are the direct test of FR-008 (hydration across the new
boundary), which no unit test and no export can prove:
```bash
MCM_REQUIRE_LIVE_STACK=1 pnpm exec playwright test tests/e2e/web/assistant.spec.ts \
  tests/e2e/web/assistant-config.spec.ts tests/e2e/web/assistant-query.spec.ts \
  tests/e2e/web/assistant-navigate.spec.ts tests/e2e/web/backups.spec.ts
```
**Expected**: previously passing tests still pass, 0 skipped. A hydration mismatch surfaces here as
a dock that never becomes interactive — not as an export failure.

**Checkpoint**: US1 complete. The entry chunk is ≤2.4 MB, the assistant still works, and the perf
test proves the deferral rather than assuming it.

---

## Phase 3: User Story 3 — The headroom cannot silently erode again (Priority: P3)

**Goal**: Entry-chunk size is measured against a committed budget on every affected change.

**Independent Test**: Raise the budget's input above the ceiling and confirm the failure names the
measured size, budget and overage; restore and confirm it passes.

### T014 — Write the budget gate's tests

**Type**: Test | **Time**: 50 min | **Risk**: Low

**Spec reference**: US3-AC1, US3-AC2 · FR-012, SC-004, SC-006

**Scenarios covered**:
- US3-AC1: the check reports the entry chunk's size and passes only within budget.
- US3-AC2: over budget, it fails naming measured size, budget and overage.

**File(s)**: `scripts/__tests__/check-web-bundle-budget.test.mjs`

Against synthetic `dist` fixtures in a temp directory, per
[contracts/bundle-budget.md](./contracts/bundle-budget.md):
- Under budget → exit 0, output carries measured and budget.
- Over budget → exit 1, output carries measured, budget **and the overage**.
- **Zero `entry-*.js` matches → exit 1** (not a pass). An export that never ran must not read as clean.
- **More than one `entry-*.js` → exit 1.** Ambiguity means the reported number is not the claimed number.
- A deferred package present in the entry chunk's source-map `sources` → exit 1, **naming that package**.
- Map absent → size check still runs, and the zero-modules assertion is reported as **skipped on its
  own line** rather than silently passing.
- `--selftest` exits 0; an unknown flag exits **2** without scanning.

**Verify RED**:
```bash
cd /home/coder/worktrees/077-web-bundle-diet
node --test scripts/__tests__/check-web-bundle-budget.test.mjs
```
**Expected RED**: all tests failing — `Cannot find module '.../scripts/check-web-bundle-budget.mjs'`

---

### T015 — Implement the budget gate

**Type**: Implementation | **Time**: 1 h | **Risk**: Low

**Spec reference**: FR-012, SC-001, SC-004, SC-006

**Prerequisite**: T014 complete and verified RED. Set the committed default budget from the size
T011 actually measured, not from the probe's figure.

Implement `scripts/check-web-bundle-budget.mjs` exactly to
[contracts/bundle-budget.md](./contracts/bundle-budget.md) — flags, exit codes, both assertions, the
failure text naming the overage and the newly-present packages, and `argv-contract` parsing.

**Verify GREEN**:
```bash
cd /home/coder/worktrees/077-web-bundle-diet
node --test scripts/__tests__/check-web-bundle-budget.test.mjs
node scripts/check-web-bundle-budget.mjs --selftest
node scripts/check-web-bundle-budget.mjs --dist /tmp/dist-077
```
**Expected GREEN**: 0 failures; selftest exits 0; the real export passes with the spare reported.

**Prove it bites**:
```bash
node scripts/check-web-bundle-budget.mjs --dist /tmp/dist-077 --budget 1000000
```
**Expected**: exit 1, naming measured, budget and overage.

---

### T016 — Add the `bundle-budget` nx target and wire it into CI

**Type**: Config change | **Time**: 30 min | **Risk**: Low

**Spec reference**: FR-012

1. `frontend/mcm-app/project.json` — add:
   ```json
   "bundle-budget": {
     "executor": "nx:run-commands",
     "options": { "command": "node scripts/check-web-bundle-budget.mjs --dist frontend/mcm-app/dist", "cwd": "{workspaceRoot}" },
     "dependsOn": ["export-server"],
     "cache": true
   }
   ```
2. `.forgejo/workflows/app-ci.yml` — add `bundle-budget` to the `affected` job's target list:
   `--target=lint,test,typecheck,bundle-budget`.

**Done when**: `pnpm nx bundle-budget mcm-app` exports if needed and passes, and a second run is a
cache hit. Verify with `--skip-nx-cache` once, since a stale nx cache can report a failure from a
path that no longer exists.

> From a worktree, any `pnpm nx` target dies in pnpm's deps check with `ERR_PNPM_UNSAFE_MODULES_DIR`
> unless a real `CI=true pnpm install --frozen-lockfile` has run **inside** the worktree (~4 min).
> The symlinked `node_modules` covers `node --test` and the gate scripts, not nx.

---

### T017 — Update the item, the runbook and the OpenWiki source

**Type**: Documentation | **Time**: 40 min | **Risk**: None

**Spec reference**: All

- Comment on backlog item #558 with the corrected baseline, the attribution table, the measured
  before/after, and why route splitting was rejected. **Amend its acceptance criteria** to the
  re-scoped ones (the operator approved this) — the original criteria name a mechanism measurement
  refutes, and an item that cannot be closed honestly against its own criteria is worse than none.
- [docs/runbooks/e2e-testing.md](../../docs/runbooks/e2e-testing.md) — record that a single web chunk
  now means a regression, and how to read the `perf-metrics` payload's deferred-chunk verdict.
- Do **not** hand-edit `openwiki/**` pages carrying a `resource`; they are derived and regenerate.
  The learning about the CopilotKit side-effect polyfill import belongs in the runbook above, which
  the relevant concept cites.

**Done when**: #558 carries the measurement comment and amended criteria; the runbook names the
two-chunk expectation; `pnpm nx okf-governance infrastructure-as-code` still passes.

---

## Platform Parity Table

Mandatory per the constitution's Frontend App Quality Standards. Every scenario, with its web
(Playwright) and mobile (Maestro) status, and a written justification for each N/A.

| Scenario | Web (Playwright) | Mobile (Maestro) | Justification for any N/A |
|---|---|---|---|
| US1-AC1 — cold `/home` excludes the assistant chunk | `perf.spec.ts` (T012) | **N/A** | Chunk splitting is a web-bundler behaviour. Native ships one Hermes bytecode bundle with no equivalent of a deferred HTTP chunk, so there is nothing to assert and no regression to catch. |
| US1-AC2 — the assistant still opens and accepts input | `assistant.spec.ts`, `assistant-query.spec.ts` (existing, re-run T013) | `assistant-add.yaml`, `agent-search.yaml` (existing) | — |
| US1-AC3 — a non-runnable config renders no dock | `assistant-config.spec.ts` (existing) | `assistant-config-disable.yaml` (existing) | — |
| US1-AC4 — idle prefetch, at most one fetch | Unit: `use-assistant-runtime.test.tsx`, `assistant-runtime-loader.test.ts` (T008, T006) | **N/A** | Deliberately not an E2E assertion on either platform: asserting on idle-callback timing through a browser is inherently flaky, and a flaky required check is not a check (the split recorded in `openwiki/invariants/testing-tiers.md`). The single-flight and scheduling contracts are fully determined at unit level. Native has no prefetch to test. |
| US1-AC5 — loading state, then opens | Unit: `assistant-dock.test.tsx` (T010) | **N/A** | Requires a controllable slow chunk response. Deterministic at unit level; an E2E version would need network throttling fine enough to land inside the load window, which is the flakiness this repo already refuses elsewhere. |
| US1-AC6 / FR-006 — chunk load fails, assistant stays recoverable | Unit: `assistant-dock.test.tsx` (T010) | **N/A** | Needs an injected import rejection, which only the unit seam provides. No native equivalent — there is no chunk to fail. |
| FR-008 — SSR hydration correct across the boundary | Every assistant spec in T013 | **N/A** | Native has no server-side rendering; hydration does not exist there. |
| US2-AC1 — no `src/bff-server` module in any client chunk | `check-no-server-imports.mjs` + the budget gate's zero-modules assertion (T004, T015) | **N/A** | A bundle-content property, not a UI behaviour. Asserted on the artifact, which is stronger than either UI suite. |
| US2-AC2 — run history renders identically | Unit: `backup-run-summary.test.ts` (T001) + `backups.spec.ts` (existing, re-run T013) | **N/A** | No existing Maestro flow covers the backups run-history view; this change is pure module relocation plus an output-identical formatter, and the exact-string unit assertions across five zones are a tighter check than a screenshot. Filing a mobile backups flow is out of scope here and belongs in the backlog. |
| US2-AC3 — a new server import fails the checks | `check-no-server-imports.test.mjs` (T003) | **N/A** | A repository gate, not app behaviour. |
| US3-AC1/AC2 — the budget reports and fails correctly | `check-web-bundle-budget.test.mjs` (T014) | **N/A** | A repository gate. |
| US3-AC3 — `perf-metrics` attached, ≥50% headroom | `perf.spec.ts` (T012) | **N/A** | The metric is a web transfer measurement. |
| FR-013 — native polyfills and behaviour unregressed | — | `assistant-add.yaml`, `agent-search.yaml`, `agent-add-ownership.yaml` (existing) | Web has no polyfill requirement; the assertion only means something on native. |

## Dependencies & Execution Order

### Phase dependencies

- **Phase 1 (US2)** → no dependencies. Ships independently.
- **Phase 2 (US1)** → independent of Phase 1 in code, but sequenced after it so US1's measurement is
  taken on a tree without the 70 KB leak and the two effects need no disentangling.
- **Phase 3 (US3)** → depends on Phase 2: the committed budget is set from the size T011 measured,
  and T012's assertions can only be GREEN once the deferral exists.

### Within each story

- T001 → T002 (test before implementation)
- T003 → T004 → T005
- T006 → T007; T008 → T009; both before T010 → T011
- T012 must be verified RED **against the pre-T011 tree**, then GREEN in T013
- T014 → T015 → T016
- T017 last — it quotes the final measured numbers

### Parallel opportunities

- T003 ‖ T001 — different files, no shared state
- T006 ‖ T008 — different files; both must precede T010
- T014 may be written while Phase 2's E2E runs

## Task Summary

| Phase | Story | Tasks | Test tasks | Est. |
|---|---|---|---|---|
| 1 | US2 (P2) | T001–T005 | T001, T003 | ~3 h |
| 2 | US1 (P1) | T006–T013 | T006, T008, T010, T012 | ~6 h |
| 3 | US3 (P3) | T014–T017 | T014 | ~3 h |

**MVP**: Phase 2 alone satisfies SC-001 through SC-004. Phase 1 is a correctness fix worth shipping
with it; Phase 3 is what stops the win being spent silently.

## Final Validation

Per [openwiki/invariants/feature-validation-checklist.md](../../openwiki/invariants/feature-validation-checklist.md),
and deriving the tiers from what the diff touches rather than from memory:

```bash
# Unit + lint + typecheck for every affected project
pnpm nx affected --target=lint,test,typecheck --base=origin/main --head=HEAD

# The two new gates and their selftests
node --test scripts/__tests__/check-no-server-imports.test.mjs scripts/__tests__/check-web-bundle-budget.test.mjs
node scripts/check-no-server-imports.mjs --selftest && node scripts/check-no-server-imports.mjs
node scripts/check-web-bundle-budget.mjs --selftest

# The budget against a real export
pnpm nx bundle-budget mcm-app --skip-nx-cache

# Web E2E — full suite; the diff touches the authenticated layout, so route scope is the whole app
cd frontend/mcm-app && MCM_REQUIRE_LIVE_STACK=1 pnpm exec playwright test

# Mobile agent flows — FR-013's only real check
pnpm nx e2e:agents mcm-app
```

**Check the skip count on every E2E run.** A skipped test reads as a pass, and
`MCM_REQUIRE_LIVE_STACK=1` is what converts a credential-driven skip into a failure.
