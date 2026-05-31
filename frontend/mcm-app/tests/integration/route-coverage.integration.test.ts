/**
 * Route coverage gate (T021) — US9 / FR-023 / FR-024 / SC-012 / SC-013.
 *
 * Structural test (no external services): globs the live BFF route inventory
 * (src/app/bff-api/**​/+api.ts) and asserts every route file maps, in
 * route-coverage-map.ts, to at least one integration test that exists on disk OR
 * a written justified exclusion. Fails — naming the route — when a new route ships
 * without coverage, turning "no untested BFF route" into an enforced invariant.
 */
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROUTE_COVERAGE_MAP, type RouteCoverage } from './route-coverage-map';

const APP_ROOT = join(__dirname, '..', '..'); // tests/integration → frontend/mcm-app
const BFF_API_DIR = join(APP_ROOT, 'src', 'app', 'bff-api');
const INTEGRATION_DIR = __dirname;

function discoverRouteFiles(): string[] {
  return readdirSync(BFF_API_DIR, { recursive: true })
    .map((p) => String(p).replace(/\\/g, '/'))
    .filter((p) => p.endsWith('+api.ts'))
    .sort();
}

const hasTests = (c: RouteCoverage): c is { tests: string[] } => 'tests' in c;

describe('route coverage gate (US9 — no untested BFF route)', () => {
  const routes = discoverRouteFiles();

  it('discovers a non-empty BFF route inventory', () => {
    expect(routes.length).toBeGreaterThan(0);
  });

  it('maps every route file to a test or a justified exclusion (FR-024 / SC-012)', () => {
    const uncovered = routes.filter((r) => !(r in ROUTE_COVERAGE_MAP));
    // If this fails, it names the route(s) shipped without an integration test
    // or a justified exclusion — add coverage (or a justified exclusion) before merge.
    expect(uncovered).toEqual([]);
  });

  it('has no stale matrix entries (every mapped route still exists)', () => {
    const stale = Object.keys(ROUTE_COVERAGE_MAP).filter((r) => !routes.includes(r));
    expect(stale).toEqual([]);
  });

  it('every mapped integration test file exists on disk', () => {
    for (const [route, cov] of Object.entries(ROUTE_COVERAGE_MAP)) {
      if (hasTests(cov)) {
        expect(cov.tests.length).toBeGreaterThan(0);
        for (const t of cov.tests) {
          expect({ route, test: t, exists: existsSync(join(INTEGRATION_DIR, t)) }).toEqual({
            route,
            test: t,
            exists: true,
          });
        }
      } else {
        expect(cov.excluded.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('the login code-exchange endpoint is the ONLY justified exclusion (SC-012)', () => {
    const excluded = Object.entries(ROUTE_COVERAGE_MAP)
      .filter(([, c]) => !hasTests(c))
      .map(([r]) => r);
    expect(excluded).toEqual(['auth/login+api.ts']);
  });
});
