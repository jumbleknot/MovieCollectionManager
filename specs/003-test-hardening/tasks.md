# Tasks: Test Suite Hardening (003-test-hardening)

**Branch**: `003-test-hardening` | **Spec**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)

---

## Phase 0: Prerequisites & Documentation

> Zero-risk. Execute before any implementation work. Delivers RTK and CLAUDE.md guidance.

### T001 — Install and verify RTK

**Type**: Prerequisites | **Time**: 15 min | **Risk**: None

**Steps:**
1. Install RTK: follow per-platform instructions from the RTK docs
2. Activate: `rtk init --global`
3. Run any test command: `pnpm nx test mcm-app`
4. Verify compression: `rtk gain`

**Done when**: `rtk gain` reports >80% token compression after a test run (SC-002). A session must not begin without RTK active (FR-001).

---

### T002 — Add Prerequisites section to CLAUDE.md

**Type**: Documentation | **Time**: 10 min | **Risk**: None

**File**: `CLAUDE.md` (repo root — the authoritative agent doc Claude Code loads for this workspace) — add under `## Testing Requirements`:

```markdown
### Prerequisites (mandatory before starting any AI-assisted session)

- **RTK (Rust Token Killer)** must be installed and active:
  ```bash
  rtk init --global   # activate in this shell
  rtk gain            # verify >80% compression after first test run
  ```
  RTK compresses test output reaching the agent context by ~89%.
  A session must not begin without RTK active.
```

**Done when**: CLAUDE.md contains the Prerequisites section.

---

### T003 — Add Test Run Protocol to CLAUDE.md

**Type**: Documentation | **Time**: 20 min | **Risk**: None

**File**: `CLAUDE.md` (repo root — the authoritative agent doc Claude Code loads for this workspace) — add under `## Testing Requirements`:

> Nx targets are the primary invocation path. The direct `pnpm exec playwright`/`maestro test` calls
> below are permitted ONLY for single-test granularity, which has no Nx target (matches the standing
> exception in root CLAUDE.md). Step 3 (full suite) MUST use Nx targets.

```markdown
### Test Run Protocol

Execute in this order after every code change:

1. **Isolated test** (fastest; run first for any failure):
   ```bash
   pnpm exec playwright test --grep "test name"           # web E2E
   maestro test tests/e2e/mobile/flow.yaml --env ...      # mobile E2E
   pnpm nx test mcm-app -- --testNamePattern "test name"  # unit
   ```

2. **User-story suite** (after isolated test passes):
   ```bash
   pnpm exec playwright test tests/e2e/web/movies.spec.ts
   ```

3. **Full suite** (final validation only — not after every change):
   ```bash
   pnpm nx e2e mcm-app && pnpm nx e2e:mobile mcm-app && pnpm nx test mcm-app
   ```
```

**Done when**: CLAUDE.md contains the Test Run Protocol section (FR-011).

---

### T004 — Add Feature Branch Test Scope and Final Validation Checklist to CLAUDE.md

**Type**: Documentation | **Time**: 30 min | **Risk**: None

**File**: `CLAUDE.md` (repo root — the authoritative agent doc Claude Code loads for this workspace) — add under `## Testing Requirements`:

**Feature Branch Test Scope** (story → test file map, features 001 and 002):

```markdown
### Feature Branch Test Scope

| User Story | Web Test File | Mobile Flow |
|---|---|---|
| 001-US1: Registration | auth.spec.ts | registration-navigation.yaml, registration-full.yaml, registration-validation.yaml |
| 001-US2: Login | auth.spec.ts | login-keycloak.yaml, login-screen.yaml, login-invalid.yaml, login-verified-banner.yaml |
| 001-US3: Profile / access control | auth.spec.ts | auth-guard.yaml, home-screen.yaml |
| 001-US4: Logout | auth.spec.ts | logout.yaml |
| 001: Session timeout | session-timeout.spec.ts | session-timeout.yaml, session-timeout-absolute.yaml |
| 002-US1: Browse collections | collections.spec.ts | collection-browse.yaml |
| 002: Manage collections | collections.spec.ts | collection-create.yaml, collection-edit.yaml, collection-delete.yaml |
| 002-US2: Manage movies | movies.spec.ts | movie-add.yaml, movie-edit.yaml, movie-delete.yaml |
| 002: Search / filter movies | movies.spec.ts | movie-browse.yaml, movie-search-filter.yaml |
| 002-US3: Default collection | movies.spec.ts | N/A (web routing behavior) |
| 002-US4: Column visibility | movies.spec.ts | N/A (native layout, no column toggle) |
```

**Final Validation Checklist:**

```markdown
### Final Validation Checklist

Run all of the following before marking any feature complete:

- [ ] `pnpm nx test mcm-app` — unit tests pass (≥70% line coverage)
- [ ] `pnpm nx test:integration mcm-app` — integration tests pass
- [ ] `pnpm nx e2e mcm-app` — web E2E passes (single login via global setup)
- [ ] `pnpm nx e2e:mobile mcm-app` — mobile E2E passes
- [ ] `pnpm nx lint mcm-app` — no lint errors
- [ ] `pnpm nx test mc-service` — Rust unit tests pass
- [ ] `pnpm nx test:integration mc-service` — Rust integration tests pass
- [ ] `rtk gain` — >80% token compression confirmed
- [ ] Platform parity table updated for this feature
- [ ] `docs/templates/feature-test-tasks-template.md` format followed for all test tasks
```

