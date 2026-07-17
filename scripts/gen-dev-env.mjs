#!/usr/bin/env node
/**
 * Feature 039 (Workstream A) — dev twin of gen-ci-env.mjs. Projects the realm's client secrets from
 * stacks/auth.env (minted by gen-dev-secrets) into the dev BFF env files, so the imported dev realm's
 * client secrets == the dev BFF's client secrets BY CONSTRUCTION — the same invariant CI achieves by
 * feeding both the realm import and .env.docker from one set of Forgejo secrets. Closes the "realm
 * seeded but BFF secret mismatched → login fails on a fresh box" gap (spec R-A2, FR-005).
 *
 * Writes:
 *   1. frontend/mcm-app/.env.docker   (container BFF — the path the web E2E / verify-fresh-realm-seed
 *      exercise; env_file of mcm-bff-service-nonsecure). Fully generated from auth.env + BFF-only secrets.
 *   2. frontend/mcm-app/.env.local    (Metro dev loop) — SURGICALLY synced: only the client-secret lines
 *      are rewritten to match auth.env; every other developer-customised key is preserved. Skipped if
 *      the file does not exist (a fresh Metro checkout copies .env.example first — see local-dev.md).
 *   3. frontend/mcm-app/.env.e2e.local (web Playwright creds) — synced so the E2E logs in as the SEEDED
 *      realm's user (e2e-test-user) with the minted password + ROPC client secret. Without this the web
 *      E2E fails on a fresh box: the realm import uses auth.env's E2E_TEST_PASSWORD while a hand-edited
 *      .env.e2e.local carried a stale user/password (the exact fresh-box rot this feature closes, AC2).
 *   4. mcp-servers/web-api-mcp/.env.local (TMDB) — TMDB_API_KEY from the forwarded host env, so the
 *      web-api-mcp container has a key and the agent web E2E can seed a runnable config (dock renders).
 *
 * The 3 realm client secrets the BFF uses (KEYCLOAK_CLIENT_SECRET, KEYCLOAK_SERVICE_CLIENT_SECRET,
 * AGENT_SUBJECT_TOKEN_CLIENT_SECRET) come from auth.env. The BFF-only secrets (COOKIE_SECRET,
 * AGENT_CONFIG_ENC_KEY) are NOT realm-related: reuse the existing .env.docker value if present
 * (session continuity), else mint a fresh one. Nothing is committed (both targets are gitignored).
 *
 * Usage:
 *   node scripts/gen-dev-secrets.mjs   # first — mints stacks/auth.env (the realm/client secrets)
 *   node scripts/gen-dev-env.mjs       # then — projects them into the BFF env files
 *
 * Exit codes: 0 success · 1 missing auth.env / required key absent (run gen-dev-secrets first).
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AUTH_ENV = resolve(REPO_ROOT, 'infrastructure-as-code/docker/stacks/auth.env');
const ENV_DOCKER = resolve(REPO_ROOT, 'frontend/mcm-app/.env.docker');
const ENV_LOCAL = resolve(REPO_ROOT, 'frontend/mcm-app/.env.local');
const ENV_E2E = resolve(REPO_ROOT, 'frontend/mcm-app/.env.e2e.local');
// The seeded realm's test user (fixed in dev-realm.json / ci-realm.json) + ROPC client. Deterministic
// in dev, so the web E2E credential source is generated to match the realm — not hand-maintained.
const REALM_TEST_USER = 'e2e-test-user';
const ROPC_CLIENT_ID = 'mcm-bff-test';

/** Parse a KEY=VALUE dotenv file into a plain object (last wins; ignores blanks/comments). */
function parseEnv(path) {
  const out = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(t);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

if (!existsSync(AUTH_ENV)) {
  console.error(`[gen-dev-env] ${AUTH_ENV} not found — run \`node scripts/gen-dev-secrets.mjs\` first.`);
  process.exit(1);
}
const auth = parseEnv(AUTH_ENV);

/** Read a required client secret from auth.env; abort (no fallback literal) if absent. */
function reqFromAuth(name) {
  const v = auth[name];
  if (v == null || v === '') {
    console.error(`[gen-dev-env] ${name} missing from auth.env — run \`node scripts/gen-dev-secrets.mjs --force --stack=auth\`.`);
    process.exit(1);
  }
  return v;
}

const KEYCLOAK_CLIENT_SECRET = reqFromAuth('KEYCLOAK_CLIENT_SECRET');
const KEYCLOAK_SERVICE_CLIENT_SECRET = reqFromAuth('KEYCLOAK_SERVICE_CLIENT_SECRET');
const AGENT_SUBJECT_TOKEN_CLIENT_SECRET = reqFromAuth('AGENT_SUBJECT_TOKEN_CLIENT_SECRET');
const E2E_TEST_PASSWORD = reqFromAuth('E2E_TEST_PASSWORD');
const E2E_ROPC_CLIENT_SECRET = reqFromAuth('E2E_ROPC_CLIENT_SECRET');

// BFF-only secrets (not realm-related): reuse the existing .env.docker value for session continuity,
// else mint a fresh one. AGENT_CONFIG_ENC_KEY is an AES-256-GCM key the BFF loads as
// **base64 of 32 bytes** (`agent-config-crypto.ts` → `Buffer.from(key, 'base64')`, KEY_BYTES=32;
// same shape as bff/.env.prod.example's `openssl rand -base64 32`). Minting it as HEX yields 64
// chars that base64-decode to 48 bytes → every agent-config save 500s with
// "AGENT_CONFIG_ENC_KEY must decode to 32 bytes (got 48)" → the assistant dock never renders.
const priorDocker = existsSync(ENV_DOCKER) ? parseEnv(ENV_DOCKER) : {};
const COOKIE_SECRET = priorDocker.COOKIE_SECRET || randomBytes(32).toString('hex');
// Reuse a prior value only when it is a VALID 32-byte base64 key — a legacy hex key (or any
// wrong-length value) must be re-minted, otherwise the reuse path silently preserves the bug.
const priorEncKey = priorDocker.AGENT_CONFIG_ENC_KEY ?? '';
const AGENT_CONFIG_ENC_KEY =
  Buffer.from(priorEncKey, 'base64').length === 32 ? priorEncKey : randomBytes(32).toString('base64');

// 1 — BFF .env.docker (container). Non-secret values are Docker-internal service DNS (matches the
// committed .env.docker.example + compose); mirrors gen-ci-env's shape so dev == CI container posture.
const envDocker = `# GENERATED by scripts/gen-dev-env.mjs (feature 039) — DO NOT COMMIT (gitignored).
# Client secrets are projected from stacks/auth.env so they match the imported dev realm by construction.
KEYCLOAK_URL=http://keycloak-service:8080
KEYCLOAK_PUBLIC_URL=http://localhost:8099
KEYCLOAK_REALM=grumpyrobot
KEYCLOAK_CLIENT_ID=movie-collection-manager
KEYCLOAK_CLIENT_SECRET=${KEYCLOAK_CLIENT_SECRET}

# BFF service account
KEYCLOAK_SERVICE_CLIENT_ID=mcm-bff-service
KEYCLOAK_SERVICE_CLIENT_SECRET=${KEYCLOAK_SERVICE_CLIENT_SECRET}

# Redis (internal Docker network)
REDIS_URL=redis://mcm-bff-cache-redis:6379

# Cookie signing secret (BFF-only; not realm-related)
COOKIE_SECRET=${COOKIE_SECRET}

# Session config (milliseconds)
SESSION_IDLE_TIMEOUT_MS=1800000
SESSION_ABSOLUTE_TIMEOUT_MS=86400000
MAX_CONCURRENT_SESSIONS=10

# mc-service (internal Docker network)
MC_SERVICE_URL=http://mc-service:3001

# Agent Gateway (feature 012 — internal Docker network, --profile agents)
AGENT_GATEWAY_URL=http://movie-assistant-gateway:8000

# Agent subject-token client (feature 012 — RFC 8693 token exchange)
AGENT_SUBJECT_TOKEN_CLIENT_ID=agent-subject-token
AGENT_SUBJECT_TOKEN_CLIENT_SECRET=${AGENT_SUBJECT_TOKEN_CLIENT_SECRET}
AGENT_SUBJECT_TOKEN_AUDIENCE=agent-gateway

# Feature 018 — per-user agent config (BFF→Mongo AES-256-GCM store)
AGENT_CONFIG_ENC_KEY=${AGENT_CONFIG_ENC_KEY}
MONGO_URL=mongodb://mcm-bff-store-mongo:27017
`;
writeFileSync(ENV_DOCKER, envDocker, 'utf8');

/**
 * Surgically rewrite only the keys in `sync` in an existing dotenv file, preserving every other line
 * (developer customisations, comments, ordering). Appends any sync key the file did not already define.
 * Returns true if the file existed and was patched, false if absent (nothing written).
 */
function syncEnvFile(path, sync) {
  if (!existsSync(path)) return false;
  const seen = new Set();
  const patched = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((line) => {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line.trim());
      if (m && m[1] in sync) {
        seen.add(m[1]);
        return `${m[1]}=${sync[m[1]]}`;
      }
      return line;
    });
  for (const [k, v] of Object.entries(sync)) if (!seen.has(k)) patched.push(`${k}=${v}`);
  writeFileSync(path, patched.join('\n'), 'utf8');
  return true;
}

