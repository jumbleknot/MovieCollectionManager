# Implementation Plan: Test Suite Hardening

**Branch**: `003-test-hardening` | **Date**: 2026-05-29 | **Spec**: [spec.md](spec.md)

---

## Summary

Harden the existing test infrastructure for features 001 and 002, and establish patterns that all future features must follow. Delivers: RTK token compression; Playwright session reuse via storageState; a seeded fixture dataset with exact-count assertions; reliable afterEach cleanup; platform parity tables; TDD checkpoint task format; and a reusable feature test template. No production code is changed.

### Terminology Map (spec → plan)

The spec is technology-agnostic; this plan binds its capability terms to concrete tooling.

| spec.md (capability) | plan.md (concrete tooling) |
|---|---|
| output-compression mechanism / metric | RTK (Rust Token Killer); `rtk gain` |
| web E2E framework / test runner | Playwright (`storageState`, `dot` reporter) |
| mobile E2E framework | Maestro (`evalScript` + `fetch`) |
| unit test runner | Jest (`verbose: false`) |
| application's backend API | BFF API routes |
| pre-saved authenticated session | Playwright `storageState` (`.auth/user.json`) |
| codebase documentation | root `CLAUDE.md` |

---

## Technical Context

**Language/Version**: TypeScript 5.x (Playwright, Jest, scripts), YAML (Maestro)

**Primary Dependencies** (all already installed):
- Playwright + `@playwright/test` — web E2E; adds `globalSetup` + `storageState` configuration
- Jest — unit/integration tests; adds `--silent` flag or `verbose: false`
- Maestro CLI — mobile E2E; adds `_setup-fixtures.yaml` helper with `evalScript` for API calls
- Axios — BFF API calls from global setup and cleanup script
- RTK (Rust Token Killer) — external binary, installed per-machine; pin a specific version (`rtk <X.Y.Z>`) and record the install source/command in CLAUDE.md Prerequisites. Because it is not a `package.json` dependency its version is not lockfile-tracked, so it must be pinned in docs per the constitution's Dependency Security principle.

**Files Modified** (existing):
- `frontend/mcm-app/playwright.config.ts` — add `globalSetup`, `storageState`, `reporter: 'dot'`
- `frontend/mcm-app/jest.config.ts` (or `jest.config.js`) — add `verbose: false`, suppress console from passing tests
- `frontend/mcm-app/tests/e2e/web/collections.spec.ts` — remove inline login, migrate teardown to afterEach
- `frontend/mcm-app/tests/e2e/web/movies.spec.ts` — remove inline login, migrate teardown to afterEach, add exact-count fixture assertions
- `frontend/mcm-app/tests/e2e/web/auth.spec.ts` — add `test.use({ storageState: undefined })` for unauthenticated tests
- `CLAUDE.md` (repo root — the authoritative agent doc Claude Code loads for this workspace) — add Prerequisites, Test Run Protocol, Feature Branch Scope, Final Validation Checklist
- `specs/001-user-login/tasks.md` — add Platform Parity table
- `specs/002-manage-movie-collection/tasks.md` — add Platform Parity table, update remaining tasks to TDD checkpoint format

**Files Created** (new):
- `frontend/mcm-app/tests/e2e/fixtures/base-dataset.ts` — typed fixture constant
- `frontend/mcm-app/tests/e2e/web/setup/global-setup.ts` — Playwright global setup (login + seed)
- `frontend/mcm-app/tests/e2e/web/setup/.auth/.gitkeep` — placeholder; `.auth/user.json` is gitignored
- `frontend/mcm-app/tests/e2e/mobile/_setup-fixtures.yaml` — Maestro fixture seed helper
- `frontend/mcm-app/scripts/cleanup-e2e-data.ts` — on-demand cleanup of test-prefixed collections (co-located with the app whose BFF it calls)
- `docs/templates/feature-test-tasks-template.md` — reusable template for future feature test tasks

**No new npm packages required.** RTK is a system binary, not a package dependency.

---

## Constitution Check

| Principle | Status | Notes |
|---|---|---|
| TDD: tests written and verified RED before implementation | ✅ Pass (scoped) | `global-setup.ts` and `cleanup-e2e-data.ts` are test-support utilities, not production code — they are exercised by the E2E suite they enable (RED/GREEN observed via the suite, plus T026 idempotency smoke test) and are out of scope for the ≥70% product-coverage rule. No production application code is added (spec Assumptions). |
| Monorepo Build Tool: Nx targets are the primary invocation path | ✅ Pass (with exception) | Full-suite, coverage, and lint steps use `pnpm nx e2e`/`e2e:mobile`/`test`/`lint`. Single-test/`--grep` granularity and `tsc --noEmit` have no Nx target and are invoked directly — the same documented exception already standing in root CLAUDE.md. |
| No runtime patches: tests fail if the feature is broken | ✅ Pass | afterEach teardown is separate from assertions |
| Stable selectors: data-testid / ARIA roles | ✅ Pass | No selector changes in this feature |
| Independent state: tests reset environment | ✅ Pass | Global setup resets mutation collection; afterEach cleans write tests |
| Consistent E2E across clients | ✅ Pass | Parity tables (incl. 003, T025) identify and close gaps |
| AI Assistant must not vibe-code | ✅ Pass | Every task references spec.md and plan.md |