**Done when**: CLAUDE.md contains both sections (FR-012, FR-013, SC-004).

---

## Phase 1: Reporter Configuration

> Minimal config changes. Reduces base verbosity of test output to complement RTK.

### T005 — Configure Playwright dot reporter

**Type**: Config change | **Time**: 10 min | **Risk**: None

**File**: `frontend/mcm-app/playwright.config.ts`

Add `reporter: 'dot'` to the config object. Combined with RTK, this means a passing run produces a single compressed summary line — not test-name-per-line output.

**Verify before:**
```bash
pnpm exec playwright test 2>&1 | head -20
```
Note the current reporter format (likely `list` or default).

**Verify after:**
```bash
pnpm exec playwright test 2>&1 | head -5
```
**Expected**: Dots and a final summary line. No per-test-name output (FR-002).

**Done when**: Playwright passing output shows dot-per-test, not full test names.

---

### T006 — Configure Jest to suppress passing-test console output

**Type**: Config change | **Time**: 10 min | **Risk**: None

**File**: `frontend/mcm-app/jest.config.ts` (or `jest.config.js`)

Add `verbose: false`. Optionally add `silent: true` to suppress `console.*` output from passing tests. If `silent: true` strips failure output, use a custom `testResultsProcessor` or leave at `silent: false` with `verbose: false` only.

**Verify after:**
```bash
pnpm nx test mcm-app 2>&1 | wc -l
```
**Expected**: Significantly fewer lines than before. No individual `console.log` lines from passing tests (FR-003).

**Done when**: Passing unit test run produces a summary line only, no test-body console output.

---

## Phase 2: Fixture Infrastructure

> New files only. Does not yet modify existing tests.

### T007 — Create typed fixture constant

**Type**: New file (test infrastructure) | **Time**: 30 min | **Risk**: None

**File**: `frontend/mcm-app/tests/e2e/fixtures/base-dataset.ts`

Define and export:

```typescript
export const FIXTURE_COLLECTIONS = {
  BROWSE:   'E2E Browse',    // read-only; search/filter/column tests
  MUTATION: 'E2E Mutation',  // write tests create/delete here; reset to empty on setup
  DEFAULT:  'E2E Default',   // FR-009 auto-redirect test
} as const;

export type FixtureCollection = typeof FIXTURE_COLLECTIONS[keyof typeof FIXTURE_COLLECTIONS];

export interface FixtureMovie {
  id: string;
  title: string;
  contentType: 'Movie' | 'Series' | 'Concert';
  rated: string;
  owned: boolean;
  ripped: boolean;
  ownedMedia: string[];
  genres: string[];
  decade: string;
}

export const FIXTURE_MOVIES: FixtureMovie[] = [
  { id: 'M1',  title: 'Alpha',   contentType: 'Movie',   rated: 'R',       owned: true,  ripped: true,  ownedMedia: ['Blu-Ray'],     genres: ['Action'],           decade: '2010s' },
  { id: 'M2',  title: 'Beta',    contentType: 'Series',  rated: 'PG',      owned: false, ripped: false, ownedMedia: [],              genres: ['Drama'],            decade: '2000s' },
  { id: 'M3',  title: 'Gamma',   contentType: 'Concert', rated: 'NR',      owned: true,  ripped: false, ownedMedia: ['DVD'],          genres: ['Music'],            decade: '1990s' },
  { id: 'M4',  title: 'Delta',   contentType: 'Movie',   rated: 'G',       owned: true,  ripped: true,  ownedMedia: ['UHD Blu-Ray'],  genres: ['Family', 'Comedy'], decade: '2020s' },
  { id: 'M5',  title: 'Epsilon', contentType: 'Series',  rated: 'PG-13',   owned: false, ripped: false, ownedMedia: [],              genres: ['Thriller'],         decade: '2010s' },
  { id: 'M6',  title: 'Zeta',    contentType: 'Movie',   rated: 'NC-17',   owned: true,  ripped: true,  ownedMedia: ['Blu-Ray 3D'],   genres: ['Horror'],           decade: '1980s' },
  { id: 'M7',  title: 'Eta',     contentType: 'Movie',   rated: 'Unrated', owned: false, ripped: false, ownedMedia: [],              genres: ['Documentary'],      decade: '1970s' },
  { id: 'M8',  title: 'Theta',   contentType: 'Series',  rated: 'R',       owned: true,  ripped: false, ownedMedia: ['DVD'],          genres: ['Action', 'Drama'],  decade: '2000s' },
  { id: 'M9',  title: 'Iota',    contentType: 'Concert', rated: 'G',       owned: true,  ripped: true,  ownedMedia: ['Blu-Ray'],      genres: ['Classical'],        decade: '2020s' },
  { id: 'M10', title: 'Kappa',   contentType: 'Movie',   rated: 'PG',      owned: false, ripped: false, ownedMedia: [],              genres: ['Animation'],        decade: '1990s' },
];
```

