/**
 * Where each Playwright worker's authenticated session lives (feature 052 US3).
 *
 * WHY PER WORKER: every worker used to load ONE `storageState`, so all eight presented the same BFF
 * `sessionId`. `checkRefreshRateLimit` is keyed on that session and holds 2 requests per 30 s, so the
 * eight of them shared a bucket built for two. Measured on run 1605: **32 of 66 token refreshes were
 * rejected**, and a rejected refresh makes the client clear its session and bounce to login — which
 * surfaced as `gotoHome: … is the global-setup session valid?` and reddened specs that had nothing
 * wrong with them.
 *
 * One session per worker gives each bucket exactly one client. A single worker cannot refresh three
 * times in thirty seconds, so the contention is impossible by construction rather than merely rarer.
 *
 * The files are minted ONCE by global setup, not per test, so a worker restart after a failure reuses
 * its session rather than minting another. That matters: `MAX_CONCURRENT_SESSIONS` is 10, and a fresh
 * login per restart would climb past it during a run with retries and start evicting — trading a
 * measured problem for a latent one.
 */
import * as path from 'node:path';

export const AUTH_DIR = path.join(__dirname, '.auth');

/**
 * The shared, worker-agnostic session file.
 *
 * Still written, and still the `storageState` default in playwright.config.ts: the `lifecycle`
 * project and any spec that has not moved to the per-worker fixture continue to read it. It is a copy
 * of worker 0's session, so it costs no extra login.
 */
export const SHARED_AUTH_FILE = path.join(AUTH_DIR, 'user.json');

/** The session file belonging to Playwright's `parallelIndex` (0-based, stable across retries). */
export function authFileForWorker(parallelIndex: number): string {
  return path.join(AUTH_DIR, `user-${parallelIndex}.json`);
}