---

## Architecture

### Global Setup Flow (Playwright)

```
playwright.config.ts
  └── globalSetup: './tests/e2e/web/setup/global-setup.ts'
       1. POST /bff-api/auth/init → check session
       2. If not authenticated: full Keycloak OIDC flow → save storageState to .auth/user.json
       3. GET /bff-api/collections → check fixture collections exist
       4. If missing: POST /bff-api/collections for each (E2E Browse, E2E Mutation, E2E Default)
       5. For E2E Browse: verify movies match FIXTURE_MOVIES; create any missing
       6. For E2E Mutation: delete all movies (reset to empty)
       7. Done — all tests inherit storageState and fixture data
```

All subsequent Playwright tests use:
```typescript
// playwright.config.ts
use: { storageState: './tests/e2e/web/setup/.auth/user.json' }
```

### Fixture Dataset Design

```typescript
// tests/e2e/fixtures/base-dataset.ts
export const FIXTURE_COLLECTIONS = {
  BROWSE:   'E2E Browse',    // read-only; search/filter/column tests
  MUTATION: 'E2E Mutation',  // write tests create/delete here; reset to empty on setup
  DEFAULT:  'E2E Default',   // FR-009 auto-redirect test
} as const;

export const FIXTURE_MOVIES: FixtureMovie[] = [
  { id: 'M1',  title: 'Alpha',   contentType: 'Movie',   rated: 'R',      owned: true,  ripped: true,  ownedMedia: ['Blu-Ray'],     genres: ['Action'],           decade: '2010s' },
  { id: 'M2',  title: 'Beta',    contentType: 'Series',  rated: 'PG',     owned: false, ripped: false, ownedMedia: [],              genres: ['Drama'],            decade: '2000s' },
  { id: 'M3',  title: 'Gamma',   contentType: 'Concert', rated: 'NR',     owned: true,  ripped: false, ownedMedia: ['DVD'],          genres: ['Music'],            decade: '1990s' },
  { id: 'M4',  title: 'Delta',   contentType: 'Movie',   rated: 'G',      owned: true,  ripped: true,  ownedMedia: ['UHD Blu-Ray'],  genres: ['Family', 'Comedy'], decade: '2020s' },
  { id: 'M5',  title: 'Epsilon', contentType: 'Series',  rated: 'PG-13',  owned: false, ripped: false, ownedMedia: [],              genres: ['Thriller'],         decade: '2010s' },
  { id: 'M6',  title: 'Zeta',    contentType: 'Movie',   rated: 'NC-17',  owned: true,  ripped: true,  ownedMedia: ['Blu-Ray 3D'],   genres: ['Horror'],           decade: '1980s' },
  { id: 'M7',  title: 'Eta',     contentType: 'Movie',   rated: 'Unrated',owned: false, ripped: false, ownedMedia: [],              genres: ['Documentary'],      decade: '1970s' },
  { id: 'M8',  title: 'Theta',   contentType: 'Series',  rated: 'R',      owned: true,  ripped: false, ownedMedia: ['DVD'],          genres: ['Action', 'Drama'],  decade: '2000s' },
  { id: 'M9',  title: 'Iota',    contentType: 'Concert', rated: 'G',      owned: true,  ripped: true,  ownedMedia: ['Blu-Ray'],      genres: ['Classical'],        decade: '2020s' },
  { id: 'M10', title: 'Kappa',   contentType: 'Movie',   rated: 'PG',     owned: false, ripped: false, ownedMedia: [],              genres: ['Animation'],        decade: '1990s' },
];
```

**Derived counts** (used directly in test assertions):
| Filter | Expected count | Fixture movies |
|--------|---------------|----------------|
| contentType = Movie | 5 | M1, M4, M6, M7, M10 |
| contentType = Series | 3 | M2, M5, M8 |
| contentType = Concert | 2 | M3, M9 |
| owned = true | 6 | M1, M3, M4, M6, M8, M9 |
| ripped = true | 4 | M1, M4, M6, M9 |
| ownedMedia = DVD | 2 | M3, M8 |
| ownedMedia = Blu-Ray | 2 | M1, M9 |
| genre = Action | 2 | M1, M8 |
| decade = 2010s | 2 | M1, M5 |
| decade = 1980s | 1 | M6 |
| decade = 1990s | 2 | M3, M10 |
| rated = R | 2 | M1, M8 |