**Verify RED** (before file exists — attempt import in global-setup.ts stub):
```bash
cd frontend/mcm-app && pnpm exec tsc --noEmit
```
**Expected RED**: TypeScript error — cannot find module `../../fixtures/base-dataset`.

**Verify GREEN** (after file created):
```bash
cd frontend/mcm-app && pnpm exec tsc --noEmit
```
**Expected GREEN**: 0 TypeScript errors. Confirm in node REPL: `FIXTURE_MOVIES.length === 10`.

**Done when**: File exists; exports pass `tsc --noEmit`; `FIXTURE_MOVIES` has exactly 10 entries (FR-007).

---

### T008 — Create Playwright global setup

**Type**: New file (test infrastructure) | **Time**: 2 hrs | **Risk**: Medium — requires Keycloak + BFF running

**File**: `frontend/mcm-app/tests/e2e/web/setup/global-setup.ts`

Implement the full setup flow (see plan.md Architecture section):

1. POST `/bff-api/auth/init` → check if already authenticated
2. If not authenticated: run full Keycloak OIDC flow via Playwright's `chromium.launch()` → save storageState to `./tests/e2e/web/setup/.auth/user.json`
3. GET `/bff-api/collections` → check whether BROWSE, MUTATION, DEFAULT collections exist
4. If any missing: POST `/bff-api/collections` to create each
5. For BROWSE: GET `/bff-api/collections/{id}/movies` → verify movies match `FIXTURE_MOVIES`; POST to create any missing
6. For MUTATION: DELETE all movies (reset to empty)

**Also create**: `frontend/mcm-app/tests/e2e/web/setup/.auth/.gitkeep`

**Add to `.gitignore`** (if not already): `tests/e2e/web/setup/.auth/user.json`

**Verify RED** (compile check before wiring):
```bash
cd frontend/mcm-app && pnpm exec tsc --noEmit
```
**Expected RED**: TypeScript errors if imports are wrong; fix until clean.

**Verify GREEN** (after T009 wires it in): Covered by T009 GREEN verification.

**Done when**: File exists; compiles; implements all 6 steps; `.gitkeep` placeholder committed (FR-005, FR-008, FR-009).

---

### T009 — Wire global setup and storageState into playwright.config.ts

**Type**: Config change | **Time**: 30 min | **Risk**: Medium — affects all E2E tests

**File**: `frontend/mcm-app/playwright.config.ts`

```typescript
export default defineConfig({
  globalSetup: './tests/e2e/web/setup/global-setup.ts',
  use: {
    storageState: './tests/e2e/web/setup/.auth/user.json',
    // ... existing use config ...
  },
  reporter: 'dot',  // from T005
  // ... rest of config ...
});
```

**Verify RED** (before this change, after T008 exists):

Run the suite and count login flows:
```bash
pnpm exec playwright test 2>&1 | grep -c "keycloak\|sign.in\|login"
```
**Expected RED**: Count > 1 (multiple login flows, one per test file or beforeEach).

**Verify GREEN** (after wiring):
```bash
pnpm exec playwright test 2>&1 | grep -c "keycloak\|sign.in\|login"
```
**Expected GREEN**: Count = 0 in individual test output (Keycloak only appears in global setup banner, not in per-test output). Full suite passes (SC-001, FR-004).

**Done when**: Full web E2E suite runs; exactly 1 identity provider authentication per run.

---

### T010 — Create Maestro fixture setup helper

**Type**: New file (mobile test infrastructure) | **Time**: 1 hr | **Risk**: Low

**File**: `frontend/mcm-app/tests/e2e/mobile/_setup-fixtures.yaml`

```yaml
# Called from the Nx e2e:mobile target before any flow runs.
# Uses evalScript + fetch() to seed fixture data via the BFF API.
---
- runFlow: "_login-helper.yaml"

- evalScript: |
    const baseUrl = 'http://localhost:8081';
    const res = http.get(baseUrl + '/bff-api/collections');
    const collections = JSON.parse(res.body);
    const names = ['E2E Browse', 'E2E Mutation', 'E2E Default'];
    // create any missing collections, seed BROWSE, reset MUTATION
```

Wire into `project.json` `e2e:mobile` target as a pre-step or first flow in the run sequence.

**Verify RED** (without this helper — run a filter flow against a clean environment):
```bash
maestro test tests/e2e/mobile/movie-browse.yaml --env E2E_TEST_USER=... --env E2E_TEST_PASSWORD=...
```
**Expected RED**: Flow fails or produces inconsistent results due to missing fixture data.

**Verify GREEN** (after helper is wired):
```bash
pnpm nx e2e:mobile mcm-app
```
**Expected GREEN**: All mobile flows pass with consistent fixture data present (FR-007, FR-008).

**Done when**: Helper exists; wired as pre-test step; mobile flows find fixture collections (FR-008).