// 2 — .env.local (Metro): sync ONLY the client-secret lines; preserve every other key. Skipped when the
// file doesn't exist (fresh Metro checkout copies .env.example).
const localSynced = syncEnvFile(ENV_LOCAL, {
  KEYCLOAK_CLIENT_SECRET,
  KEYCLOAK_SERVICE_CLIENT_SECRET,
  AGENT_SUBJECT_TOKEN_CLIENT_SECRET,
});

// 3 — .env.e2e.local (web Playwright creds): sync the test user + password + ROPC secret to the SEEDED
// realm so a fresh box's web E2E logs in successfully. E2E_TEST_USER is the realm's fixed username;
// E2E_TEST_PASSWORD / E2E_ROPC_CLIENT_SECRET come from auth.env (what the realm imported). Preserves the
// non-secret fixture keys (E2E_COLLECTION_NAME, E2E_MOVIE_TITLE). Skipped if the file is absent.
const e2eSynced = syncEnvFile(ENV_E2E, {
  E2E_TEST_USER: REALM_TEST_USER,
  E2E_TEST_PASSWORD,
  E2E_ROPC_CLIENT_ID: ROPC_CLIENT_ID,
  E2E_ROPC_CLIENT_SECRET,
});

// 4 — mcp-servers/web-api-mcp/.env.local: the web-api-mcp container reads TMDB via --env-file, so the
// file must exist. TMDB_API_KEY comes from the forwarded HOST env (devcontainer.json ${localEnv});
// empty when unset (the agent's TMDB flows then no-op — dev leaves it empty until a key is set). The
// per-user agent config supplies the key per-request (018), but the agent WEB E2E also needs it in the
// harness env so agent-config-seed can create a runnable config (else the dock never renders). Mirrors
// gen-ci-env; overwrite is fine (generated file, no dev customization).
writeFileSync(
  resolve(REPO_ROOT, 'mcp-servers/web-api-mcp/.env.local'),
  `TMDB_API_KEY=${process.env.TMDB_API_KEY ?? ''}\nTMDB_BASE_URL=https://api.themoviedb.org/3\n`,
  'utf8',
);

console.log(
  `[gen-dev-env] wrote frontend/mcm-app/.env.docker` +
    (localSynced ? ' + synced .env.local' : ' (.env.local absent — skipped; copy .env.example for Metro)') +
    (e2eSynced ? ' + synced .env.e2e.local (web E2E creds → seeded realm)' : ' (.env.e2e.local absent — skipped)') +
    ` + web-api-mcp/.env.local (TMDB ${process.env.TMDB_API_KEY ? 'set' : 'empty'})` +
    ' — realm-secret == BFF-secret == E2E-cred from stacks/auth.env.',
);
