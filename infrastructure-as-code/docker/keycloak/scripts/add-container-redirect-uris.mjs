#!/usr/bin/env node
/**
 * Feature 007 — make the BFF-container E2E redirect URIs reproducible & version-controlled.
 *
 * The `grumpyrobot` realm is runtime-managed (persisted in the keycloak-store-postgres volume; there is no
 * committed realm-import file), so the Keycloak `movie-collection-manager` client's allowed
 * redirect URIs / web origins are not otherwise captured in the repo. This idempotent script
 * IS that source of truth: it ensures the Dockerized-BFF origins are allowed so E2E can run
 * against the container (dev http://localhost:8082, prod https://localhost:8443) instead of
 * the Metro dev server (http://localhost:8081).
 *
 * Run it after the realm is provisioned (and again any time the client is re-created):
 *   node infrastructure-as-code/docker/keycloak/scripts/add-container-redirect-uris.mjs
 *
 * Auth uses the BFF service account (client-credentials). The secret is read from
 * KEYCLOAK_SERVICE_CLIENT_SECRET (env) or frontend/mcm-app/.env.docker — never committed.
 * Idempotent: re-running adds nothing if the entries already exist.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const KC = process.env['KEYCLOAK_PUBLIC_URL'] ?? process.env['KEYCLOAK_URL'] ?? 'http://localhost:8099';
const REALM = process.env['KEYCLOAK_REALM'] ?? 'grumpyrobot';
const CLIENT_ID = process.env['KEYCLOAK_CLIENT_ID'] ?? 'movie-collection-manager';
const SVC_ID = process.env['KEYCLOAK_SERVICE_CLIENT_ID'] ?? 'mcm-bff-service';

// Dev container serves client + BFF on :8082 (HTTP); prod behind Caddy TLS on :8443 (HTTPS).
const ADD_REDIRECT = [
  'http://localhost:8082/auth-callback',
  'http://localhost:8082/login?verified=true',
  'https://localhost:8443/auth-callback',
  'https://localhost:8443/login?verified=true',
];
const ADD_ORIGINS = ['http://localhost:8082', 'https://localhost:8443'];

function svcSecret() {
  if (process.env['KEYCLOAK_SERVICE_CLIENT_SECRET']) return process.env['KEYCLOAK_SERVICE_CLIENT_SECRET'];
  const here = dirname(fileURLToPath(import.meta.url));
  const envPath = resolve(here, '../../../../frontend/mcm-app/.env.docker');
  const line = readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.startsWith('KEYCLOAK_SERVICE_CLIENT_SECRET='));
  if (!line) throw new Error('KEYCLOAK_SERVICE_CLIENT_SECRET not set and not found in .env.docker');
  return line.split('=').slice(1).join('=').trim();
}

async function main() {
  const secret = svcSecret();
  const tokRes = await fetch(`${KC}/realms/${REALM}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: SVC_ID, client_secret: secret, grant_type: 'client_credentials' }),
  });
  if (!tokRes.ok) throw new Error(`token request failed: ${tokRes.status} ${await tokRes.text()}`);
  const auth = { Authorization: `Bearer ${(await tokRes.json()).access_token}` };

  const [client] = await (
    await fetch(`${KC}/admin/realms/${REALM}/clients?clientId=${encodeURIComponent(CLIENT_ID)}`, { headers: auth })
  ).json();
  if (!client) throw new Error(`client ${CLIENT_ID} not found in realm ${REALM}`);

  const before = (client.redirectUris ?? []).length;
  client.redirectUris = [...new Set([...(client.redirectUris ?? []), ...ADD_REDIRECT])];
  client.webOrigins = [...new Set([...(client.webOrigins ?? []), ...ADD_ORIGINS])];

  const putRes = await fetch(`${KC}/admin/realms/${REALM}/clients/${client.id}`, {
    method: 'PUT',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(client),
  });
  if (!putRes.ok) throw new Error(`client update failed: ${putRes.status} ${await putRes.text()}`);

  console.log(
    `[realm-setup] ${CLIENT_ID}: redirectUris ${before} -> ${client.redirectUris.length}; ` +
      `webOrigins -> ${client.webOrigins.length}. Container origins (8082/8443) ensured.`,
  );
}

main().catch((e) => {
  console.error('[realm-setup] FAILED:', e.message);
  process.exit(1);
});