---

### T011 — Add storageState opt-out to auth.spec.ts

**Type**: Test modification | **Time**: 20 min | **Risk**: Low

**Scenarios covered**: US2-AC2 — tests that exercise authentication flows must opt out of the inherited session.

**File**: `frontend/mcm-app/tests/e2e/web/auth.spec.ts`

Add at the top of each `test.describe` block that tests unauthenticated flows:

```typescript
test.use({ storageState: undefined });
```

**Verify RED** (after T009 wires global storageState — before adding opt-out):
```bash
pnpm exec playwright test tests/e2e/web/auth.spec.ts
```
**Expected RED**: Auth tests that expect to be unauthenticated fail because they inherit the authenticated session from global setup. Tests like "redirects unauthenticated user to login" pass vacuously (page never shows login).

**Verify GREEN** (after adding `test.use({ storageState: undefined })`):
```bash
pnpm exec playwright test tests/e2e/web/auth.spec.ts
```
**Expected GREEN**: All auth tests pass; unauthenticated tests correctly start without a session (FR-006).

**Done when**: All auth tests pass; unauthenticated flows correctly see the login screen.

---

## Phase 3: Session Reuse Refactor

> Modifies existing spec files. Removes redundant login() calls. All tests must continue to pass.

### T012 — Remove inline login from collections.spec.ts

**Type**: Refactor (existing test file) | **Time**: 45 min | **Risk**: Low — tests should still pass

**Scenarios covered**: US2-AC1 — E2E tests begin in authenticated state without triggering identity provider redirect.

**File**: `frontend/mcm-app/tests/e2e/web/collections.spec.ts`

Changes:
1. Delete the `async function login(page)` helper
2. Remove all `await login(page)` calls from `beforeEach` blocks
3. Session is now inherited from global setup via `storageState`

**Pre-check** (baseline before changes):
```bash
pnpm exec playwright test tests/e2e/web/collections.spec.ts
```
**Expected**: All tests pass.

**Verify GREEN** (after removing login()):
```bash
pnpm exec playwright test tests/e2e/web/collections.spec.ts
```
**Expected GREEN**: Same tests pass without the `login()` calls. Any test that fails was implicitly depending on login() for state beyond authentication — investigate and fix (FR-004).

**Done when**: collections.spec.ts has no `login()` function or calls; all collection tests pass.

---

### T013 — Remove inline login from movies.spec.ts

**Type**: Refactor (existing test file) | **Time**: 45 min | **Risk**: Low

**Scenarios covered**: US2-AC1

**File**: `frontend/mcm-app/tests/e2e/web/movies.spec.ts`

Changes:
1. Delete the `async function login(page)` helper
2. Remove all `await login(page)` calls from `beforeEach` blocks
3. Update any test that navigates to "first collection card" to navigate to `FIXTURE_COLLECTIONS.BROWSE` by name instead

```typescript
import { FIXTURE_COLLECTIONS } from '../../fixtures/base-dataset';
// ...
await page.getByText(FIXTURE_COLLECTIONS.BROWSE).click();
```

**Pre-check** (baseline):
```bash
pnpm exec playwright test tests/e2e/web/movies.spec.ts
```

**Verify GREEN** (after refactor):
```bash
pnpm exec playwright test tests/e2e/web/movies.spec.ts
```
**Expected GREEN**: All movie tests pass; no login() calls remain; navigation tests use named fixture collection (FR-004).

**Done when**: movies.spec.ts has no `login()` function or calls; all movie tests pass.

---

### T014 — Verify full web E2E suite passes with single login

**Type**: Verification | **Time**: 15 min | **Risk**: None

**After T011–T013 complete:**

```bash
pnpm nx e2e mcm-app
```
**Expected GREEN**: Full suite passes.

Count login flows:
```bash
pnpm exec playwright test --reporter=list 2>&1 | grep -i "keycloak\|redirect.*login\|auth.*flow" | wc -l
```
**Expected**: 0 in per-test output (SC-001).

Verify compression:
```bash
rtk gain
```
**Expected**: >80% (SC-002).

**Done when**: Full web E2E suite passes; SC-001 and SC-002 satisfied.

---

## Phase 4: Exact-Count Assertions

> Updates search/filter tests to use fixture-derived expected counts. Tests will go RED until fixture is active.

### T015 — Update movies.spec.ts filter tests with exact-count assertions

**Type**: Test update | **Time**: 1 hr | **Risk**: Low — RED until global setup is active

**Scenarios covered** (from plan.md fixture counts):

| Filter | Assertion value | Fixture movies |
|--------|----------------|----------------|
| contentType = Movie | 5 | M1, M4, M6, M7, M10 |
| contentType = Series | 3 | M2, M5, M8 |
| contentType = Concert | 2 | M3, M9 |
| owned = true | 6 | M1, M3, M4, M6, M8, M9 |
| ripped = true | 4 | M1, M4, M6, M9 |
| genre = Action | 2 | M1, M8 |
| decade = 2010s | 2 | M1, M5 |
| decade = 1980s | 1 | M6 |
| rated = R | 2 | M1, M8 |

