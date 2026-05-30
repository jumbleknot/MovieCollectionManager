# Quickstart: Test Suite Hardening (003-test-hardening)

**Branch**: `003-test-hardening` | **Spec**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md) | **Tasks**: [tasks.md](tasks.md)

---

## What this feature delivers

Infrastructure only — no production code changes. When complete:

- RTK compresses all test command output by ~89% before it reaches the agent context
- The full web E2E suite authenticates with Keycloak exactly once (global setup), not once per test or test file
- A seeded, typed fixture dataset (10 movies, 3 collections) is in place before any test runs
- All filter/search tests assert exact expected counts derived from the fixture — no more "at least one row"
- All write tests clean up via BFF API in `afterEach` hooks, not via UI interactions
- Platform parity tables exist for features 001, 002, and 003
- A reusable TDD checkpoint template governs all future feature test tasks

---

## Prerequisites

Before starting work on this branch:

1. **RTK must be active in your shell:**
   ```bash
   rtk init --global
   ```
   Verify after any test run: `rtk gain` must show >80% compression. Do not begin a session without this.

2. **Full stack must be running** (E2E tests require the complete stack):
   ```bash
   pnpm nx up-all infrastructure-as-code
   cd frontend/mcm-app && pnpm exec expo start --web --port 8081
   ```

3. **Mobile E2E** additionally requires:
   ```bash
   # Start Android emulator with -no-snapshot-load
   adb reverse tcp:8081 tcp:8081
   ```

---

## Execution order

Work the phases in order. Each phase is safe to stop and resume. Phases 0–1 have no code changes and can be done independently.

### Phase 0 — RTK + Documentation (do first, ~2 hrs, zero-risk)

```
T001  Install and verify RTK
T002  Add Prerequisites to CLAUDE.md
T003  Add Test Run Protocol to CLAUDE.md
T004  Add Feature Branch Scope and Final Validation Checklist to CLAUDE.md
```

These tasks have no code changes and no risk. Do them before any implementation work — they provide the RTK token efficiency and the written protocol that governs all subsequent sessions.

### Phase 1 — Reporter Configuration (~20 min, zero-risk)

```
T005  Configure Playwright dot reporter
T006  Configure Jest to suppress passing-test console output
```

Minor config changes. Verify with a test run before and after.

### Phase 2 — Fixture Infrastructure (~5 hrs, new files only)

```
T007  Create base-dataset.ts fixture constant
T008  Create global-setup.ts (Playwright global setup)
T009  Wire globalSetup + storageState into playwright.config.ts
T010  Create Maestro _setup-fixtures.yaml
T011  Add storageState opt-out to auth.spec.ts
```

Create the new files before wiring them. T008 requires the stack running (it authenticates and seeds data). T009 is the one that changes behavior for all existing tests — verify the full suite after T009.

### Phase 3 — Session Reuse Refactor (~2 hrs, existing files)

```
T012  Remove inline login from collections.spec.ts
T013  Remove inline login from movies.spec.ts
T014  Verify full web E2E suite passes with single login
```

Prerequisite: T009 must be complete. Run the full suite after T013 and confirm SC-001 (exactly 1 login).

### Phase 4 — Exact-Count Assertions (~2.5 hrs)

```
T015  Update filter tests in movies.spec.ts
T016  Update search tests in movies.spec.ts and collections.spec.ts
```

Prerequisite: T007 (fixture constant) and T009 (global setup seeds data). After assertion changes, verify RED before checking GREEN.

### Phase 5 — Cleanup Hardening (~3 hrs)

```
T017  Migrate collections.spec.ts teardown to afterEach + BFF API
T018  Migrate movies.spec.ts teardown to afterEach + BFF API
T019  Create cleanup-e2e-data.ts script
```

Can start in parallel with Phase 4. No prerequisite on exact-count assertions.

### Phase 6 — Parity Tables (~2–4 hrs depending on gaps found)

```
T020  Add parity table to 001 tasks.md
T021  Add parity table to 002 tasks.md
T022  Create any missing Maestro flows identified in T021
```

