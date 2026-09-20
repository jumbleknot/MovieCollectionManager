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
 *   2. frontend/mcm-app/.env.local    (Metro dev loop, AND the credential source the local agent/MCP
 *      integration suites read via kc_admin.cfg()) — SURGICALLY synced: only the client-secret lines
 *      are rewritten to match auth.env; every other developer-customised key is preserved. CREATED
 *      when absent (048 FR-022). It used to be SKIPPED when absent, which silently disabled the local
 *      integration tier on 2026-08-07 — the secrets reached .env.docker but never the file the tests
 *      read, and the box was misdiagnosed as unable to run them at all. The old advice here pointed at
 *      a `.env.example` that does not exist in this repository.
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
 * The credentials are VERIFIED against the running realm BEFORE anything is written (item #395) —
 * see verifyAgainstRealm. Writing the files proves the values reached disk; it proves nothing about
 * whether they still authenticate, and the success line used to assert exactly that.
 *
 * Exit codes: 0 success · 1 missing auth.env / required key absent (run gen-dev-secrets first)
 *             · 2 the running realm REFUSES a projected credential — NOTHING is written (item #395).
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AUTH_ENV = resolve(REPO_ROOT, 'infrastructure-as-code/docker/stacks/auth.env');
const ENV_DOCKER = resolve(REPO_ROOT, 'frontend/mcm-app/.env.docker');
const ENV_LOCAL = resolve(REPO_ROOT, 'frontend/mcm-app/.env.local');
const ENV_E2E = resolve(REPO_ROOT, 'frontend/mcm-app/.env.e2e.local');
// Item #227 — the fifth file, and the one nothing wrote. `backend/mc-service/.env.local` is
// documented in docs/runbooks/local-dev.md ("Local dev: `backend/mc-service/.env.local`
// (gitignored)") along with the six variables it needs, and no command created it. Measured
// 2026-08-22: `pnpm nx affected -t lint,test,typecheck` on a branch whose Rust tree was
// BYTE-IDENTICAL to main reported `mc-service:test` FAILED, 25 passed / 16 failed, on
//
//   panicked at backend/mc-service/tests/integration/common/mod.rs:95:
//   Missing test configuration — ensure .env.local exists in backend/mc-service/: Missing("MC_DB_URL")
//
// Writing this file from the runbook's values took it to 32 passed / 9 failed, so SEVEN of the sixteen
// failures were one absent file and nothing distinguished them from the nine that were not — which
// trains the reader to ignore a whole tier's result. Same defect as 048 US6, one directory over.
// (The other nine were recorded on the item as needing the replica-set MongoDB. They did not; see the
// E2E_* note at the write site below, where the tier now goes 41 passed / 0 failed.)
const MC_SERVICE_ENV_LOCAL = resolve(REPO_ROOT, 'backend/mc-service/.env.local');
const MC_SERVICE_CLIENT_ID = 'movie-collection-manager';
// The documented LOCAL value (the Docker one, with ?replicaSet=rs0&directConnection=true, is set in
// infrastructure-as-code/docker/mc-service/compose.yaml and is not this file's business). Overridable
// from the environment for a box whose Mongo is not on the default port.
const MC_DB_URL = process.env.MC_DB_URL || 'mongodb://localhost:27017/mc_db';
const MC_SERVICE_PORT = process.env.MC_SERVICE_PORT || '3001';
// The seeded realm's test user (fixed in dev-realm.json / ci-realm.json) + ROPC client. Deterministic
// in dev, so the web E2E credential source is generated to match the realm — not hand-maintained.
const REALM_TEST_USER = 'e2e-test-user';
const ROPC_CLIENT_ID = 'mcm-bff-test';
const KEYCLOAK_REALM = 'grumpyrobot';
const BFF_SERVICE_CLIENT_ID = 'mcm-bff-service';
// The realm as reachable from the HOST (the container path is keycloak-service:8080, which does not
// resolve here). `KEYCLOAK_PUBLIC_URL` is the same name .env.docker uses for it.
const KEYCLOAK_VERIFY_URL = process.env.KEYCLOAK_PUBLIC_URL || 'http://localhost:8099';
const VERIFY_TIMEOUT_MS = Number(process.env.MCM_REALM_VERIFY_TIMEOUT_MS) || 8000;

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

// Feature 073 — backup destination credentials. A SEPARATE AES-256-GCM key from
// AGENT_CONFIG_ENC_KEY by design (see env.ts): one key protecting assistant credentials, another
// protecting "where this server may write the user's entire collection".
//
// It is reused from `.env.docker` FIRST and `.env.local` SECOND, and that order matters. The two
// files feed two different BFF processes — the containerized one and the Metro dev loop — against
// the SAME BFF Mongo. If they hold different keys, a destination saved under one is undecryptable
// under the other, and the symptom is an authentication failure on a secret that was stored
// correctly. Same validity rule as the agent key: a wrong-length prior value is re-minted, because
// reusing it would silently preserve the bug it represents.
const priorLocal = existsSync(ENV_LOCAL) ? parseEnv(ENV_LOCAL) : {};
const priorBackupKey = priorDocker.BACKUP_CREDENTIAL_ENC_KEY || priorLocal.BACKUP_CREDENTIAL_ENC_KEY || '';
const BACKUP_CREDENTIAL_ENC_KEY =
  Buffer.from(priorBackupKey, 'base64').length === 32 ? priorBackupKey : randomBytes(32).toString('base64');
// Guards the INTERNAL tick route. Shared between the two files for the same reason.
const BACKUP_TICK_SECRET =
  priorDocker.BACKUP_TICK_SECRET || priorLocal.BACKUP_TICK_SECRET || randomBytes(32).toString('hex');
// The dev destinations the backup URL guard must admit: the guard denies private space BY DEFAULT
// (the inverse of the Ollama guard), so the feature's own test containers are unreachable until
// they are named here. Both bind to loopback only — see the `backups` Compose profile.
const BACKUP_ALLOWED_DESTINATION_HOSTS =
  'localhost,127.0.0.1,mcm-backup-test-minio,mcm-backup-test-webdav';

// --- Verify the projection against the RUNNING realm (item #395) ---------------------------------
//
// Writing the files proves the values reached disk. It proves NOTHING about whether they still
// authenticate — and the line below used to assert `realm-secret == BFF-secret == E2E-cred` purely
// on the strength of having copied them out of auth.env.
//
// Measured 2026-09-08: movie-mcp's integration suite skipped every test on
//
//     ROPC token request failed (401): {"error":"unauthorized_client", ...}
//
// (20 ERRORS under MCM_REQUIRE_LIVE_STACK=1) while `.env.e2e.local` existed and carried a 64-char
// secret — so the repo's own "a credential-driven skip is almost always a missing FILE" heuristic
// sent the reader after an absent file that was not absent. That run had reported success, including
// the equality claim, over a realm whose `mcm-bff-test` secret did not match.
//
// `auth.env` stays the SOURCE OF TRUTH — it is what seeds the realm, and projecting the realm's
// values back into the env files would repair one client while quietly leaving the invariant broken
// for the rest. So this verifies and refuses; it does not resync — the fix belongs at the realm.
//
// It reports per credential rather than as a verdict on the realm, because the scale of the drift is
// what picks the remedy and it is easy to over-read. Measured 2026-09-09: five of six client secrets
// matched auth.env and only `mcm-bff-test` had been regenerated, so the tempting summary "the realm
// was seeded from a different auth.env" was wrong, and the wipe-and-re-seed it implies would have
// destroyed the Keycloak database to correct a single field.

/** One `POST /protocol/openid-connect/token`, reduced to what the diagnosis needs. */
async function tokenRequest(body) {
  const base = KEYCLOAK_VERIFY_URL.replace(/\/+$/, '');
  const res = await fetch(`${base}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
  });
  let payload = {};
  try {
    payload = await res.json();
  } catch {
    // A non-JSON body is still an answer; the status code carries the verdict.
  }
  return { status: res.status, ok: res.ok, error: payload.error ?? '', detail: payload.error_description ?? '' };
}

/**
 * Ask the realm whether the projected credentials actually work.
 *
 * Both halves of the claimed equality are exercised: the BFF service account (client_credentials —
 * the secret `.env.local` feeds to `kc_admin.cfg()`) and the E2E ROPC client (password — the one
 * that 401'd). Only 400/401/403 count as STALE: a 404 means the realm is not seeded yet and a 5xx
 * means Keycloak is still coming up, and neither says anything about the secrets.
 *
 * @returns {{status: 'verified'|'stale'|'unverified'|'skipped', reason?: string, stale?: object[]}}
 */
async function verifyAgainstRealm() {
  if (process.env.MCM_SKIP_REALM_VERIFY) {
    return { status: 'skipped', reason: 'MCM_SKIP_REALM_VERIFY is set' };
  }
  const checks = [
    {
      what: `${BFF_SERVICE_CLIENT_ID} — KEYCLOAK_SERVICE_CLIENT_SECRET (.env.local, .env.docker)`,
      body: {
        grant_type: 'client_credentials',
        client_id: BFF_SERVICE_CLIENT_ID,
        client_secret: KEYCLOAK_SERVICE_CLIENT_SECRET,
      },
    },
    {
      what: `${ROPC_CLIENT_ID} — E2E_ROPC_CLIENT_SECRET + E2E_TEST_PASSWORD (.env.e2e.local)`,
      body: {
        grant_type: 'password',
        client_id: ROPC_CLIENT_ID,
        client_secret: E2E_ROPC_CLIENT_SECRET,
        username: REALM_TEST_USER,
        password: E2E_TEST_PASSWORD,
        scope: 'openid',
      },
    },
  ];

  const stale = [];
  const passed = [];
  for (const check of checks) {
    let answer;
    try {
      answer = await tokenRequest(check.body);
    } catch (err) {
      // Not reachable at all: this script legitimately runs BEFORE `up-auth`. Never a failure — but
      // the equality must then not be claimed either. `fetch` wraps the real cause one level down,
      // so reading err.code/err.name first reports a bare `TypeError` and hides the ECONNREFUSED.
      const cause = err.cause?.code ?? err.cause?.message ?? err.code ?? err.name;
      return { status: 'unverified', reason: `${KEYCLOAK_VERIFY_URL} — ${cause}` };
    }
    if (answer.ok) {
      passed.push(check);
      continue;
    }
    if (![400, 401, 403].includes(answer.status)) {
      return {
        status: 'unverified',
        reason: `${KEYCLOAK_VERIFY_URL} answered HTTP ${answer.status} (realm \`${KEYCLOAK_REALM}\` not seeded, or Keycloak still starting)`,
      };
    }
    stale.push({ ...check, ...answer });
  }
  return stale.length ? { status: 'stale', stale, passed } : { status: 'verified' };
}

// Verified BEFORE anything is written. Ordering is load-bearing: measured on the operator's box
// 2026-09-09, `auth.env`'s E2E_ROPC_CLIENT_SECRET was the stale side while a hand-corrected
// `.env.e2e.local` held the value the realm actually accepts. A generator that writes first and
// checks afterwards therefore DESTROYS the one working credential on the machine before announcing
// the problem — turning a diagnosis into an outage. Refusing wholesale keeps whatever works today:
// nothing here is written unless every checkable credential authenticates.
const verification = await verifyAgainstRealm();

if (verification.status === 'stale') {
  console.error(
    `[gen-dev-env] REFUSING TO WRITE: the realm at ${KEYCLOAK_VERIFY_URL} rejects credential(s) in\n` +
      '  stacks/auth.env, so projecting them would overwrite working env files with values that 401.\n' +
      verification.stale
        .map((c) => `    ✗ ${c.what}\n        HTTP ${c.status} ${c.error}${c.detail ? `: ${c.detail}` : ''}`)
        .join('\n') +
      (verification.passed.length
        ? `\n${verification.passed.map((c) => `    ✓ ${c.what}`).join('\n')}`
        : '') +
      '\n\n  Your env files are PRESENT and were left untouched — so this is NOT the "missing\n' +
      '  gitignored file" case (item #227), and chasing an absent file here is what costs the\n' +
      '  session. stacks/auth.env and the running realm have DRIFTED: the realm was imported from a\n' +
      '  different auth.env, or that client secret was regenerated after the import.\n' +
      '\n  stacks/auth.env is the source of truth (it is what seeds the realm), so fix the REALM —\n' +
      '  copying the realm\'s secret back into an env file repairs one suite and leaves\n' +
      '  realm-secret == BFF-secret broken everywhere else.\n' +
      '\n  How MUCH of the realm to fix depends on how much drifted, so measure before you act — the\n' +
      '  ✓/✗ list above is the first half of that answer. Measured 2026-09-09: FIVE of six client\n' +
      '  secrets matched and one had been regenerated, so "the realm was seeded from a different\n' +
      '  auth.env" was the wrong reading and a volume wipe would have destroyed the Keycloak\n' +
      '  database to correct one field. Compare every client (see the audit snippet in the runbook),\n' +
      '  then:\n' +
      '    - a FEW clients drifted -> set those clients\' secrets to auth.env\'s values via the admin\n' +
      '      API; the realm converges on the source of truth and nothing else is touched.\n' +
      '    - MOST or ALL drifted -> the realm really was seeded from a different auth.env; re-seed:\n' +
      '      docker rm -f keycloak-service keycloak-store-postgres keycloak-mailpit\n' +
      '      docker volume rm keycloak-store-postgres-data && docker volume create keycloak-store-postgres-data\n' +
      '      node scripts/gen-dev-secrets.mjs && node scripts/gen-dev-env.mjs\n' +
      '      pnpm nx up-auth infrastructure-as-code\n' +
      '  (docs/runbooks/local-dev.md — "A projected credential can be STALE, not merely absent").\n' +
      '  A re-run then exits 0 with `VERIFIED against the realm`.\n' +
      '\n  To project anyway, knowing the files will carry credentials the realm refuses:\n' +
      '      MCM_SKIP_REALM_VERIFY=1 node scripts/gen-dev-env.mjs',
  );
  process.exit(2);
}

// 1 — BFF .env.docker (container). Non-secret values are Docker-internal service DNS (matches the
// committed .env.docker.example + compose); mirrors gen-ci-env's shape so dev == CI container posture.
const envDocker = `# GENERATED by scripts/gen-dev-env.mjs (feature 039) — DO NOT COMMIT (gitignored).
# Client secrets are projected from stacks/auth.env so they match the imported dev realm by construction.
KEYCLOAK_URL=http://keycloak-service:8080
KEYCLOAK_PUBLIC_URL=http://localhost:8099
KEYCLOAK_REALM=${KEYCLOAK_REALM}
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

# E2E ceilings, mirroring scripts/gen-ci-env.mjs — so a LOCAL full-suite run is not locked out the
# way CI already is not. Both limits are keyed on the USER, and six Playwright workers share one
# E2E_TEST_USER, so the shared identity exhausts a per-user bucket built for one person.
#
# MEASURED 2026-08-11, before this existed: a local full suite produced 141 agent_rate_limit_exceeded
# events, the dock's /run/info probe 429'd into runtime_info_fetch_failed -> empty agent registry
# -> "Agent movie_assistant not found", and the gateway received 24 turns where a healthy run drives
# ~155. Every agent/dock spec failed together. Indistinguishable, from the outside, from the CI
# collapse tracked as item #173 — which it is NOT: CI already sets these, and all three collapsed CI
# bundles report agent_rate_limit_exceeded=0.
#
# This is a STOPGAP and is marked as one. It suits the harness by raising a limit, which is the trade
# feature 052 deliberately refused for the refresh bucket. Per-worker USERS (backlog #169) remove the
# need for it here and in CI by construction, and this block should be deleted with that change.
AGENT_SESSION_COST_CEILING_USD=1000
AGENT_RATE_LIMIT_REQUESTS=10000

# Feature 018 — per-user agent config (BFF→Mongo AES-256-GCM store)
AGENT_CONFIG_ENC_KEY=${AGENT_CONFIG_ENC_KEY}
MONGO_URL=mongodb://mcm-bff-store-mongo:27017

# Feature 073 — per-user scheduled collection backups. The ceilings are left at their code
# defaults here; set them only to tighten a specific deployment.
BACKUP_CREDENTIAL_ENC_KEY=${BACKUP_CREDENTIAL_ENC_KEY}
BACKUP_TICK_SECRET=${BACKUP_TICK_SECRET}
BACKUP_ALLOWED_DESTINATION_HOSTS=${BACKUP_ALLOWED_DESTINATION_HOSTS}
`;
writeFileSync(ENV_DOCKER, envDocker, 'utf8');

/**
 * Surgically rewrite only the keys in `sync` in an existing dotenv file, preserving every other line
 * (developer customisations, comments, ordering). Appends any sync key the file did not already define.
 *
 * Returns 'synced' when an existing file was patched, 'created' when an absent file was written from
 * scratch (opts.create), and false when an absent file was left alone.
 *
 * 048 US6 / FR-022 — `create`. This function used to return false for a missing path, full stop, and
 * the caller turned that into a console aside. That silent no-op disabled a whole local test tier on
 * 2026-08-07: `.env.local` did not exist, so the three realm client secrets never reached the file
 * `kc_admin.cfg()` reads, every credential-dependent integration test skipped, and the box was
 * misdiagnosed as "cannot run this leg — CI is where it gets proven". It was one missing gitignored
 * file. A generator step that quietly does nothing and reports success is the same defect class as a
 * gate that skips to green.
 *
 * Creating is safe for a secrets-only sync set: the values written are exactly the ones `.env.docker`
 * already receives from the same `auth.env`, so a created file is a strict SUBSET of a correct one,
 * never a conflicting one. It is deliberately opt-in per call — a file whose sync set is only part of
 * what it needs (e.g. `.env.e2e.local`, which also carries non-generated fixture keys) would be
 * half-written by the same treatment, so that one still reports absence loudly instead.
 */
function syncEnvFile(path, sync, opts = {}) {
  // `defaults` (item #227): keys SEEDED when absent and never rewritten when present — the developer
  // knobs (MC_DB_URL, MC_SERVICE_PORT, RUST_LOG), as opposed to `sync`'s realm-derived values which
  // must match the realm by construction. Seeding-not-syncing is the difference between a fresh box
  // that works and a re-run that silently undoes a deliberate `RUST_LOG=mc_service=debug` or a Mongo
  // pointed somewhere else. Absence still has to be fixed, though: the measured panic is
  // `Missing("MC_DB_URL")`, so a file that EXISTS without that key fails exactly like no file at all.
  const defaults = opts.defaults ?? {};
  if (!existsSync(path)) {
    if (!opts.create) return false;
    mkdirSync(dirname(path), { recursive: true });
    const header = opts.header ? `${opts.header}\n` : '';
    const body = Object.entries({ ...defaults, ...sync }).map(([k, v]) => `${k}=${v}`).join('\n');
    writeFileSync(path, `${header}${body}\n`, 'utf8');
    return 'created';
  }
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
  // A `defaults` key already in the file is left exactly as the developer set it; only an absent one
  // is seeded. `seen` holds every key the file defines, including ones outside `sync`.
  const present = new Set(
    readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .map((line) => /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line.trim())?.[1])
      .filter(Boolean),
  );
  for (const [k, v] of Object.entries(defaults)) if (!present.has(k)) patched.push(`${k}=${v}`);
  writeFileSync(path, patched.join('\n'), 'utf8');
  return 'synced';
}