**File**: `frontend/mcm-app/tests/e2e/web/movies.spec.ts`

Replace `expect(rows.length).toBeGreaterThan(0)` with exact counts derived from `FIXTURE_MOVIES`:

```typescript
import { FIXTURE_MOVIES, FIXTURE_COLLECTIONS } from '../../fixtures/base-dataset';

// Example — filter by contentType:
const expected = FIXTURE_MOVIES.filter(m => m.contentType === 'Movie').length; // 5
await expect(page.getByRole('row', { name: /Alpha|Delta|Zeta|Eta|Kappa/ })).toHaveCount(expected);
// or count table data rows directly
```

**Verify RED** (change assertions, temporarily disable global setup seeding, run):
```bash
pnpm exec playwright test tests/e2e/web/movies.spec.ts --grep "filter"
```
**Expected RED**: Tests fail — `Expected 5, received 0` (or whatever the actual unseeded count is). This confirms assertions are no longer vacuous.

**Verify GREEN** (with global setup active and BROWSE collection seeded):
```bash
pnpm exec playwright test tests/e2e/web/movies.spec.ts --grep "filter"
```
**Expected GREEN**: All filter tests pass with exact fixture-derived counts (SC-003, FR-010).

**Done when**: All filter assertions use exact counts from `FIXTURE_MOVIES`; tests pass with global setup.

---

### T016 — Update search tests with exact-count assertions

**Type**: Test update | **Time**: 30 min | **Risk**: Low

**Scenarios covered**: US3-AC2 — search tests assert exact expected counts.

**Files**: `movies.spec.ts`, `collections.spec.ts`

Derive expected counts from `FIXTURE_MOVIES` for title-search scenarios. Example:

```typescript
// "Search for 'a' in title" — movies whose titles contain 'a' (case-insensitive):
const expected = FIXTURE_MOVIES.filter(m => m.title.toLowerCase().includes('a')).length;
// Alpha, Delta, Gamma, Kappa, Eta = 5
```

**Verify RED** (after assertion changes, before fixture seeding):
```bash
pnpm exec playwright test tests/e2e/web/movies.spec.ts --grep "search"
pnpm exec playwright test tests/e2e/web/collections.spec.ts --grep "search"
```
**Expected RED**: Exact-count assertions fail with actual vs expected mismatch.

**Verify GREEN** (with global setup active):
```bash
pnpm exec playwright test tests/e2e/web/movies.spec.ts --grep "search"
pnpm exec playwright test tests/e2e/web/collections.spec.ts --grep "search"
```
**Expected GREEN**: All search tests pass with fixture-derived counts (SC-003).

**Done when**: All search tests assert exact expected counts; tests pass with seeded fixture.

---

## Phase 5: Cleanup Hardening

> Migrates teardown from test bodies to afterEach hooks using the BFF API.

### T017 — Migrate collections.spec.ts teardown to afterEach + BFF API

**Type**: Test refactor | **Time**: 1 hr | **Risk**: Low

**Scenarios covered**: US6-AC1 — post-test hook teardown via BFF API, independent of UI state.

**File**: `frontend/mcm-app/tests/e2e/web/collections.spec.ts`

For each write test that creates a collection, apply the pattern from plan.md:

```typescript
let createdId: string | undefined;

test.afterEach(async ({ request }) => {
  if (createdId) {
    await request.delete(
      `/bff-api/collections/${createdId}`,
      { headers: { Cookie: await getSessionCookie() } }
    ).catch(() => {}); // silently swallow 404 if already deleted
    createdId = undefined;
  }
});

test('creates a collection', async ({ page }) => {
  // ... UI interaction to create ...
  createdId = extractIdFromUrl(page.url()); // capture for afterEach
  // ... assertions only — no teardown here ...
});
```

**Verify RED** (simulate mid-test failure before migration):
1. Add `throw new Error('simulated')` after collection creation in one test
2. Run suite — first run records the leftover data
3. Run suite again — confirm second run fails due to leftover collection name conflict
**Expected RED**: Second run fails with "collection already exists" or similar.

**Verify GREEN** (after afterEach migration):
1. Re-add `throw new Error('simulated')` (or leave it)
2. Run suite — afterEach API call cleans up despite the throw
3. Run suite again
```bash
pnpm exec playwright test tests/e2e/web/collections.spec.ts
```
**Expected GREEN**: Second run passes — no leftover data (SC-007, FR-014).

**Done when**: All write tests in collections.spec.ts use afterEach + BFF API teardown; no in-body UI teardown remains.

---

### T018 — Migrate movies.spec.ts teardown to afterEach + BFF API

**Type**: Test refactor | **Time**: 1 hr | **Risk**: Low

**Scenarios covered**: US6-AC1

**File**: `frontend/mcm-app/tests/e2e/web/movies.spec.ts`

Same pattern as T017. For each write test that creates a movie:

