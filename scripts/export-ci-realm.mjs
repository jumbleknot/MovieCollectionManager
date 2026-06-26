#!/usr/bin/env node
/**
 * Feature 023 (T008) — Export + sanitize the throwaway CI realm.
 *
 * WHY a script and not a hand-written JSON: the `grumpyrobot` realm is RUNTIME-MANAGED —
 * it lives only in the dev box's keycloak-store-postgres volume; there is NO committed realm
 * source (add-container-redirect-uris.mjs documents that), and the full token-exchange wiring
 * (movie-collection-manager + mcm-bff-service + agent-gateway + agent-subject-token + mc-service,
 * their audience/hardcoded-claim mappers, and the standard-token-exchange client attributes from
 * configure-token-exchange.mjs) is too intricate to reproduce by hand without silently breaking
 * the CI run. This script captures the EXACT live topology via the Keycloak Admin API
 * partial-export, then sanitizes it into a committable, throwaway-only realm import.
 *
 * It produces `infrastructure-as-code/docker/keycloak/ci-realm.json` — a throwaway realm
 * (realm `grumpyrobot`, all clients, the `mc-admin`/`mc-user` roles, the `E2E_TEST_USER` with
 * `mc-user`, and ONLY throwaway client secrets) that Keycloak imports in CI with `--import-realm`
 * so `app-ci` provisions its own reproducible environment (FR-006, FR-011, research R5).
 *
 * Run ONCE on the dev box that holds the configured realm (and re-run whenever the realm's
 * client/mapper topology changes), then commit the output:
 *
 *   # PowerShell — set admin creds in your shell, never on disk
 *   $env:KC_URL='http://localhost:8099'; $env:REALM='grumpyrobot'
 *   $env:KC_ADMIN='admin'; $env:KC_ADMIN_PASSWORD='***'
 *   node scripts/export-ci-realm.mjs
 *
 * The throwaway client secrets below MUST equal the matching Forgejo Actions CI secrets the
 * operator seeds (T002) so the imported realm and the CI-written .env.docker agree:
 *   movie-collection-manager.secret  ==  secrets.KEYCLOAK_CLIENT_SECRET
 *   mcm-bff-service.secret           ==  secrets.KEYCLOAK_SERVICE_CLIENT_SECRET
 *   agent-subject-token.secret       ==  (BFF AGENT_SUBJECT_TOKEN_CLIENT_SECRET in CI .env.docker)
 * Override any of them via env (CI_*_SECRET) to align with whatever values you seed in Forgejo.
 *
 * GREEN gate (T008 / T012): after committing, boot Keycloak with `--import-realm` against this
 * file and confirm it imports cleanly + the web E2E login + the 4 agent flows pass on the runner.
 *
 * SECURITY: the embedded secrets are THROWAWAY CI values only — never the prod client secrets
 * (those live in Komodo/Vault, kept in prod-realm.json's separate store, FR-009). secret-scan.mjs
 * runs over the committed output; if a throwaway shape is flagged, allowlist it explicitly in the
 * gate (do not weaken the pattern) — contracts/secrets-and-variables.md rule 3.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const KC_URL = process.env.KC_URL ?? 'http://localhost:8099';
const REALM = process.env.REALM ?? 'grumpyrobot';
const KC_ADMIN = process.env.KC_ADMIN ?? 'admin';
const KC_ADMIN_PASSWORD = process.env.KC_ADMIN_PASSWORD;

const E2E_TEST_USER = process.env.E2E_TEST_USER ?? 'e2e-test-user';
const E2E_TEST_PASSWORD = process.env.E2E_TEST_PASSWORD ?? 'ci-throwaway-password';

// Throwaway CI client secrets. These are NOT prod secrets. Keep them aligned with the Forgejo
// Actions CI secrets the operator seeds (T002) so the imported realm matches the CI .env.docker.
const THROWAWAY_CLIENT_SECRETS = {
  'movie-collection-manager': process.env.CI_KEYCLOAK_CLIENT_SECRET ?? 'ci-throwaway-mcm-client-secret',
  'mcm-bff-service': process.env.CI_KEYCLOAK_SERVICE_CLIENT_SECRET ?? 'ci-throwaway-bff-service-secret',
  'agent-gateway': process.env.CI_AGENT_GATEWAY_SECRET ?? 'ci-throwaway-agent-gateway-secret',
  'agent-subject-token': process.env.CI_AGENT_SUBJECT_TOKEN_SECRET ?? 'ci-throwaway-agent-subject-token-secret',
  'mc-service': process.env.CI_MC_SERVICE_SECRET ?? 'ci-throwaway-mc-service-secret',
};

const OUT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../infrastructure-as-code/docker/keycloak/ci-realm.json',
);

if (!KC_ADMIN_PASSWORD) {
  console.error('KC_ADMIN_PASSWORD is required (Keycloak admin credentials are not stored in the repo).');
  process.exit(2);
}

async function adminToken() {
  const res = await fetch(`${KC_URL}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: KC_ADMIN,
      password: KC_ADMIN_PASSWORD,
    }),
  });
  if (!res.ok) throw new Error(`admin token failed: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

async function api(token, path, { method = 'GET', body } = {}) {
  const res = await fetch(`${KC_URL}/admin/realms/${REALM}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return res;
}

async function main() {
  const token = await adminToken();

  // 1. Partial-export the realm: clients (with mappers + attributes) + groups & roles.
  //    Secrets come back redacted ("**********"); we replace them with throwaway CI values below.
  const exported = await (
    await api(token, `/partial-export?exportClients=true&exportGroupsAndRoles=true`, { method: 'POST' })
  ).json();

  // 2. Sanitize: ensure import-friendly realm flags, strip ids that collide on import.
  exported.realm = REALM;
  exported.enabled = true;
  delete exported.id;

  // 3. Capture each service account's role mappings BEFORE we strip client ids. partial-export does
  //    NOT include service-account role mappings, so without this the imported service accounts get a
  //    token with no roles → 403 on admin calls (e.g. mcm-bff-service reading the agent-gateway secret,
  //    or the login user-lookups). Reconstruct them as `service-account-<clientId>` users on import.
  const serviceAccountUsers = [];
  for (const client of exported.clients ?? []) {
    if (!client.serviceAccountsEnabled) continue;
    const live = await (await api(token, `/clients?clientId=${encodeURIComponent(client.clientId)}`)).json();
    const liveId = live[0]?.id;
    if (!liveId) continue;
    const sa = await (await api(token, `/clients/${liveId}/service-account-user`)).json();
    const rm = await (await api(token, `/users/${sa.id}/role-mappings`)).json();
    const realmRoles = (rm.realmMappings ?? []).map((r) => r.name);
    const clientRoles = {};
    for (const c of Object.values(rm.clientMappings ?? {})) {
      clientRoles[c.client] = (c.mappings ?? []).map((m) => m.name);
    }
    if (realmRoles.length || Object.keys(clientRoles).length) {
      serviceAccountUsers.push({
        username: `service-account-${client.clientId}`,
        enabled: true,
        serviceAccountClientId: client.clientId,
        ...(realmRoles.length ? { realmRoles } : {}),
        ...(Object.keys(clientRoles).length ? { clientRoles } : {}),
      });
    }
  }

  // 4. Replace each confidential client's redacted secret with its throwaway CI value.
  for (const client of exported.clients ?? []) {
    if (client.clientId in THROWAWAY_CLIENT_SECRETS) {
      client.secret = THROWAWAY_CLIENT_SECRETS[client.clientId];
    }
    // Drop runtime-only ids so --import-realm assigns fresh ones.
    delete client.id;
  }

  // 5. Users: the E2E test user (mc-user) + the reconstructed service-account users (their roles).
  //    (partial-export does not include users; the realm is reproducible only with these.)
  exported.users = [
    {
      username: E2E_TEST_USER,
      email: E2E_TEST_USER.includes('@') ? E2E_TEST_USER : `${E2E_TEST_USER}@ci.local`,
      emailVerified: true,
      enabled: true,
      firstName: 'E2E',
      lastName: 'Tester',
      credentials: [{ type: 'password', value: E2E_TEST_PASSWORD, temporary: false }],
      realmRoles: ['mc-user'],
    },
    ...serviceAccountUsers,
  ];

  writeFileSync(OUT_PATH, JSON.stringify(exported, null, 2) + '\n');
  console.log(
    `[export-ci-realm] wrote ${OUT_PATH}\n` +
      `  realm=${REALM} clients=${(exported.clients ?? []).length} ` +
      `roles=${(exported.roles?.realm ?? []).length} user=${E2E_TEST_USER}\n` +
      `  ⚠️ throwaway secrets only. Verify: boot Keycloak with --import-realm against this file,\n` +
      `     run secret-scan.mjs over it, then commit. Align the CI_* secrets with the Forgejo secrets.`,
  );
}

main().catch((e) => {
  console.error('[export-ci-realm] FAILED:', e.message ?? e);
  process.exit(1);
});
