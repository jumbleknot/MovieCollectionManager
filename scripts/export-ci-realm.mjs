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
 * Feature 027 (US5): NO secret value is committed. Every client secret and the E2E user password is
 * written as a `${ENV_VAR}` placeholder that Keycloak resolves from the keycloak-service container env
 * at `--import-realm` (default-on since KC 26.0.0). The env-var names are the CANONICAL ones the BFF
 * uses, so realm-secret == BFF-secret == same Forgejo secret by construction (no manual "must match"):
 *   movie-collection-manager.secret  ->  ${KEYCLOAK_CLIENT_SECRET}          (secrets.KEYCLOAK_CLIENT_SECRET)
 *   mcm-bff-service.secret           ->  ${KEYCLOAK_SERVICE_CLIENT_SECRET}  (secrets.KEYCLOAK_SERVICE_CLIENT_SECRET)
 *   agent-subject-token.secret       ->  ${AGENT_SUBJECT_TOKEN_CLIENT_SECRET}
 *   agent-gateway/mc-service/mcm-bff-test -> throwaway per-run vars minted at the up step (arbitrary
 *     in app-e2e: agent-gateway is fetched from KC at runtime, mc-service is bearer-only, ROPC unused).
 *   E2E user password                ->  ${E2E_TEST_PASSWORD}
 * The container env is wired in compose.ci.yaml (fail-fast ${VAR:?}) + app-ci.yml.
 *
 * GREEN gate: after committing, boot Keycloak with `--import-realm` against this file (with those env
 * vars set) and confirm it imports cleanly + the web E2E login + the 4 agent flows pass on the runner.
 *
 * SECURITY: the committed file holds ONLY `${VAR}` placeholders — no throwaway or prod secret value.
 * secret-scan.mjs runs over it and must stay green.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const KC_URL = process.env.KC_URL ?? 'http://localhost:8099';
const REALM = process.env.REALM ?? 'grumpyrobot';
const KC_ADMIN = process.env.KC_ADMIN ?? 'admin';
const KC_ADMIN_PASSWORD = process.env.KC_ADMIN_PASSWORD;

const E2E_TEST_USER = process.env.E2E_TEST_USER ?? 'e2e-test-user';

// Feature 027 (US5): NO credential value is baked into the committed realm. Every client secret and
// the E2E user password is written as a Keycloak `${ENV_VAR}` placeholder that Keycloak 26.5.5
// resolves from the keycloak-service container env at `--import-realm` (placeholder replacement is
// default-on since KC 26.0.0; unresolved `${...}` — e.g. the realm's own `${client_*}` i18n keys —
// are left intact). The env-var NAMES are the CANONICAL ones the BFF/.env.docker already use, so the
// realm secret and the BFF secret resolve from the SAME Forgejo secret by construction — no manual
// "must match" coupling. See compose.ci.yaml (container env) + app-ci.yml (values).
const CLIENT_SECRET_PLACEHOLDERS = {
  'movie-collection-manager': '${KEYCLOAK_CLIENT_SECRET}',
  'mcm-bff-service': '${KEYCLOAK_SERVICE_CLIENT_SECRET}',
  'agent-subject-token': '${AGENT_SUBJECT_TOKEN_CLIENT_SECRET}',
  // Arbitrary-in-CI clients (agent-gateway secret is fetched from KC at runtime by agent-stack.mjs;
  // mc-service is bearer-only; mcm-bff-test/ROPC is unused by app-e2e) — throwaway per-run values.
  'agent-gateway': '${AGENT_GATEWAY_CLIENT_SECRET}',
  'mc-service': '${MC_SERVICE_CLIENT_SECRET}',
  'mcm-bff-test': '${E2E_ROPC_CLIENT_SECRET}',
};
const E2E_PASSWORD_PLACEHOLDER = '${E2E_TEST_PASSWORD}';

const OUT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../infrastructure-as-code/docker/keycloak/ci-realm.json',
);

if (!KC_ADMIN_PASSWORD) {
  console.error('KC_ADMIN_PASSWORD is required (Keycloak admin credentials are not stored in the repo).');
  process.exit(2);
}
// NB: E2E_TEST_PASSWORD / the client secrets are NOT needed here anymore — the realm is written with
// `${ENV_VAR}` placeholders (resolved at import), so this generator no longer handles any secret value.

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

  // Drop the realm passwordPolicy from the throwaway CI realm. Keycloak 26.6+ ENFORCES the realm
  // passwordPolicy against imported user credentials (26.5 silently skipped this), so a fresh
  // --import-realm aborts ("invalidPasswordMinSpecialCharsMessage") because the seeded e2e-test-user
  // password is a plaintext ${E2E_TEST_PASSWORD} (a Forgejo secret that need not satisfy the prod
  // policy). Password STRENGTH is validated client-side in the E2E suite (src/utils/validators.ts),
  // not via Keycloak, so the CI realm gains nothing from the server-side policy. prod-realm.json keeps
  // its policy (real users need it) and seeds NO user credential, so prod's import is unaffected.
  delete exported.passwordPolicy;

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

  // 4. Replace each confidential client's redacted secret with its ${ENV_VAR} placeholder (resolved at
  //    import). Any confidential client NOT in the map keeps the partial-export's masked "**********",
  //    which would be a broken secret — assert every one is mapped so a new client can't slip through.
  for (const client of exported.clients ?? []) {
    if (client.clientId in CLIENT_SECRET_PLACEHOLDERS) {
      client.secret = CLIENT_SECRET_PLACEHOLDERS[client.clientId];
    } else if (client.secret) {
      throw new Error(
        `client "${client.clientId}" has a secret but no CLIENT_SECRET_PLACEHOLDERS entry — add one ` +
          `(and wire the env var into compose.ci.yaml + app-ci.yml) so no plaintext/masked secret is committed.`,
      );
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
      credentials: [{ type: 'password', value: E2E_PASSWORD_PLACEHOLDER, temporary: false }],
      // mc-user is a CLIENT role of movie-collection-manager — the BFF reads roles from
      // resource_access[clientId].roles (token-service.ts), NOT realm_access. A realm-role assignment
      // is a no-op (the user authenticates but gets roles:[] → login_role_denied).
      clientRoles: { 'movie-collection-manager': ['mc-user'] },
    },
    ...serviceAccountUsers,
  ];

  writeFileSync(OUT_PATH, JSON.stringify(exported, null, 2) + '\n');
  console.log(
    `[export-ci-realm] wrote ${OUT_PATH}\n` +
      `  realm=${REALM} clients=${(exported.clients ?? []).length} ` +
      `roles=${(exported.roles?.realm ?? []).length} user=${E2E_TEST_USER}\n` +
      `  ✅ secrets written as \${ENV_VAR} placeholders (no secret value committed). Verify: boot\n` +
      `     Keycloak --import-realm with those env vars set, run secret-scan.mjs, then commit.`,
  );
}

main().catch((e) => {
  console.error('[export-ci-realm] FAILED:', e.message ?? e);
  process.exit(1);
});