```typescript
let createdMovieId: string | undefined;

test.afterEach(async ({ request }) => {
  if (createdMovieId) {
    await request.delete(
      `/bff-api/collections/${FIXTURE_COLLECTIONS.MUTATION}/movies/${createdMovieId}`,
      { headers: { Cookie: await getSessionCookie() } }
    ).catch(() => {});
    createdMovieId = undefined;
  }
});
```

**Verify RED** (simulate failure before migration):
Same as T017 — force a mid-test throw, confirm second run fails due to leftover movie.

**Verify GREEN**:
```bash
pnpm exec playwright test tests/e2e/web/movies.spec.ts
```
**Expected GREEN**: Second run passes regardless of whether the first run threw mid-test (SC-007, FR-014).

**Done when**: All write tests in movies.spec.ts use afterEach + BFF API teardown exclusively.

---

### T019 — Create cleanup-e2e-data.ts script

**Type**: New file (utility script) | **Time**: 1 hr | **Risk**: None

**Scenarios covered**: US6-AC2 — on-demand cleanup after crashed test run.

**File**: `frontend/mcm-app/scripts/cleanup-e2e-data.ts`

```typescript
// Authenticates via BFF, then deletes test-prefixed collections AND orphaned test users.
const TEST_PREFIXES = ['E2E ', 'Playwright ', 'Maestro '];
const TEST_USER_PREFIXES = ['e2e_'];

async function main() {
  // 1. GET /bff-api/auth/init → obtain session cookie
  // 2. GET /bff-api/collections → list all collections
  // 3. Filter collections whose name starts with any TEST_PREFIX
  // 4. DELETE each matching collection
  // 5. List users via the admin-backed BFF endpoint; DELETE those whose username starts with any TEST_USER_PREFIX
  // 6. Log count of deleted collections and users; exit 0
}
```

**Verify RED** (before script exists — crash a test run, observe leftover data):
```bash
# Confirm leftover E2E collections exist:
curl http://localhost:8081/bff-api/collections | jq '[.[] | select(.name | startswith("E2E "))]'
```
**Expected RED**: One or more E2E-prefixed collections remain from the crashed run.

**Verify GREEN** (after script created):
```bash
cd frontend/mcm-app && npx ts-node scripts/cleanup-e2e-data.ts
```
**Expected GREEN**: Script exits 0; logs "Deleted N test collections". Re-running shows "Deleted 0 test collections" (SC-008, FR-015).

**Done when**: Script exists; successfully deletes all test-prefixed collections; handles "none found" gracefully.

---

## Phase 6: Platform Parity Tables

> Adds parity tables for features 001, 002, and 003. Verifies existing mobile flows (most already exist).

### T020 — Add Platform Parity table to specs/001-user-login/tasks.md

**Type**: Documentation | **Time**: 30 min | **Risk**: None

**File**: `specs/001-user-login/tasks.md` — add section:

```markdown
## Platform Parity Table

| Scenario | Web (Playwright) | Mobile (Maestro) | Status |
|---|---|---|---|
| US1-AC1: Registration form displayed | auth.spec.ts | registration-navigation.yaml | ✅ |
| US1-AC2: Valid registration creates account | auth.spec.ts | registration-full.yaml | ✅ |
| US1-AC6: Invalid registration shows error | auth.spec.ts | registration-validation.yaml | ✅ |
| US1: Email verification | auth.spec.ts | email-verification.yaml | ✅ |
| US2-AC1: Login with valid credentials | auth.spec.ts | login-keycloak.yaml | ✅ |
| US2: Login screen displayed | auth.spec.ts | login-screen.yaml | ✅ |
| US2-AC2: Invalid credentials shows error | auth.spec.ts | login-invalid.yaml | ✅ |
| US2: Verified banner on login | auth.spec.ts | login-verified-banner.yaml | ✅ |
| US3-AC1: Access control / auth guard | auth.spec.ts | auth-guard.yaml, home-screen.yaml | ✅ |
| US4-AC1: Logout terminates session | auth.spec.ts | logout.yaml | ✅ |
| Session timeout (idle + absolute) | session-timeout.spec.ts | session-timeout.yaml, session-timeout-absolute.yaml | ✅ |
```

All listed mobile flows exist in `tests/e2e/mobile/`; confirm each passes via `pnpm nx e2e:mobile mcm-app`. Registration is **not** web-only — native registration flows exist.

**Done when**: Parity table exists in 001 tasks.md; all scenarios either ✅ or have a written N/A justification (SC-005, FR-016, FR-017).

---

### T021 — Add Platform Parity table to specs/002-manage-movie-collection/tasks.md

**Type**: Documentation | **Time**: 45 min | **Risk**: None

**File**: `specs/002-manage-movie-collection/tasks.md` — add section:

