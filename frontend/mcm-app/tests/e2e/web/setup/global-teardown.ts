/**
 * Feature 054 US6 (FR-024) — make a LOCAL run that was invalidated by token expiry say so.
 *
 * WHY THIS EXISTS: feature 052 fixed the refresh-bucket contention by giving CI an access token that
 * outlives the job (`ci-realm` `accessTokenLifespan` 300 → 5400) and deliberately scoped the change
 * there. The local consequence went unnoticed for a day: on `dev-realm`'s 300 s token, any local run
 * lasting more than ~5 minutes crossed the expiry boundary repeatedly and six workers re-entered
 * exactly the contention 052 had removed.
 *
 * Measured 2026-08-10 — two full local runs, 44 minutes each, **62 `refresh_rate_limited`**, 401s,
 * and 42 × `gotoHome: home screen did not render`. That last message is the one 052's own research
 * calls out for naming a cause it never tested, so the harness failure presented as an application
 * bug. ~29 flaky / 86 passed: numbers that say nothing about the code.
 *
 * The lifespan is now raised for `dev-realm` too, so this should not fire. It exists because "should
 * not" is not a measurement, and because the failure mode is indistinguishable from a real defect
 * unless something names it.
 *
 * It NEVER reports a clean result it did not measure: with no Docker CLI it says it could not look,
 * which is a different statement from "nothing happened" — the 0-vs-unavailable distinction
 * `e2e-contention-tally.sh` makes for the same counters in CI.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';

import { WORKER_IDENTITY_MANIFEST } from './auth-files';
import { deleteUser, keycloakAdminEnabled } from './keycloak-admin';

/** The BFF container the local dev-container target fronts. Same env var the CI tally honours. */
const CONTAINER = process.env['E2E_CONTENTION_CONTAINER'] ?? 'mcm-bff-service-nonsecure';

const RATE_LIMITED = '"action":"refresh_rate_limited"';

/**
 * Delete the throwaway identities global setup minted (054 US4).
 *
 * Worker 0 reuses the canonical `E2E_TEST_USER` and carries `userId: null`, so it is skipped — the
 * manifest's shape is what makes "do not delete the real user" structural rather than a name check
 * somebody has to keep in sync with the realm.
 *
 * Best-effort by design: a realm that keeps a few extra throwaway users is untidy, and a teardown
 * that fails a green run over untidiness is worse.
 */
async function deleteWorkerIdentities(): Promise<void> {
  if (!existsSync(WORKER_IDENTITY_MANIFEST) || !keycloakAdminEnabled()) return;

  let identities: { username: string; userId: string | null }[] = [];
  try {
    identities = JSON.parse(readFileSync(WORKER_IDENTITY_MANIFEST, 'utf8')) as typeof identities;
  } catch {
    console.warn('[global-teardown] worker identity manifest unreadable — leaving realm users in place');
    return;
  }

  let deleted = 0;
  for (const identity of identities) {
    if (!identity.userId) continue; // worker 0 — the canonical user, never ours to delete
    try {
      await deleteUser(identity.userId);
      deleted += 1;
    } catch (err) {
      console.warn(`[global-teardown] could not delete ${identity.username}: ${(err as Error).message}`);
    }
  }
  rmSync(WORKER_IDENTITY_MANIFEST, { force: true });
  if (deleted > 0) console.log(`[global-teardown] deleted ${deleted} per-worker identity/identities (054 US4)`);
}

export default async function globalTeardown(): Promise<void> {
  await deleteWorkerIdentities();

  // CI measures this on the HOST, where the Docker CLI exists, via `scripts/e2e-contention-tally.sh
  // --gate` — and the Playwright container has no Docker CLI at all, so trying here would report
  // "could not measure" on every CI run and train the reader to ignore the line.
  if (process.env['CI']) return;

  let logs: string;
  try {
    logs = execFileSync('docker', ['logs', CONTAINER], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    console.warn(
      `[e2e-contention] NOT MEASURED — could not read \`docker logs ${CONTAINER}\`. This run's ` +
        'contention counters are unknown; that is not the same as zero. If the suite failed, rule ' +
        'the harness out before reading the failures as application defects.',
    );
    return;
  }

  const rateLimited = logs.split(RATE_LIMITED).length - 1;
  if (rateLimited === 0) {
    console.log('[e2e-contention] refresh_rate_limited=0 — this run\'s result is about the code.');
    return;
  }

  // Throwing from globalTeardown fails the run, which is the point: a suite whose auth was being
  // rate-limited did not test what it appears to have tested, and reporting its pass/fail counts as
  // a result is how 44 minutes of noise once read as ~29 flaky tests.
  throw new Error(
    `[e2e-contention] THIS RUN IS INVALID — ${rateLimited} token refreshes were rate-limited.\n` +
      '\n' +
      'This is the TOKEN LIFESPAN, not an application defect, and not the message the tests will\n' +
      'have shown you: a rejected refresh makes the client clear its session and bounce to login,\n' +
      'which surfaces as "gotoHome: home screen did not render — is the global-setup session\n' +
      'valid?". That sentence is a 60-second timeout\'s guess and names a cause it never tested.\n' +
      '\n' +
      'The per-session refresh bucket holds 2 requests per 30 s. Playwright builds a fresh\n' +
      'BrowserContext per test, each reloading the frozen storageState whose access cookie expires\n' +
      'with the token — so once the run crosses that boundary every test starts unauthenticated and\n' +
      'refreshes at test cadence (~2 s) against a limit built for two.\n' +
      '\n' +
      'Check `accessTokenLifespan` in infrastructure-as-code/docker/keycloak/dev-realm.json (5400 as\n' +
      'of feature 054) and confirm the realm was re-imported since it changed — a running Keycloak\n' +
      'keeps the OLD value until the realm is re-imported.\n' +
      '\n' +
      'Do NOT raise the BFF refresh rate limit to silence this: it is an anti-abuse control on a\n' +
      'production authentication endpoint (052 FR-011).',
  );
}