### afterEach Teardown Pattern

```typescript
// Pattern for all write tests (collections.spec.ts, movies.spec.ts)
let createdId: string | undefined;

test.afterEach(async ({ request }) => {
  if (createdId) {
    await request.delete(
      `/bff-api/collections/${FIXTURE_COLLECTIONS.MUTATION}/movies/${createdId}`,
      { headers: { Cookie: await getSessionCookie() } }
    ).catch(() => {}); // silently ignore if already deleted
    createdId = undefined;
  }
});

test('add movie...', async ({ page }) => {
  // ... create via UI ...
  createdId = extractIdFromUrl(page.url()); // capture for afterEach
  // ... assertions only, no teardown here ...
});
```

### Cleanup Script

```typescript
// scripts/cleanup-e2e-data.ts
// Deletes all collections starting with test prefixes for the E2E test user
const TEST_PREFIXES = ['E2E ', 'Playwright ', 'Maestro '];
// Calls GET /bff-api/collections, filters by prefix, deletes each
```

### Maestro Fixture Setup

```yaml
# tests/e2e/mobile/_setup-fixtures.yaml
# Called from the Nx e2e:mobile target before any flow runs
- runFlow: "_login-helper.yaml"
- evalScript: |
    const res = fetch('http://localhost:8081/bff-api/collections', { credentials: 'include' });
    // check fixture collections; create if missing
```

### CLAUDE.md Additions

Three sections added to the root `CLAUDE.md` under `## Testing Requirements`:

1. **Prerequisites** — RTK installation instructions (mandatory)
2. **Test Run Protocol** — ordered steps for every code change
3. **Feature Branch Test Scope** — story-to-test-file map
4. **Final Validation Checklist** — commands required before a feature is done

### docs/templates/feature-test-tasks-template.md

Provides the standard format Claude Code must use when writing test tasks for any new feature. Referenced from CLAUDE.md.

---

## Implementation Phases

### Phase 0: Prerequisites & Documentation (no code — 1.5 hrs)

Zero-risk. Do before any implementation work. Delivers immediate token efficiency via RTK and disciplined test execution via CLAUDE.md.

Tasks: T001–T004

### Phase 1: Reporter Configuration (15 min)

Minimal config changes. Complements RTK by reducing base verbosity of passing test output.

Tasks: T005–T006

### Phase 2: Fixture Infrastructure (5 hrs)

New files only. Creates the global setup, fixture constant, and Maestro helper. Does not yet modify existing tests.

Tasks: T007–T011

### Phase 3: Session Reuse Refactor (2 hrs)

Modifies existing spec files. Removes redundant login() calls. Existing tests should continue to pass after.

Tasks: T012–T014

### Phase 4: Exact-Count Assertions (2 hrs)

Updates search/filter tests to use fixture-derived expected counts. Some currently-vacuous tests will now fail if the fixture is not seeded correctly — this is the intended RED → GREEN cycle.

Tasks: T015–T016

### Phase 5: Cleanup Hardening (3 hrs)

Migrates teardown from test bodies to afterEach hooks using BFF API. Creates cleanup script.

Tasks: T017–T019

### Phase 6: Parity Tables (2 hrs)

Adds parity tables to feature 001 and 002 task lists. Creates missing Maestro flows.

Tasks: T020–T022

### Phase 7: Template & Format (1 hr)

Creates the reusable template. Updates any remaining feature 002 tasks to the new TDD checkpoint format.

Tasks: T023–T024

---

## Non-Obvious Design Decisions

- **Global setup uses the BFF API, not the UI, for fixture seeding**: UI-based setup doubles test time and consumes context tokens. BFF API calls are ~10-20x faster and produce no Playwright output.
- **`.auth/user.json` is gitignored**: The saved session contains cookies tied to the local Keycloak instance. Committing it would break other developers' setups. Each developer's machine generates its own via global setup.
- **The E2E Browse collection is read-only by convention, not by enforcement**: The BFF has no read-only collections concept. The convention is enforced by global setup repairing any modifications on the next run. Tests that accidentally write to E2E Browse will pass once but be repaired before the next run.
- **afterEach teardown silently swallows API failures**: If the record was already deleted (e.g., by a test that confirmed its own deletion), the afterEach call returns 404. Swallowing this prevents a false afterEach failure from masking the actual test result.
- **RTK is a system binary, not an npm dependency**: It is installed per machine and activates transparently via shell hook. It does not appear in package.json. This is intentional — it is a developer environment tool, not a project dependency.
- **Maestro cannot use Playwright storageState**: Maestro manages its own app state. The `_setup-fixtures.yaml` helper uses `evalScript` with `fetch()` to call the BFF API and create fixture data. Mobile tests still call `_login-helper.yaml` for flows that test the login UI; other flows assume the app is already running with a valid session from `launchApp: clearState: false`.
