#!/usr/bin/env node
/**
 * Configure Keycloak for the AI Agents layer (feature 012, task T012).
 *
 * Idempotently, against a RUNNING Keycloak 26.5 admin API, this:
 *   1. Registers the Agent Gateway as a CONFIDENTIAL client with Standard Token
 *      Exchange enabled (Keycloak 26.2+ GA: client attribute
 *      `standard.token.exchange.enabled=true`) and a service account — the requester
 *      for the gateway's per-tool-call re-exchange (T024).
 *   2. Registers an `mc-service`-audience client with a short access-token lifespan
 *      (<=60 s) to bound the exchanged token's TTL.
 *   3. Registers a dedicated `agent-subject-token` CONFIDENTIAL client (Standard Token
 *      Exchange enabled, <=180 s lifespan, an `agent_origin=true` hardcoded-claim mapper)
 *      — the requester for the BFF's FIRST exchange that mints the run-scoped subject
 *      token (T023). Kept separate from the gateway client per research R3 least-privilege.
 *      Its secret is PRINTED at the end to wire into the BFF env (frontend/mcm-app/.env.docker).
 *
 * Decision + rationale: specs/012-multi-agent-mvp/research.md (R3) and
 * docs/MCM-Architecture.md §Token Custody & Propagation. Mirrors the raw-fetch
 * Admin REST pattern of add-container-redirect-uris.mjs.
 *
 * All three clients are ADDITIVE — this never modifies the existing
 * `movie-collection-manager` client.
 *
 * ⚠️ NOT YET RUN in this environment: applying needs Keycloak admin credentials
 * (not present in the repo) and the exchanged-token AUDIENCE must be reconciled with
 * what the unchanged mc-service validates — that wiring is completed in T024
 * (gateway re-exchange). Run this once admin creds + the target audience are confirmed.
 *
 * Usage (PowerShell — set creds in your shell, never on disk):
 *   $env:KC_URL='http://localhost:8099'; $env:REALM='jumbleknot'
 *   $env:KC_ADMIN='admin'; $env:KC_ADMIN_PASSWORD='***'
 *   node infrastructure-as-code/docker/keycloak/scripts/configure-token-exchange.mjs
 * Optional: $env:AGENT_GATEWAY_SECRET / $env:AGENT_SUBJECT_TOKEN_SECRET to pin secrets
 * (otherwise Keycloak generates them; the subject-token secret is printed at the end).
 */

const KC_URL = process.env.KC_URL ?? 'http://localhost:8099';
const REALM = process.env.REALM ?? 'jumbleknot';
const KC_ADMIN = process.env.KC_ADMIN ?? 'admin';
const KC_ADMIN_PASSWORD = process.env.KC_ADMIN_PASSWORD;
const GATEWAY_CLIENT_ID = process.env.AGENT_GATEWAY_CLIENT_ID ?? 'agent-gateway';
const GATEWAY_SECRET = process.env.AGENT_GATEWAY_SECRET; // if omitted, Keycloak generates one
const AUDIENCE_CLIENT_ID = process.env.MC_SERVICE_AUDIENCE_CLIENT_ID ?? 'mc-service';
const EXCHANGED_TTL_SECONDS = Number(process.env.EXCHANGED_TOKEN_TTL_SECONDS ?? '60');

// Subject-token requester (feature 012 T023) — the BFF's OWN confidential client for the
// FIRST exchange (user token -> run-scoped subject token), separate from the gateway's
// re-exchange client (research R3 least-privilege). Audience-narrowed to the gateway; the
// subject-token TTL ceiling (<=3 min, research R3) is enforced via access.token.lifespan.
const SUBJECT_TOKEN_CLIENT_ID = process.env.AGENT_SUBJECT_TOKEN_CLIENT_ID ?? 'agent-subject-token';
const SUBJECT_TOKEN_SECRET = process.env.AGENT_SUBJECT_TOKEN_SECRET; // if omitted, Keycloak generates one
const SUBJECT_TOKEN_TTL_SECONDS = Number(process.env.SUBJECT_TOKEN_TTL_SECONDS ?? '180');

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

async function ensureProtocolMapper(token, clientInternalId, mapper) {
  // Idempotent: api() tolerates 409 if the mapper already exists by name.
  await api(token, `/clients/${clientInternalId}/protocol-mappers/models`, {
    method: 'POST',
    body: mapper,
  });
}