// 2 — .env.local (Metro dev loop AND the local integration suites' credential source): sync ONLY the
// client-secret lines; preserve every other key. CREATED when absent (048 FR-022) — see syncEnvFile.
// `kc_admin.cfg()` reads this file for KEYCLOAK_SERVICE_CLIENT_SECRET, so an absent one silently
// skips every credential-dependent agent/MCP integration test.
const localResult = syncEnvFile(
  ENV_LOCAL,
  { KEYCLOAK_CLIENT_SECRET, KEYCLOAK_SERVICE_CLIENT_SECRET, AGENT_SUBJECT_TOKEN_CLIENT_SECRET },
  {
    create: true,
    // 073 — SEEDED, not synced. Rewriting BACKUP_CREDENTIAL_ENC_KEY on a re-run would orphan every
    // destination secret already sealed under the old one, and the failure would surface much later
    // as an authentication error on a credential the user entered correctly. The ceilings and the
    // tick interval are developer knobs and follow the same seed-once rule.
    defaults: {
      // The host-reachable service URLs. These are NOT new knobs — `.env.docker` already defines
      // all four, with DOCKER-INTERNAL names, and the integration suite loads that file LAST as a
      // fallback. With `.env.local` silent on them, the fallback wins and every local suite that
      // touches Mongo, mc-service or Keycloak dies on `getaddrinfo ENOTFOUND mcm-bff-store-mongo`
      // — a name no process outside the compose network can resolve. MEASURED 2026-09-20:
      // `agent-config-store.integration.test.ts` fails that way on a box where the same Mongo is
      // answering on 127.0.0.1:27018, and `tests/integration/setup/env.ts` says in a comment that
      // "MONGO_URL comes from .env.local (the dedicated 27018)" — the expectation was written down
      // and nothing ever wrote the line. Seeded, not synced, so a developer pointing at a
      // different instance keeps it.
      MONGO_URL: 'mongodb://localhost:27018',
      MC_SERVICE_URL: 'http://localhost:3001',
      KEYCLOAK_URL: 'http://localhost:8099',
      REDIS_URL: 'redis://localhost:6379',
      BACKUP_CREDENTIAL_ENC_KEY,
      BACKUP_TICK_SECRET,
      BACKUP_ALLOWED_DESTINATION_HOSTS,
      BACKUP_MAX_MOVIES: 25000,
      BACKUP_MAX_UNCOMPRESSED_BYTES: 67108864,
      BACKUP_TICK_INTERVAL_MS: 60000,
    },
    header:
      '# GENERATED by scripts/gen-dev-env.mjs — gitignored, never commit.\n' +
      '# The realm client secrets, projected from stacks/auth.env so they match the imported dev\n' +
      '# realm by construction. Re-run `node scripts/gen-dev-env.mjs` after re-minting secrets.\n' +
      '# Add your own Metro keys below; a re-run rewrites ONLY the three secret lines.',
  },
);

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

