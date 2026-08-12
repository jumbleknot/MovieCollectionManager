// Feature 052 US3 — the per-worker session split, guarded in BOTH directions.
//
// Measured on run 1605: eight Playwright workers shared one `storageState`, therefore one BFF
// sessionId, therefore one refresh rate-limit bucket holding 2 per 30 s. **32 of 66 token refreshes
// were rejected**, and a rejected refresh makes the client clear its session and bounce to login.
// The remedy gives each worker its own session file.
//
// Two ways that remedy rots, each silent:
//
//   1. A spec keeps importing `test` from '@playwright/test' → it loads the shared default session
//      and quietly re-enters the contention. Nothing fails; the suite just gets flaky again. One file
//      (agent-search.spec.ts) already slipped through the initial rewrite because it used DOUBLE
//      quotes — found by this guard's first run, not by review.
//   2. A deliberately-unauthenticated spec imports the FIXTURE → the fixture replaces the option's
//      implementation, so it wins over that file's `test.use({ storageState: empty })` and hands the
//      test a signed-in session. The test then passes while proving the opposite of its subject.
//
// Also pinned: the worker count must stay clear of MAX_CONCURRENT_SESSIONS. One session per worker
// means the session count IS the worker count, so a runner with more cores would start evicting —
// converting the measured refresh problem into the eviction problem this feature just refuted.
//
// Deterministic, offline, token-free, node: built-ins only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WEB_E2E = resolve(REPO_ROOT, 'frontend/mcm-app/tests/e2e/web');
const CONFIG = resolve(REPO_ROOT, 'frontend/mcm-app/playwright.config.ts');
const GLOBAL_SETUP = resolve(REPO_ROOT, 'frontend/mcm-app/tests/e2e/web/setup/global-setup.ts');
const ENV_TS = resolve(REPO_ROOT, 'frontend/mcm-app/src/config/env.ts');

/** Specs that must run UNAUTHENTICATED — they opt out via a file-level `test.use`. */
const UNAUTHENTICATED = new Set([
  'auth.spec.ts',
  'bff-prod-lifecycle.spec.ts',
  'security-headers.spec.ts',
]);

const specs = readdirSync(WEB_E2E).filter((f) => f.endsWith('.spec.ts'));
const read = (f) => readFileSync(join(WEB_E2E, f), 'utf8');

