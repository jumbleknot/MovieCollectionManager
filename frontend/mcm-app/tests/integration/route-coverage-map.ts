/**
 * Endpoint coverage matrix (T021) — FR-023.
 *
 * Maps every BFF route file (relative to src/app/bff-api, POSIX separators) to its
 * integration test(s) or a written, justified exclusion. The structural gate in
 * route-coverage.integration.test.ts enforces that this matrix covers the live
 * route inventory — so a new route shipped without a test (or exclusion) fails CI
 * (deny-by-default for coverage, FR-024 / SC-012 / SC-013).
 *
 * The ONLY permitted exclusion is the login code-exchange endpoint, justified by
 * its end-to-end coverage (feature 003 Playwright global setup).
 */
export type RouteCoverage = { tests: string[] } | { excluded: string };

export const ROUTE_COVERAGE_MAP: Record<string, RouteCoverage> = {
  // ── Auth ──────────────────────────────────────────────────────────────────
  'auth/init+api.ts': { tests: ['auth-endpoints.integration.test.ts'] },
  'auth/login+api.ts': {
    excluded:
      'PKCE authorization-code exchange requires a browser-driven flow and cannot be ' +
      'automated headlessly. Covered by the feature-003 Playwright E2E global setup.',
  },
  'auth/logout+api.ts': { tests: ['auth-logout.integration.test.ts'] },
  'auth/refresh+api.ts': { tests: ['auth-refresh.integration.test.ts'] },
  'auth/register+api.ts': { tests: ['auth-register.integration.test.ts'] },
  'auth/resend-verification+api.ts': { tests: ['auth-endpoints.integration.test.ts'] },
  'auth/user+api.ts': { tests: ['auth-user.integration.test.ts'] },
  'auth/verify-email+api.ts': { tests: ['auth-endpoints.integration.test.ts'] },

  // ── Collections / movies proxy ──────────────────────────────────────────────
  'collections/index+api.ts': { tests: ['collections.integration.test.ts'] },
  'collections/[collectionId]/index+api.ts': { tests: ['collections.integration.test.ts'] },
  'collections/[collectionId]/movies/index+api.ts': { tests: ['movies.integration.test.ts'] },
  'collections/[collectionId]/movies/count+api.ts': { tests: ['movies-count.integration.test.ts'] },
  'collections/[collectionId]/movies/[movieId]+api.ts': { tests: ['movies.integration.test.ts'] },
  'collections/[collectionId]/movies/filter-options+api.ts': { tests: ['movies.integration.test.ts'] },

  // ── Agent Gateway proxy (feature 012) ───────────────────────────────────────
  'agent/run+api.ts': { tests: ['agent-route-auth.integration.test.ts'] },
  'agent/resume+api.ts': { tests: ['agent-route-auth.integration.test.ts'] },
  'agent/ui-state+api.ts': { tests: ['agent-route-auth.integration.test.ts'] },
  'agent/ui-action+api.ts': { tests: ['agent-route-auth.integration.test.ts'] },
  'agent/import-upload+api.ts': { tests: ['agent-route-auth.integration.test.ts'] },
  'agent/export-download+api.ts': { tests: ['export-download.integration.test.ts'] },
};
