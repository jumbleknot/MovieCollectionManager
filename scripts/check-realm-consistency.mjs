#!/usr/bin/env node
/**
 * Feature 039 (Workstream A, FR-013) — guard against drift between the dev and CI realm exports.
 * dev-realm.json is derived from ci-realm.json (the source of truth for the client/user contract); this
 * check fails if their realm name, app-client-id set, or e2e-test-user presence diverge. It does NOT
 * require byte-equality — the two may legitimately differ in non-contract fields (redirect URIs, token
 * lifespans) — only the security-relevant client/user set must stay in lockstep.
 *
 * Runs in guardrails (`--selftest` first, then the real check), gating any PR that edits either realm.
 *
 * Usage:
 *   node scripts/check-realm-consistency.mjs            # compare the two committed realm files
 *   node scripts/check-realm-consistency.mjs --selftest # prove the check FAILS on a mutated fixture
 *
 * Exit codes: 0 consistent · 1 drift detected · 2 file missing / unparseable.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KC_DIR = resolve(REPO_ROOT, 'infrastructure-as-code/docker/keycloak');
const DEV_REALM = resolve(KC_DIR, 'dev-realm.json');
const CI_REALM = resolve(KC_DIR, 'ci-realm.json');

// Keycloak's built-in clients exist in every realm and are not part of the app contract.
const DEFAULT_KC_CLIENTS = new Set([
  'account',
  'account-console',
  'admin-cli',
  'broker',
  'realm-management',
  'security-admin-console',
]);

/** The comparable contract of a realm export: name, app-client-id set, and usernames. */
function contractOf(realm) {
  const appClients = (realm.clients ?? [])
    .map((c) => c.clientId)
    .filter((id) => id && !DEFAULT_KC_CLIENTS.has(id))
    .sort();
  const usernames = (realm.users ?? []).map((u) => u.username).filter(Boolean).sort();
  return { realm: realm.realm, appClients, usernames };
}

/** Compare two contracts; return an array of human-readable differences (empty === consistent). */
function diff(devC, ciC) {
  const out = [];
  if (devC.realm !== ciC.realm) out.push(`realm name: dev="${devC.realm}" ci="${ciC.realm}"`);
  const devSet = new Set(devC.appClients);
  const ciSet = new Set(ciC.appClients);
  const onlyDev = devC.appClients.filter((c) => !ciSet.has(c));
  const onlyCi = ciC.appClients.filter((c) => !devSet.has(c));
  if (onlyDev.length) out.push(`clients only in dev-realm: ${onlyDev.join(', ')}`);
  if (onlyCi.length) out.push(`clients only in ci-realm: ${onlyCi.join(', ')}`);
  if (!devC.usernames.includes('e2e-test-user')) out.push('dev-realm is missing user e2e-test-user');
  if (!ciC.usernames.includes('e2e-test-user')) out.push('ci-realm is missing user e2e-test-user');
  const devU = new Set(devC.usernames);
  const onlyCiU = ciC.usernames.filter((u) => !devU.has(u));
  const ciU = new Set(ciC.usernames);
  const onlyDevU = devC.usernames.filter((u) => !ciU.has(u));
  if (onlyDevU.length) out.push(`users only in dev-realm: ${onlyDevU.join(', ')}`);
  if (onlyCiU.length) out.push(`users only in ci-realm: ${onlyCiU.join(', ')}`);
  return out;
}

function loadRealm(path) {
  if (!existsSync(path)) {
    console.error(`[check-realm-consistency] missing: ${path}`);
    process.exit(2);
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    console.error(`[check-realm-consistency] unparseable JSON: ${path} — ${e.message}`);
    process.exit(2);
  }
}

if (process.argv.includes('--selftest')) {
  // Prove the check is not trivially green: a mutated dev contract MUST produce a non-empty diff.
  const base = {
    realm: 'grumpyrobot',
    clients: [{ clientId: 'movie-collection-manager' }, { clientId: 'mc-service' }, { clientId: 'account' }],
    users: [{ username: 'e2e-test-user' }],
  };
  const okDiff = diff(contractOf(base), contractOf(base));
  const mutatedClient = { ...base, clients: [{ clientId: 'movie-collection-manager' }, { clientId: 'account' }] };
  const dropDiff = diff(contractOf(mutatedClient), contractOf(base));
  const mutatedUser = { ...base, users: [] };
  const userDiff = diff(contractOf(mutatedUser), contractOf(base));
  const pass = okDiff.length === 0 && dropDiff.length > 0 && userDiff.length > 0;
  if (!pass) {
    console.error('[check-realm-consistency] SELFTEST FAILED', { okDiff, dropDiff, userDiff });
    process.exit(1);
  }
  console.log('[check-realm-consistency] selftest OK (detects dropped client + missing user; identical == clean).');
  process.exit(0);
}

const differences = diff(contractOf(loadRealm(DEV_REALM)), contractOf(loadRealm(CI_REALM)));
if (differences.length) {
  console.error('[check-realm-consistency] dev-realm.json and ci-realm.json have drifted:');
  for (const d of differences) console.error(`  - ${d}`);
  console.error('Re-derive dev-realm.json from ci-realm.json (or update both) so the client/user contract matches.');
  process.exit(1);
}
console.log('[check-realm-consistency] dev-realm.json ⟷ ci-realm.json consistent (realm, app clients, e2e-test-user).');
process.exit(0);