// 5 — backend/mc-service/.env.local (item #227): the mc-service integration suite's config source.
// The realm trio is SYNCED (it must point at the realm these secrets came from, same rule as the
// frontend file); the three developer knobs are SEEDED ONLY WHEN ABSENT, so a tuned RUST_LOG or a
// redirected Mongo survives a re-run. No secret is written here — mc-service validates JWTs against
// the realm's public JWKS and holds no client secret of its own.
//
// The E2E_* four are the SECOND half of item #227, found by running the tier rather than by reading
// the item. The item recorded the residual 9 `http_authz_test::*` failures as "genuinely need the
// local replica-set MongoDB — a real infrastructure requirement, not a missing file". MEASURED
// 2026-09-15, with Mongo up and the other 32 cases passing against it, all 9 failed on
//
//   panicked at backend/mc-service/tests/integration/common/auth.rs:70:
//   E2E_ROPC_CLIENT_ID is not set (or is empty). It must be set for the authenticated
//   authorization tests — see backend/mc-service/.env.local.
//
// So they were never DB-gated: feature 046's authenticated-authz suite mints a real ROPC token and
// needs four more variables in this same file. All four are already projected into
// `.env.e2e.local` a few lines above, from the same `auth.env` — the values existed, the file that
// needed them did not get them. Same defect, third instance. They are SYNCED, not seeded: they are
// realm-derived credentials and must match the seeded realm by construction.
const mcServiceResult = syncEnvFile(
  MC_SERVICE_ENV_LOCAL,
  {
    KEYCLOAK_URL: KEYCLOAK_VERIFY_URL,
    KEYCLOAK_REALM,
    KEYCLOAK_CLIENT_ID: MC_SERVICE_CLIENT_ID,
    E2E_ROPC_CLIENT_ID: ROPC_CLIENT_ID,
    E2E_ROPC_CLIENT_SECRET,
    E2E_TEST_USER: REALM_TEST_USER,
    E2E_TEST_PASSWORD,
  },
  {
    create: true,
    defaults: { MC_DB_URL, MC_SERVICE_PORT, RUST_LOG: 'info' },
    header:
      '# GENERATED by scripts/gen-dev-env.mjs — gitignored, never commit.\n' +
      '# The mc-service local-dev / integration-test configuration (docs/runbooks/local-dev.md,\n' +
      '# "mc-service env vars"). The KEYCLOAK_*/E2E_* lines are rewritten on every re-run to match\n' +
      '# the seeded realm; MC_DB_URL, MC_SERVICE_PORT and RUST_LOG are seeded once and then left\n' +
      '# alone, so tune them freely. The E2E_* four are what feature 046\'s authenticated\n' +
      '# http_authz_test::* cases use to mint a real ROPC token. Running the suite also needs the\n' +
      '# local replica-set MongoDB up (`pnpm nx up infrastructure-as-code`) — infrastructure, not\n' +
      '# this file.',
  },
);

