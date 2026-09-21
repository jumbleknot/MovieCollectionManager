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
  // 040 US3 — public read of the self-registration toggle (drives the login screen's
  // "Create Account" entry point); asserted around the admin PATCH in the same suite.
  'auth/registration-status+api.ts': { tests: ['admin-registration.integration.test.ts'] },

  // ── Admin ───────────────────────────────────────────────────────────────────
  // 040 US3 — first mc-admin-gated surface: GET/PATCH the global app settings.
  'admin/settings+api.ts': { tests: ['admin-registration.integration.test.ts'] },

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

  // ── Per-user agent config (feature 018) ─────────────────────────────────────
  'agent/config/index+api.ts': {
    tests: ['agent-config-save.integration.test.ts', 'agent-config-scoping.integration.test.ts'],
  },
  'agent/config/test+api.ts': { tests: ['agent-config-test.integration.test.ts'] },

  // ── Per-user scheduled backups (feature 073) ────────────────────────────────
  'backups/destinations/index+api.ts': {
    tests: ['backup-destinations-authz.integration.test.ts'],
  },
  'backups/destinations/[destinationId]+api.ts': {
    tests: ['backup-destinations-authz.integration.test.ts'],
  },
  'backups/destinations/test+api.ts': {
    tests: ['backup-destination-probe.integration.test.ts'],
  },
  'backups/jobs/index+api.ts': { tests: ['backup-jobs-authz.integration.test.ts'] },
  'backups/jobs/[jobId]/index+api.ts': { tests: ['backup-jobs-authz.integration.test.ts'] },
  'backups/jobs/[jobId]/run+api.ts': { tests: ['backup-jobs-authz.integration.test.ts'] },
  'backups/jobs/[jobId]/runs+api.ts': { tests: ['backup-jobs-authz.integration.test.ts'] },
  'backups/jobs/[jobId]/versions+api.ts': { tests: ['backup-restore-routes.integration.test.ts'] },
  'backups/jobs/[jobId]/restore+api.ts': { tests: ['backup-restore-routes.integration.test.ts'] },
  'backups/jobs/[jobId]/download+api.ts': { tests: ['backup-restore-routes.integration.test.ts'] },
  'backups/consent+api.ts': {
    tests: ['backup-consent-routes.integration.test.ts', 'backup-offline-token.integration.test.ts'],
  },
  // The tick is INTERNAL and secret-guarded — it has no session and 404s rather than 401s, so
  // it cannot be exercised the way the user-facing routes are. Its suite drives the handler
  // in-process with a Request it constructs, which is also the only way to be certain no
  // cookie was sent: the central claim is that a scheduled run needs no session at all.
  'backups/tick+api.ts': { tests: ['backup-tick.integration.test.ts'] },
};
