# Phase 1 Data Model: Clean Up Project Flakiness

**No domain data entities.** This feature changes test reliability, build reproducibility, and developer-tooling guard rails — it introduces, removes, or modifies zero application data entities, fields, or relationships (FR-012). The MongoDB collections (`movie_collections`, `movies`), session store, and all API contracts are untouched.

In place of a domain model, the relevant "entities" are the **configuration and tooling artifacts** this feature touches. They are catalogued here so planning/tasks have a single reference.

| Artifact | Location | Change | Serves |
|---|---|---|---|
| Root manifest | `package.json` | Add `preinstall` → `only-allow pnpm`; keep `packageManager: pnpm@10.33.0` | US3 / FR-008, FR-009 |
| npm config | `.npmrc` | Optional `engine-strict` + documentation note (non-load-bearing); refresh short-path recipe comment | US3 / US4 |
| Jest config | `frontend/mcm-app` Jest config (`jest.config.js` or `package.json` "jest") | `clearMocks`/`resetMocks`/`restoreMocks: true` | US1 / FR-001, FR-004 |
| Jest setup | frontend test setup file | Global `afterEach` safety net: `jest.useRealTimers()` + RTL `cleanup()` | US1 / FR-004 |
| Flaky unit test | `src/screens/movies/movie-detail-screen.test.tsx` | Remove dependence on leaked state; **assertions unchanged** | US1 / FR-002, FR-003 |
| Leaking sibling test/module | (TBD via bisection) | Restore the un-cleaned timer/global it leaks | US1 / FR-004 |
| Playwright config | `frontend/mcm-app/playwright.config.ts` | Keep `retries: 1`; confirm timeouts; document warm-up | US2 / FR-005, FR-006 |
| Web E2E global setup | `tests/e2e/web/setup/global-setup.ts` | Optional Metro warm-up pre-navigation | US2 / FR-005 |
| Mobile E2E runner | Nx `e2e:mobile` target / Maestro wrapper | Bounded (≤1) per-flow retry, logged | US2 / FR-006 |
| Local APK recipe | `scripts/` + `CLAUDE.md` | Scripted, documented short-root build | US4 / FR-010, FR-013 |
| Nx build target | `frontend/mcm-app` Nx config (`project.json`/`package.json`) | New `build-apk` target wrapping `expo prebuild` + `gradlew` | US4 / FR-011, constitution Nx-primary |
| CI workflow | `.github/workflows/android-apk.yml` | New: thin Linux workflow invoking `pnpm nx run mcm-app:build-apk` + artifact upload | US4 / FR-011 |
| Root `.gitignore` | `.gitignore` | Add any new build/artifact ignore patterns (root-canonical) | US4 / constitution Git Management |

### Invariants / validation rules (behavioral, not data)

- **No weakened tests**: post-change test count ≥ pre-change; zero `skip`/`xfail`/quarantine added (SC-002).
- **Bounded retry**: ≤ 1 retry per E2E test; retries visible in output; a real regression fails on both attempts (FR-006, SC-004).
- **Hard block**: `npm install` / `yarn install` → non-zero exit, no packages written; `pnpm install` unaffected (SC-005).
- **No behavior change**: existing functional tests pass with identical outcomes (SC-007).
