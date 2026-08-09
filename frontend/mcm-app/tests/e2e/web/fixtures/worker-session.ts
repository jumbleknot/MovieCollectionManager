/**
 * The web E2E `test` object: identical to Playwright's, except each worker gets its OWN session.
 *
 * Import this instead of `@playwright/test` in any spec that relies on the authenticated
 * global-setup session:
 *
 *     import { test, expect } from './fixtures/worker-session';
 *
 * WHY (measured, run 1605 — feature 052): every worker used to load the same `storageState` file, so
 * all eight presented one BFF `sessionId`. `checkRefreshRateLimit` is keyed on the session and holds
 * 2 requests per 30 s, so eight workers shared a bucket built for two. **32 of the run's 66 token
 * refreshes were rejected.** The client swallows that 429 and clears the session, so the failure
 * surfaced as `gotoHome: … is the global-setup session valid?` — a message that names a cause it
 * never tested — on specs with nothing wrong with them.
 *
 * With one session per worker each bucket has exactly one client, and a single worker cannot refresh
 * three times in thirty seconds. The contention is impossible by construction, not merely rarer.
 *
 * DO NOT import this in a spec that deliberately runs UNAUTHENTICATED (`auth.spec.ts`,
 * `security-headers.spec.ts`, `bff-prod-lifecycle.spec.ts`). Those override the option via
 * `test.use({ storageState: { cookies: [], origins: [] } })`; this fixture REPLACES the option's
 * implementation, so it would win over that `test.use` and silently hand them a signed-in session —
 * turning a deliberately-unauthenticated test into one that proves nothing. They keep importing
 * `@playwright/test`, which is why the guard in scripts/__tests__/e2e-worker-session.test.mjs asserts
 * the split both ways.
 */
import { test as base, expect } from '@playwright/test';
import { authFileForWorker } from '../setup/auth-files';

export const test = base.extend<Record<string, never>, { workerStorageState: string }>({
  // Test-scoped: hand each test the session file belonging to its worker.
  storageState: ({ workerStorageState }, use) => use(workerStorageState),

  // Worker-scoped: resolved once per worker process, and stable across retries because
  // `parallelIndex` is stable and global setup minted the files up front. No login happens here —
  // a per-restart login would push the user past MAX_CONCURRENT_SESSIONS during a run with retries.
  workerStorageState: [
    async ({}, use, workerInfo) => {
      await use(authFileForWorker(workerInfo.parallelIndex));
    },
    { scope: 'worker' },
  ],
});

export { expect };
