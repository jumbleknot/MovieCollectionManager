/**
 * Integration-test environment bootstrap (T004a).
 *
 * Runs via `setupFiles` BEFORE any module loads, so that `@/config/env`
 * (`env.redisUrl = requireEnv('REDIS_URL', …)`, read at module init) picks up
 * the db-1 override and the modules under test (`session-manager`, `rate-limiter`
 * via `cache-service`) connect to Redis database index 1 — the same db as
 * `redis-test-client.ts`. The running development BFF uses db 0 and is unaffected.
 *
 * Loads, without a dotenv dependency (this feature adds no new deps):
 *   1. `.env.e2e.local`  — test creds: E2E_ROPC_CLIENT_ID/SECRET, E2E_TEST_USER/PASSWORD
 *   2. `.env.local`      — BFF server config: KEYCLOAK_* incl. the service-account
 *                          secret used for Admin REST calls, MC_SERVICE_URL, COOKIE_SECRET
 * e2e is loaded first so its values win on any overlap. Jest does not auto-load
 * .env files the way the Expo CLI does, so the integration suite loads them here.
 *
 * REDIS_URL is then PINNED to db 1 unconditionally (overriding the db-0 value in
 * .env.local) — db-1 isolation is the enforcement point for this feature.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// tests/integration/setup → up 3 → frontend/mcm-app
const appRoot = join(__dirname, '..', '..', '..');

function loadEnvFile(relPath: string): void {
  const file = join(appRoot, relPath);
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf-8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([^#=\s]+)\s*=\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    // Strip surrounding single/double quotes; trim whitespace and trailing CR.
    const value = match[2].trim().replace(/^['"]|['"]$/g, '');
    if (process.env[key] === undefined) process.env[key] = value; // first loader wins
  }
}

loadEnvFile('.env.e2e.local'); // test creds — highest precedence
loadEnvFile('.env.local'); // BFF server config (service-account secret, etc.)

// Redis db-1 isolation — pin AFTER loading so .env.local's db-0 REDIS_URL is overridden.
process.env.REDIS_URL = process.env.REDIS_TEST_URL ?? 'redis://localhost:6379/1';