// Files that are documented but deliberately NOT generated. Naming them is part of the success line
// being accurate: item #227 is as much about the output claiming completeness as about the missing
// file, and a skipped file nobody mentions reads identically to one nobody thought of.
const NOT_GENERATED = [
  [
    'agents/movie-assistant/.env.local',
    'carries the operator\'s own Anthropic credential — CLAUDE.md scopes that to ' +
      'MCM_ANTHROPIC_API_KEY, mapped to ANTHROPIC_API_KEY only at the point of use, so this ' +
      'generator must not become a fourth place the key lives. Supply it by hand; see ' +
      'docs/runbooks/agent-layer.md.',
  ],
];

// The equality is claimed ONLY when it was checked. Every other path says what was, and was not,
// done — the whole of item #395 is that this sentence used to be printed unconditionally.
function claim({ status, reason }) {
  if (status === 'verified') {
    return `— realm-secret == BFF-secret == E2E-cred, VERIFIED against the realm at ${KEYCLOAK_VERIFY_URL}.`;
  }
  if (status === 'skipped') {
    return `— projected from stacks/auth.env but NOT verified (${reason}); unset it to check them against the realm.`;
  }
  return (
    `— projected from stacks/auth.env but NOT verified: ${reason}. Bring the auth stack up ` +
    '(`pnpm nx up-auth infrastructure-as-code`) and re-run to check them.'
  );
}