T020 and T021 are documentation-only. T022 may require creating actual Maestro flows if gaps are found. Count on 1–2 hours per new Maestro flow.

### Phase 7 — Template & Format (~2 hrs)

```
T023  Create docs/templates/feature-test-tasks-template.md
T024  Update remaining 002 tasks to TDD checkpoint format
```

Can be done anytime after Phase 0 establishes the CLAUDE.md structure.

---

## Key files created or modified

| File | Action | Phase |
|---|---|---|
| `frontend/mcm-app/CLAUDE.md` | Modified — adds Prerequisites, Protocol, Scope, Checklist | 0 |
| `frontend/mcm-app/playwright.config.ts` | Modified — adds globalSetup, storageState, reporter | 1, 2 |
| `frontend/mcm-app/jest.config.ts` | Modified — adds verbose: false | 1 |
| `frontend/mcm-app/tests/e2e/fixtures/base-dataset.ts` | **New** — typed fixture constant | 2 |
| `frontend/mcm-app/tests/e2e/web/setup/global-setup.ts` | **New** — Playwright global setup | 2 |
| `frontend/mcm-app/tests/e2e/web/setup/.auth/.gitkeep` | **New** — placeholder | 2 |
| `frontend/mcm-app/tests/e2e/mobile/_setup-fixtures.yaml` | **New** — Maestro fixture seed | 2 |
| `frontend/mcm-app/tests/e2e/web/auth.spec.ts` | Modified — storageState opt-out | 2 |
| `frontend/mcm-app/tests/e2e/web/collections.spec.ts` | Modified — remove login(), afterEach API teardown, exact counts | 3, 4, 5 |
| `frontend/mcm-app/tests/e2e/web/movies.spec.ts` | Modified — remove login(), afterEach API teardown, exact counts | 3, 4, 5 |
| `frontend/mcm-app/scripts/cleanup-e2e-data.ts` | **New** — on-demand test data cleanup | 5 |
| `specs/001-user-login/tasks.md` | Modified — adds parity table | 6 |
| `specs/002-manage-movie-collection/tasks.md` | Modified — adds parity table, updates tasks to TDD format | 6, 7 |
| `docs/templates/feature-test-tasks-template.md` | **New** — reusable template | 7 |

---

## Verifying success after each phase

After each phase, run the relevant subset before moving on:

```bash
# After Phase 1:
pnpm exec playwright test | head -5          # should show dots, not test names
pnpm nx test mcm-app | wc -l                 # should be significantly fewer lines

# After Phase 2 (T009):
pnpm exec playwright test                    # should pass; check for single login
rtk gain                                     # should show >80%

# After Phase 3:
pnpm nx e2e mcm-app                          # full suite; verify SC-001

# After Phase 4:
pnpm exec playwright test --grep "filter\|search"  # exact-count assertions pass

# After Phase 5:
pnpm exec playwright test                    # full suite with teardown hardening
cd frontend/mcm-app && npx ts-node scripts/cleanup-e2e-data.ts

# Final validation (all phases complete):
pnpm nx test mcm-app
pnpm nx test:integration mcm-app
pnpm nx e2e mcm-app
pnpm nx e2e:mobile mcm-app
pnpm nx lint mcm-app
rtk gain
```

---

## Non-obvious decisions to remember

- **`.auth/user.json` is gitignored** — each developer generates their own via global setup. Do not commit it.
- **E2E Browse collection is read-only by convention** — global setup repairs it on the next run if a test writes to it accidentally. Do not add a BFF enforcement mechanism.
- **afterEach silently swallows 404** — if a test already deleted the record it created, the afterEach DELETE returns 404. This is correct behavior; do not add error handling that surfaces 404s as failures.
- **Maestro cannot use Playwright storageState** — mobile tests use `_login-helper.yaml` for flows that test login UI; other flows use `launchApp: clearState: false` with `_setup-fixtures.yaml` handling data seeding.
- **RTK is not in package.json** — it is a system binary installed per machine via `rtk install --global`. Do not add it as an npm dependency.
