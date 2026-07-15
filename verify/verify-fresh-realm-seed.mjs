#!/usr/bin/env node
/**
 * Feature 039 (Workstream A, FR-015) — regression guard for the from-scratch dev realm seed.
 *
 * Proves that a FRESH keycloak-store-postgres-data volume, brought up with the standard dev path,
 * yields a working grumpyrobot realm — the realm, the e2e-test-user, and the app clients all present
 * AND internally consistent (the imported client secrets == the values in stacks/auth.env). The proof
 * is a real ROPC token grant: e2e-test-user authenticates against the mcm-bff-test client using the
 * password + client-secret that gen-dev-secrets minted, which only succeeds if the whole seed is
 * coherent. This is the dev analog of feature 038's verify/ scripts.
 *
 * Default: provisions from scratch (wipes the volume → gen-dev-secrets → up-auth) then asserts.
 *   --assert-only   skip provisioning; assert against an already-running auth stack (fast re-check).
 *   --keep          leave the stack up on success (default also leaves it up; use down-auth to stop).
 *
 * Exit codes: 0 seed verified · 1 assertion failed · 2 provisioning/setup error.
 */
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AUTH_ENV = resolve(REPO_ROOT, 'infrastructure-as-code/docker/stacks/auth.env');
const KC_BASE = process.env.KC_BASE_URL || 'http://localhost:8099';
const REALM = 'grumpyrobot';
const ROPC_CLIENT_ID = 'mcm-bff-test';
const TEST_USER = process.env.E2E_TEST_USER || 'e2e-test-user';
const VOLUME = 'keycloak-store-postgres-data';

const args = process.argv.slice(2);
const assertOnly = args.includes('--assert-only');

function sh(cmd, opts = {}) {
  return execSync(cmd, { cwd: REPO_ROOT, stdio: 'pipe', encoding: 'utf8', ...opts });
}
// Signal failure by throwing (caught in the runner below) — never call process.exit() while fetch
// keep-alive sockets are open: on Windows that races libuv's handle close and aborts with
// "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)", corrupting the exit code. We set
// process.exitCode and let the loop drain instead.
class VerifyError extends Error {
  constructor(code, msg) {
    super(msg);
    this.code = code;
  }
}
function fail(code, msg) {
  throw new VerifyError(code, msg);
}
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDiscovery(timeoutMs = 120000) {
  const url = `${KC_BASE}/realms/${REALM}/.well-known/openid-configuration`;
  const deadline = Date.now() + timeoutMs;
  process.stdout.write(`[verify-fresh-realm-seed] waiting for realm discovery at ${url} `);
  // NOTE: cannot use Date.now() in a workflow sandbox, but this is a plain node script — fine here.
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        process.stdout.write(' ready\n');
        return;
      }
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) fail(2, `\nrealm ${REALM} did not become discoverable within ${timeoutMs}ms (import failed?)`);
    process.stdout.write('.');
    await sleep(3000);
  }
}

async function ropcLogin(password, clientSecret) {
  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: ROPC_CLIENT_ID,
    client_secret: clientSecret,
    username: TEST_USER,
    password,
    scope: 'openid',
  });
  const res = await fetch(`${KC_BASE}/realms/${REALM}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, hasToken: typeof json.access_token === 'string', error: json.error, desc: json.error_description };
}

async function main() {
  if (!assertOnly) {
    console.log(`[verify-fresh-realm-seed] provisioning FROM SCRATCH — wiping volume ${VOLUME}…`);
    try {
      sh('docker compose -p auth -f infrastructure-as-code/docker/stacks/auth.compose.yaml -f infrastructure-as-code/docker/keycloak/compose.dev.yaml down --remove-orphans', { stdio: 'ignore' });
    } catch { /* stack may not be up */ }
    // Force-remove the containers that mount the (external) volume FIRST — `down -v` does not remove an
    // external volume, and `docker volume rm` fails silently while a container still references it, which
    // leaves the OLD Postgres password in place (Postgres honors POSTGRES_PASSWORD only on first init) →
    // Keycloak then fails with "password authentication failed for user keycloak" and the realm never
    // imports. Removing the containers first makes the wipe actually take effect.
    try {
      sh('docker rm -f keycloak-service keycloak-store-postgres keycloak-mailpit', { stdio: 'ignore' });
    } catch { /* containers may not exist */ }
    try {
      sh(`docker volume rm ${VOLUME}`, { stdio: 'ignore' });
    } catch { /* volume may not exist */ }
    try {
      sh(`docker volume create ${VOLUME}`, { stdio: 'ignore' });
    } catch { /* external volume may already exist */ }
    console.log('[verify-fresh-realm-seed] gen-dev-secrets (mint auth.env) + gen-dev-env (project BFF secrets)…');
    sh('node scripts/gen-dev-secrets.mjs', { stdio: 'inherit' });
    sh('node scripts/gen-dev-env.mjs', { stdio: 'inherit' });
    console.log('[verify-fresh-realm-seed] up-auth (seeds the realm via compose.dev.yaml)…');
    sh('pnpm nx up-auth infrastructure-as-code', { stdio: 'inherit' });
  }

  if (!existsSync(AUTH_ENV)) fail(2, 'auth.env missing — run gen-dev-secrets first.');
  const auth = parseEnv(AUTH_ENV);
  const password = auth.E2E_TEST_PASSWORD;
  const ropcSecret = auth.E2E_ROPC_CLIENT_SECRET;
  if (!password || !ropcSecret) fail(2, 'E2E_TEST_PASSWORD / E2E_ROPC_CLIENT_SECRET absent from auth.env.');

  await waitForDiscovery();

  console.log(`[verify-fresh-realm-seed] asserting ROPC login for ${TEST_USER} via ${ROPC_CLIENT_ID}…`);
  const r = await ropcLogin(password, ropcSecret);
  if (!r.ok || !r.hasToken) {
    fail(1, `login FAILED (status ${r.status}${r.error ? `, ${r.error}: ${r.desc}` : ''}). The realm seed is incomplete or the client secret in the realm != auth.env.`);
  }
  console.log('[verify-fresh-realm-seed] ✅ fresh-volume seed verified: realm + e2e-test-user + clients present and consistent (ROPC token issued).');
}

// Best-effort: close fetch's global keep-alive pool so the process exits promptly (else it idles for
// undici's keepAliveTimeout). Falls back to a natural event-loop drain if undici isn't importable.
async function closePool() {
  try {
    const { getGlobalDispatcher } = await import('undici');
    await getGlobalDispatcher().close();
  } catch {
    /* undici not resolvable — natural drain */
  }
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((e) => {
    if (e instanceof VerifyError) {
      console.error(`[verify-fresh-realm-seed] ${e.message}`);
      process.exitCode = e.code;
    } else {
      console.error(`[verify-fresh-realm-seed] unexpected error: ${e?.message ?? e}`);
      process.exitCode = 2;
    }
  })
  .finally(closePool);