// Quote-agnostic on purpose: the one file that escaped the initial rewrite differed only by using
// double quotes, and a single-quote-only guard would have declared it compliant.
const importsFixture = (t) => /from\s+['"][^'"]*fixtures\/worker-session['"]/.test(t);
const importsPlaywrightTest = (t) => /^import\s*\{\s*test\b[^}]*\}\s*from\s*['"]@playwright\/test['"]/m.test(t);

test('there are spec files to check at all', () => {
  // Without this, every assertion below is vacuously true over an empty list.
  assert.ok(specs.length > 20, `expected the web E2E suite, found ${specs.length} spec files`);
  for (const f of UNAUTHENTICATED) assert.ok(specs.includes(f), `${f} is missing from the suite`);
});

test('every authenticated spec takes its session from the per-worker fixture', () => {
  const offenders = specs
    .filter((f) => !UNAUTHENTICATED.has(f))
    .filter((f) => !importsFixture(read(f)));

  assert.deepEqual(
    offenders,
    [],
    'these specs still load the shared session and would re-enter the refresh contention',
  );
});

test('deliberately-unauthenticated specs do NOT import the fixture', () => {
  const offenders = [...UNAUTHENTICATED].filter((f) => importsFixture(read(f)));

  assert.deepEqual(
    offenders,
    [],
    'the fixture overrides the option, so it would defeat their `test.use({ storageState: empty })` ' +
      'and hand them a signed-in session — passing while proving the opposite',
  );
});

test('unauthenticated specs still declare their opt-out explicitly', () => {
  for (const f of UNAUTHENTICATED) {
    assert.match(
      read(f),
      /test\.use\(\{\s*storageState:\s*\{\s*cookies:\s*\[\]/,
      `${f} is treated as unauthenticated here but no longer says so`,
    );
  }
});

test('no authenticated spec still imports `test` from @playwright/test', () => {
  // The complement of the fixture check: a file could import BOTH and use the wrong one.
  const offenders = specs
    .filter((f) => !UNAUTHENTICATED.has(f))
    .filter((f) => importsPlaywrightTest(read(f)));

  assert.deepEqual(offenders, [], 'these import the base `test`, which loads the shared session');
});

test('the CI access token outlives the E2E run, so a frozen storageState stays usable', () => {
  // Playwright reloads the frozen storageState in a fresh BrowserContext PER TEST. If the access
  // token expires mid-run, every test after that point must refresh before it can do anything —
  // measured at a 1.9 s median interval against a per-session limit of 2 per 30 s, which rejected
  // 35 of 115 attempts (run 1607) and bounced those tests to login. A token that outlives the run
  // removes the driver; lowering it back would restore the contention silently, with no failing
  // test to say so.
  const ci = JSON.parse(
    readFileSync(resolve(REPO_ROOT, 'infrastructure-as-code/docker/keycloak/ci-realm.json'), 'utf8'),
  );
  const JOB_TIMEOUT_MINUTES = 75; // .forgejo/workflows/app-ci.yml, app-e2e
  assert.ok(
    ci.accessTokenLifespan >= JOB_TIMEOUT_MINUTES * 60,
    `ci-realm accessTokenLifespan is ${ci.accessTokenLifespan}s but app-e2e may run for ` +
      `${JOB_TIMEOUT_MINUTES} min. A token that expires mid-run makes every later test refresh.`,
  );
});

test('the worker count is bounded, and the cap it must respect is PER USER', () => {
  const cfg = readFileSync(CONFIG, 'utf8');
  const workers = /MAX_E2E_WORKERS\s*=\s*(\d+)/.exec(cfg);
  assert.ok(workers, 'playwright.config.ts must declare an explicit MAX_E2E_WORKERS bound');
  assert.match(
    cfg,
    /workers:\s*E2E_WORKERS/,
    'the bound must actually be applied to `workers`, not merely declared',
  );

  const cap = /maxConcurrentSessions:.*?['"](\d+)['"]/.exec(readFileSync(ENV_TS, 'utf8'));
  assert.ok(cap, 'could not read the MAX_CONCURRENT_SESSIONS default from env.ts');

  // THIS GUARD CHANGED WITH THE INVARIANT IT PROTECTS (054 US4), rather than being deleted because
  // it failed. Feature 052 required `workers <= cap - 3`, because every worker acted as the SAME
  // user: workers WERE that user's concurrent sessions, and a local run at 8 measured
  // `session_evicted=8`.
  //
  // Each worker is now its own USER holding exactly ONE session, and the cap is per user — so the
  // arithmetic that made the old bound necessary no longer describes anything. What must hold now is
  // the premise itself: that global setup really does mint an identity per worker. If that ever
  // regressed to a shared user, `workers <= cap - 3` would be load-bearing again and 10 would be
  // over it — so this asserts the premise instead of a number derived from it.
  const setup = readFileSync(GLOBAL_SETUP, 'utf8');
  assert.match(
    setup,
    /createUserWithRoles\(/,
    'global setup no longer mints per-worker users — the per-USER session cap becomes load-bearing '
      + 'again, and MAX_E2E_WORKERS must drop back below it (see 052 US3)',
  );
  assert.match(
    setup,
    /authFileForWorker\(/,
    'per-worker storage state is gone — workers would share one session again',
  );

  // One session per worker, so the per-user cap is untouchable however many workers run. The bound
  // that remains is the machine and the login rate limit, both of which live in the config comment.
  assert.ok(
    Number(workers[1]) >= 1,
    'MAX_E2E_WORKERS must be a positive bound',
  );
  assert.ok(
    Number(cap[1]) >= 1,
    'MAX_CONCURRENT_SESSIONS must still be read, so this guard fails loudly if env.ts drops it',
  );
});