```markdown
## Platform Parity Table

| Scenario | Web (Playwright) | Mobile (Maestro) | Status |
|---|---|---|---|
| US1-AC1: Browse collections | collections.spec.ts | collection-browse.yaml | ✅ |
| Create collection | collections.spec.ts | collection-create.yaml | ✅ |
| Edit collection | collections.spec.ts | collection-edit.yaml | ✅ |
| Delete collection | collections.spec.ts | collection-delete.yaml | ✅ |
| US1-AC2: Filter by contentType | movies.spec.ts | movie-browse.yaml, movie-search-filter.yaml | ✅ |
| US1-AC3: Filter by owned/ripped/ownedMedia | movies.spec.ts | movie-search-filter.yaml | ✅ |
| US1-AC4: Filter by decade | movies.spec.ts | movie-search-filter.yaml | ✅ |
| US1-AC5: Search by title | movies.spec.ts | movie-search-filter.yaml | ✅ |
| US2-AC1: Add movie | movies.spec.ts | movie-add.yaml | ✅ |
| US2-AC2: Edit movie | movies.spec.ts | movie-edit.yaml | ✅ |
| US2-AC3: Delete movie | movies.spec.ts | movie-delete.yaml | ✅ |
| US3-AC1: Auto-redirect to default collection | movies.spec.ts | N/A — web routing behavior only | N/A |
| US4-AC1: Column visibility toggle | movies.spec.ts | N/A — mobile uses native layout without column toggle | N/A |
```

All non-N/A mobile flows already exist in `tests/e2e/mobile/`; T022 is verification, not authoring.

**Done when**: Parity table exists in 002 tasks.md; all ❌ gaps assigned to T022 or marked N/A with justification (SC-005, SC-006).

---

### T022 — Verify mobile flows for the T020/T021 parity tables

**Type**: Verification (mobile E2E) | **Time**: 30 min | **Risk**: None

**Scenarios covered**: US5-AC1 — every test scenario has both web and mobile coverage, or a written N/A justification.

The T020/T021 review confirmed that every non-N/A flow already exists in `tests/e2e/mobile/`
(`movie-edit.yaml`, `movie-delete.yaml`, `collection-edit.yaml`, `collection-delete.yaml`, etc.).
This task verifies they pass; author a new flow ONLY if a future parity row is genuinely missing.

**Verify**:
```bash
pnpm nx e2e:mobile mcm-app
```
**Expected**: All mobile flows referenced in the T020/T021 tables pass. For any failing or absent
flow, either fix/author it (pattern: `movie-add.yaml` — `_login-helper.yaml`, `clearState: false`,
operates in `E2E Mutation`) or record a written N/A justification in the relevant table.

**Done when**: Every non-N/A row in the T020/T021 tables maps to a passing mobile flow; `pnpm nx e2e:mobile mcm-app` passes (SC-006).

---

## Phase 7: Template & Format Rollout

> Creates the reusable template. Updates remaining feature 002 tasks to TDD checkpoint format.

### T023 — Create docs/templates/feature-test-tasks-template.md

**Type**: New file (documentation template) | **Time**: 45 min | **Risk**: None

**File**: `docs/templates/feature-test-tasks-template.md`

The template must include:
- Standard task header format (type, time, risk, spec reference)
- Scenarios block format
- Verify RED block (command + expected output)
- Verify GREEN block (command + expected output)
- Platform Parity Table format with column definitions
- Example test task + paired implementation task
- Notes on when RED/GREEN does not apply (documentation and config tasks)

See [feature-test-tasks-template.md](../../docs/templates/feature-test-tasks-template.md) for the complete template.

**Update `CLAUDE.md`** (repo root — add to `## Testing Requirements`):

```markdown
### Feature Test Task Template

All test tasks for new features must follow the format defined in
`docs/templates/feature-test-tasks-template.md`. The template provides:
- TDD checkpoint format (Scenarios, Verify RED, Verify GREEN)
- Platform Parity Table format
- Example task pairs
```

**Done when**: Template exists at `docs/templates/feature-test-tasks-template.md`; CLAUDE.md references it (SC-010, FR-020).

---

### T024 — Update remaining feature 002 tasks to TDD checkpoint format

**Type**: Documentation update | **Time**: 1 hr | **Risk**: None

**File**: `specs/002-manage-movie-collection/tasks.md`

For every task not yet marked complete that involves writing or modifying a test:

1. Add a **Scenarios** block listing which spec scenarios the task covers
2. Add a **Verify RED** command with expected output (failure count and message)
3. Add a paired implementation task (or annotate the existing implementation task) with a **Verify GREEN** command and expected output

Single-line tasks that are purely implementation or documentation do not require RED/GREEN.

**Done when**: All future-facing test tasks in 002 tasks.md follow the TDD checkpoint format from `docs/templates/feature-test-tasks-template.md` (SC-009 applied retroactively).

---

### T025 — Add Platform Parity table for feature 003

**Phase**: 6 (Parity Tables) | **Type**: Documentation | **Time**: 20 min | **Risk**: None

**Scenarios covered**: FR-016 / FR-017 applied to this feature; satisfies the 003 portion of SC-005.

**File**: `specs/003-test-hardening/tasks.md` — add the section below. Several stories are pure
infrastructure/process with no UI flow, so they are justifiably N/A on both platforms.