async function getClientSecret(token, clientInternalId) {
  const res = await api(token, `/clients/${clientInternalId}/client-secret`);
  return (await res.json()).value;
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

  // 3. Subject-token requester (T023) — confidential, Standard Token Exchange enabled,
  //    short lifespan (run-scoped subject-token TTL ceiling, research R3). The BFF mints the
  //    run-scoped subject token with this client; downscoping to the gateway is via the
  //    `audience` request param (no impersonation).
  const subjectTokenId = await upsertClient(token, {
    clientId: SUBJECT_TOKEN_CLIENT_ID,
    enabled: true,
    publicClient: false,
    serviceAccountsEnabled: false,
    standardFlowEnabled: false,
    directAccessGrantsEnabled: false,
    ...(SUBJECT_TOKEN_SECRET ? { secret: SUBJECT_TOKEN_SECRET } : {}),
    attributes: {
      'standard.token.exchange.enabled': 'true',
      'access.token.lifespan': String(SUBJECT_TOKEN_TTL_SECONDS),
    },
  });

  // Agent-origin marker (research R3): a hardcoded `agent_origin=true` claim so mc-service/OPA
  // can distinguish agent-originated tokens for the HITL-write policy (consumed in T024).
  await ensureProtocolMapper(token, subjectTokenId, {
    name: 'agent-origin-marker',
    protocol: 'openid-connect',
    protocolMapper: 'oidc-hardcoded-claim-mapper',
    config: {
      'claim.name': 'agent_origin',
      'claim.value': 'true',
      'jsonType.label': 'boolean',
      'access.token.claim': 'true',
      'id.token.claim': 'false',
      'userinfo.token.claim': 'false',
    },
  });

  // Gateway audience mapper: makes `agent-gateway` an AVAILABLE downscope target for this
  // requester's exchange. Without it, Keycloak standard token exchange (v2) rejects
  // `audience=agent-gateway` with `invalid_request: "Requested audience not available"`
  // (the `audience` param can only select an audience the requester can produce). This also
  // stamps `aud=agent-gateway` so the gateway's re-exchange (T024, requester=agent-gateway)
  // satisfies the same "requester within audience" rule on the minted subject token.
  await ensureProtocolMapper(token, subjectTokenId, {
    name: 'aud-agent-gateway',
    protocol: 'openid-connect',
    protocolMapper: 'oidc-audience-mapper',
    config: {
      'included.client.audience': GATEWAY_CLIENT_ID,
      'access.token.claim': 'true',
      'id.token.claim': 'false',
    },
  });

  const subjectSecret = await getClientSecret(token, subjectTokenId);

  console.log(
    `done — token exchange ready:\n` +
      `  • gateway re-exchange: ${GATEWAY_CLIENT_ID} -> aud=${AUDIENCE_CLIENT_ID} (TTL ${EXCHANGED_TTL_SECONDS}s)\n` +
      `  • BFF subject-token mint: ${SUBJECT_TOKEN_CLIENT_ID} -> aud=${GATEWAY_CLIENT_ID} (TTL ${SUBJECT_TOKEN_TTL_SECONDS}s, agent_origin=true)\n` +
      `\nWire the BFF (frontend/mcm-app/.env.docker, gitignored):\n` +
      `  AGENT_SUBJECT_TOKEN_CLIENT_ID=${SUBJECT_TOKEN_CLIENT_ID}\n` +
      `  AGENT_SUBJECT_TOKEN_CLIENT_SECRET=${subjectSecret}\n` +
      `  AGENT_SUBJECT_TOKEN_AUDIENCE=${GATEWAY_CLIENT_ID}\n` +
      `\n⚠️  PRODUCTION (NOT applied by this script — touches the existing login client, needs sign-off):\n` +
      `  Keycloak standard token exchange (v2) requires the REQUESTER to be within the subject\n` +
      `  token's audience. The real user token is issued by 'movie-collection-manager', so it must\n` +
      `  carry '${SUBJECT_TOKEN_CLIENT_ID}' in its 'aud' or the BFF's first exchange fails with\n` +
      `  access_denied "Client is not within the token audience". Add an oidc-audience-mapper for\n` +
      `  '${SUBJECT_TOKEN_CLIENT_ID}' to 'movie-collection-manager' (or a shared client scope) — an\n` +
      `  ADDITIVE extra audience (backward-compatible: the BFF accepts aud⊇appClient OR azp===appClient,\n` +
      `  and mc-service validates its own audience). Deferred here because it modifies the existing\n` +
      `  login client (SC-005 additivity). The integration test applies the equivalent mapper to the\n` +
      `  'mcm-bff-test' client only.\n` +
      `\nNOTE (T024): confirm the exchanged-token audience matches what mc-service validates before relying on this.`,
  );
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
