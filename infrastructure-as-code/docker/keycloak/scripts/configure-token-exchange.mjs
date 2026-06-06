#!/usr/bin/env node
/**
 * Configure Keycloak for the AI Agents layer (feature 012, task T012).
 *
 * Idempotently, against a RUNNING Keycloak 26.5 admin API, this:
 *   1. Registers the Agent Gateway as a CONFIDENTIAL client with Standard Token
 *      Exchange enabled (Keycloak 26.2+ GA: client attribute
 *      `standard.token.exchange.enabled=true`) and a service account.
 *   2. Registers an `mc-service`-audience client with a short access-token lifespan
 *      (<=60 s) to bound the exchanged token's TTL.
 *
 * Decision + rationale: specs/012-multi-agent-mvp/research.md (R3) and
 * docs/MCM-Architecture.md §Token Custody & Propagation. Mirrors the raw-fetch
 * Admin REST pattern of add-container-redirect-uris.mjs.
 *
 * Both clients are ADDITIVE — this never modifies the existing
 * `movie-collection-manager` client.
 *
 * ⚠️ NOT YET RUN in this environment: applying needs Keycloak admin credentials
 * (not present in the repo) and the exchanged-token AUDIENCE must be reconciled with
 * what the unchanged mc-service validates — that wiring is completed in T024
 * (gateway re-exchange). Run this once admin creds + the target audience are confirmed.
 *
 * Usage:
 *   KC_URL=http://localhost:8099 KC_ADMIN=admin KC_ADMIN_PASSWORD=*** REALM=jumbleknot \
 *     AGENT_GATEWAY_SECRET=*** node configure-token-exchange.mjs
 */

const KC_URL = process.env.KC_URL ?? 'http://localhost:8099';
const REALM = process.env.REALM ?? 'jumbleknot';
const KC_ADMIN = process.env.KC_ADMIN ?? 'admin';
const KC_ADMIN_PASSWORD = process.env.KC_ADMIN_PASSWORD;
const GATEWAY_CLIENT_ID = process.env.AGENT_GATEWAY_CLIENT_ID ?? 'agent-gateway';
const GATEWAY_SECRET = process.env.AGENT_GATEWAY_SECRET; // if omitted, Keycloak generates one
const AUDIENCE_CLIENT_ID = process.env.MC_SERVICE_AUDIENCE_CLIENT_ID ?? 'mc-service';
const EXCHANGED_TTL_SECONDS = Number(process.env.EXCHANGED_TOKEN_TTL_SECONDS ?? '60');

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
  if (!res.ok && res.status !== 409) {
    throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  }
  return res;
}

async function findClient(token, clientId) {
  const res = await api(token, `/clients?clientId=${encodeURIComponent(clientId)}`);
  const list = await res.json();
  return list[0] ?? null;
}

async function upsertClient(token, rep) {
  const existing = await findClient(token, rep.clientId);
  if (existing) {
    await api(token, `/clients/${existing.id}`, { method: 'PUT', body: { ...existing, ...rep } });
    console.log(`updated client ${rep.clientId}`);
    return existing.id;
  }
  await api(token, `/clients`, { method: 'POST', body: rep });
  const created = await findClient(token, rep.clientId);
  console.log(`created client ${rep.clientId}`);
  return created.id;
}

async function main() {
  const token = await adminToken();

  // 1. Agent Gateway — confidential, service account, Standard Token Exchange enabled.
  await upsertClient(token, {
    clientId: GATEWAY_CLIENT_ID,
    enabled: true,
    publicClient: false,
    serviceAccountsEnabled: true,
    standardFlowEnabled: false,
    directAccessGrantsEnabled: false,
    ...(GATEWAY_SECRET ? { secret: GATEWAY_SECRET } : {}),
    attributes: {
      'standard.token.exchange.enabled': 'true', // Keycloak 26.2+ GA toggle
    },
  });

  // 2. mc-service audience client — short exchanged-token lifespan.
  await upsertClient(token, {
    clientId: AUDIENCE_CLIENT_ID,
    enabled: true,
    publicClient: false,
    standardFlowEnabled: false,
    attributes: {
      'access.token.lifespan': String(EXCHANGED_TTL_SECONDS),
    },
  });

  console.log(
    `done — token exchange ready for ${GATEWAY_CLIENT_ID} -> aud=${AUDIENCE_CLIENT_ID} (TTL ${EXCHANGED_TTL_SECONDS}s).\n` +
      `NOTE (T024): confirm the exchanged-token audience matches what mc-service validates before relying on this.`,
  );
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