console.log(
  `[gen-dev-env] wrote frontend/mcm-app/.env.docker` +
    (localResult === 'created' ? ' + CREATED .env.local (was absent)' : ' + synced .env.local') +
    (e2eSynced ? ' + synced .env.e2e.local (web E2E creds → seeded realm)' : '') +
    ` + web-api-mcp/.env.local (TMDB ${process.env.TMDB_API_KEY ? 'set' : 'empty'})` +
    (mcServiceResult === 'created'
      ? ' + CREATED backend/mc-service/.env.local (was absent)'
      : ' + synced backend/mc-service/.env.local') +
    ` ${claim(verification)}`,
);

// What was NOT written, and why. Printed unconditionally and on the same run as the success line —
// the whole of item #227 is that an absent file was indistinguishable from an unconsidered one.
for (const [path, why] of NOT_GENERATED) {
  console.log(`[gen-dev-env] NOT written (by design): ${path} — ${why}`);
}

// `.env.e2e.local` is NOT auto-created: its sync set is only the credential half, and the web E2E also
// needs the non-generated fixture keys (E2E_COLLECTION_NAME, E2E_MOVIE_TITLE), so a created file would
// be half-written. But absence must still be LOUD rather than a parenthetical — an absent file here
// means the web E2E logs in as nobody (048 FR-023: no silent no-op, and no advice to copy a file that
// does not exist).
if (!e2eSynced) {
  console.warn(
    '[gen-dev-env] WARNING: frontend/mcm-app/.env.e2e.local is ABSENT, so the web E2E credentials ' +
      'were not written and `pnpm nx e2e mcm-app` will fail to log in. Create it with:\n' +
      `    E2E_TEST_USER=${REALM_TEST_USER}\n    E2E_TEST_PASSWORD=<from stacks/auth.env>\n` +
      `    E2E_ROPC_CLIENT_ID=${ROPC_CLIENT_ID}\n    E2E_ROPC_CLIENT_SECRET=<from stacks/auth.env>\n` +
      '    E2E_COLLECTION_NAME=<any seeded collection>\n    E2E_MOVIE_TITLE=<any seeded title>\n' +
      '  then re-run this script to fill the credential lines.',
  );
}