```markdown
## Platform Parity Table

| Scenario | Web | Mobile | Status |
|---|---|---|---|
| US1 Token-efficient output | N/A — toolchain/process, not a UI flow | N/A — same | N/A |
| US2 Single-login session | global-setup.ts (saved session) | _login-helper.yaml + launchApp clearState:false | ✅ (framework-specific mechanism; justified) |
| US3 Seeded fixture | global-setup.ts | _setup-fixtures.yaml | ✅ |
| US4 Test run protocol | N/A — documentation | N/A — documentation | N/A |
| US5 Parity tracking | N/A — documentation | N/A — documentation | N/A |
| US6 Reliable cleanup | afterEach + backend API; cleanup script | in-flow API / _cleanup-named-collection.yaml | ✅ |
| US7 TDD checkpoints | N/A — process/docs | N/A — process/docs | N/A |
```

**Done when**: The 003 parity table exists; every US row has both columns filled or a written N/A justification (SC-005, FR-016).

---

### T026 — Smoke-test global-setup idempotency

**Phase**: 2 (Fixture Infrastructure) | **Type**: Test (test-infrastructure coverage) | **Time**: 30 min | **Risk**: Low

**Scenarios covered**: US3-AC1/AC3/AC4 — verify-or-create and write-collection reset behave correctly; gives the test-support utility behavioral coverage (addresses the TDD-coverage exemption noted in plan.md Constitution Check).

**Verify RED** (before global-setup.ts implements verify-or-create):
Run global setup twice against a clean environment.
**Expected RED**: Second run re-creates fixture data or fails to detect existing fixtures.

**Verify GREEN** (after T008):
```bash
pnpm nx e2e mcm-app   # triggers global setup; run twice
```
**Expected GREEN**: First run seeds the fixture; second run detects it and creates 0 new records,
resets the MUTATION collection to empty, and repairs any drift in BROWSE.

**Done when**: Running global setup twice is idempotent (0 duplicate fixtures, MUTATION reset, BROWSE repaired).

---

### T027 — Migrate feature-001 E2E write-test teardown + test-user cleanup

**Phase**: 5 (Cleanup Hardening) | **Type**: Test refactor | **Time**: 1.5 hrs | **Risk**: Medium — touches auth/registration flows

**Scenarios covered**: SC-007 / FR-014 for feature 001.

**Files**: `frontend/mcm-app/tests/e2e/web/auth.spec.ts`; `frontend/mcm-app/scripts/cleanup-e2e-data.ts`

1. For each registration test that creates an account, capture the created username and delete the
   Keycloak user in `test.afterEach` via the admin-backed BFF endpoint, `.catch(() => {})` on 404.
2. Use a unique, test-prefixed username per run (e.g., `e2e_<timestamp>`) so cleanup is targetable
   and reruns never collide.

**Verify RED** (before migration):
Run registration twice.
**Expected RED**: Second run fails on duplicate user, or leaves an orphaned test user behind.

**Verify GREEN** (after migration):
```bash
pnpm exec playwright test tests/e2e/web/auth.spec.ts
```
Run twice.
**Expected GREEN**: Both runs pass; no orphaned `e2e_*` users remain afterward.

**Done when**: All feature-001 web write tests tear down via post-test hook; no orphaned test users remain (SC-007, FR-014).

---

### T028 — Verify mobile write-flow teardown

**Phase**: 6 (Parity Tables) | **Type**: Verification (mobile E2E) | **Time**: 45 min | **Risk**: Low

**Scenarios covered**: FR-014 for the mobile client.

Confirm every mobile flow that creates data (`registration-full.yaml`, `collection-create.yaml`,
`movie-add.yaml`) removes it before exit — via `_cleanup-named-collection.yaml` or an in-flow
`evalScript` backend-API delete. Add teardown to any flow lacking it.

**Verify**:
```bash
pnpm nx e2e:mobile mcm-app
```
Run twice.
**Expected**: Second run passes with no leftover-data or uniqueness failures.

**Done when**: Every data-creating mobile flow tears down; back-to-back `e2e:mobile` runs are clean (FR-014).

---

## Completion Checklist

Before marking `003-test-hardening` complete, verify all success criteria from [spec.md](spec.md):

- [ ] **SC-001**: Full web E2E suite runs with exactly 1 identity provider login (global setup only)
- [ ] **SC-002**: `rtk gain` shows >80% token reduction after a full test run
- [ ] **SC-003**: All filter and search E2E tests assert exact expected counts from `FIXTURE_MOVIES`
- [ ] **SC-004**: CLAUDE.md contains the Test Run Protocol, Feature Branch Test Scope map, and Final Validation Checklist
- [ ] **SC-005**: Platform parity tables exist for features 001, 002, and 003
- [ ] **SC-006**: All gaps in the feature 002 parity table are resolved (new flow or written N/A justification)
- [ ] **SC-007**: All write tests in features 001 and 002 E2E suites use post-test-hook + BFF API teardown
- [ ] **SC-008**: Cleanup script exists and successfully removes test-prefixed collections
- [ ] **SC-009**: Every test task added in this feature uses the TDD checkpoint format
- [ ] **SC-010**: `docs/templates/feature-test-tasks-template.md` exists and is referenced in CLAUDE.md
