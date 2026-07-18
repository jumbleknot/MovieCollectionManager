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

function loadEnvFile(relPath: string, exclude: ReadonlySet<string> = new Set()): void {
  const file = join(appRoot, relPath);
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf-8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([^#=\s]+)\s*=\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    if (exclude.has(key)) continue; // caller opts a key out (see .env.docker load below)
    // Strip surrounding single/double quotes; trim whitespace and trailing CR.
    const value = match[2].trim().replace(/^['"]|['"]$/g, '');
    if (process.env[key] === undefined) process.env[key] = value; // first loader wins
  }
}

// Feature 041: .env.docker is the CONTAINER BFF's runtime config, which raises the agent rate/cost
// CEILINGS so a shared test user isn't locked out across many E2E turns (AGENT_RATE_LIMIT_REQUESTS,
// AGENT_SESSION_COST_CEILING_USD). Those raised values are correct for the container serving turns,
// but the IN-PROCESS agent-rate-limiter integration test imports @/config/env (read at import time,
// before any test's beforeAll) and asserts the DEFAULT thresholds (20 req / $0.50). Loading the raised
// ceilings would make the limiter never trip → false failures. Exclude them so the in-process limiter
// uses code defaults; the container keeps its own env (unaffected — it reads .env.docker directly).
const ENV_DOCKER_EXCLUDE = new Set(['AGENT_RATE_LIMIT_REQUESTS', 'AGENT_SESSION_COST_CEILING_USD']);

loadEnvFile('.env.e2e.local'); // test creds — highest precedence
loadEnvFile('.env.local'); // BFF server config (service-account secret, etc.)
// Feature 041 (T024): in CI (app-e2e) neither .env.e2e.local nor .env.local exists — gen-ci-env.mjs
// writes .env.docker with the BFF client secrets (KEYCLOAK_SERVICE_CLIENT_SECRET,
// AGENT_SUBJECT_TOKEN_*, COOKIE_SECRET, AGENT_CONFIG_ENC_KEY, …). Load it LAST (lowest precedence) so
// the integration suite resolves those creds on the host runner. Its URL values are Docker-internal
// (keycloak-service:8080, mcm-bff-store-mongo:27017, …); the app-e2e step overrides the
// host-reachable ones (KEYCLOAK_URL/MC_SERVICE_URL/MONGO_URL/BFF_BASE_URL) to localhost, and those
// win via the `undefined`-guard above. Locally this file may not exist (no-op) or hold dev values
// that .env.local already overrode. REDIS_URL is force-pinned to db 1 below regardless.
loadEnvFile('.env.docker', ENV_DOCKER_EXCLUDE);

// Redis db-1 isolation — pin AFTER loading so .env.local's db-0 REDIS_URL is overridden.
process.env.REDIS_URL = process.env.REDIS_TEST_URL ?? 'redis://localhost:6379/1';

// Feature 018: the agent-config integration suites drive the LIVE BFF over HTTP and assert via the
// in-process `store`, so both must hit the same Mongo db. They share `bff_db` on the dedicated
// `mcm-bff-store-mongo` instance (the env default) and self-clean by test-prefixed userId in afterAll —
// the same shared-db pattern these suites used before (when it was `mc_db`), now on the BFF's OWN
// instance. (A separate test db would require the live BFF container to use it too; tracked as a
// follow-up to the Redis db-1 style isolation.) MONGO_URL comes from .env.local (the dedicated 27018).
