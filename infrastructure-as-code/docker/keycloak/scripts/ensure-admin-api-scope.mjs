#!/usr/bin/env node
/**
 * Gives the BFF's service account the `kc-admin-api` scope on a running realm (feature 090).
 *
 * Keycloak 26.8.2 refuses Admin API tokens without this scope. Its migration creates the scope but does
 * not give it to our clients, so an existing realm must have this run BEFORE Keycloak moves to 26.8.2.
 * It also works on 26.8.2, and the migration leaves a scope made here alone (both measured, see
 * specs/090-keycloak-admin-api-scope/plan.md). A fresh realm gets it from the realm file instead.
 *
 * Changes nothing without --apply. Safe to run again.
 *
 *   KC_URL=http://<admin host> KC_ADMIN_PASSWORD=... node ensure-admin-api-scope.mjs
 *   KC_URL=http://<admin host> KC_ADMIN_PASSWORD=... node ensure-admin-api-scope.mjs --apply
 *
 * Optional: REALM (default grumpyrobot), KC_ADMIN (default admin).
 */
import { pathToFileURL } from 'node:url';

import { ArgvError, dieOnArgvError, partitionArgs, wantsHelp } from '../../../../scripts/lib/argv-contract.mjs';

const USAGE = 'Usage: node ensure-admin-api-scope.mjs [--apply]\n  Without --apply, reports what is missing and changes nothing.\n  Needs KC_ADMIN_PASSWORD; optional KC_URL, REALM, KC_ADMIN.';
const SCOPE_NAME = 'kc-admin-api';
const CLIENT_ID = 'mcm-bff-service';

/** The definition Keycloak 26.8.2 generates, so this and its migration produce the same scope. */
const SCOPE = {
  name: SCOPE_NAME,
  description: 'Grants access to the Keycloak Admin REST API by adding its required audience to the token',
  protocol: 'openid-connect',
  attributes: { 'include.in.token.scope': 'true', 'display.on.consent.screen': 'false' },
  protocolMappers: [
    {
      name: 'admin-api-audience',
      protocol: 'openid-connect',
      protocolMapper: 'oidc-admin-api-audience-mapper',
      consentRequired: false,
      config: {
        'lightweight.claim': 'true',
        'introspection.token.claim': 'true',
        'access.token.claim': 'true',
      },
    },
  ],
};

/** What still has to happen, given the realm's state. */
export function planSteps({ scopeExists, assigned }) {
  return [...(scopeExists ? [] : ['create-scope']), ...(assigned ? [] : ['assign-scope'])];
}

async function adminToken(kcUrl, username, password) {
  const res = await fetch(`${kcUrl}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username, password }),
  });
  if (!res.ok) throw new Error(`admin sign-in failed: ${res.status}`);
  return (await res.json()).access_token;
}

async function main(argv) {
  if (wantsHelp(argv)) {
    console.log(USAGE);
    return 0;
  }
  const { flags } = partitionArgs(argv, { accepted: ['--apply'], usage: USAGE });
  const apply = flags.has('--apply');

  const password = process.env.KC_ADMIN_PASSWORD;
  if (!password) throw new ArgvError(`KC_ADMIN_PASSWORD is required.\n${USAGE}`);
  const kcUrl = process.env.KC_URL ?? 'http://localhost:8099';
  const realmBase = `${kcUrl}/admin/realms/${process.env.REALM ?? 'grumpyrobot'}`;

  const token = await adminToken(kcUrl, process.env.KC_ADMIN ?? 'admin', password);
  const call = async (path, options = {}) => {
    const res = await fetch(`${realmBase}${path}`, {
      ...options,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    });
    if (!res.ok) throw new Error(`${options.method ?? 'GET'} ${path} -> ${res.status}`);
    return res;
  };

  const findScope = async () => (await (await call('/client-scopes')).json()).find((s) => s.name === SCOPE_NAME);
  const [client] = await (await call(`/clients?clientId=${CLIENT_ID}`)).json();
  if (!client) throw new Error(`client ${CLIENT_ID} not found in this realm`);
  const isAssigned = async () =>
    (await (await call(`/clients/${client.id}/default-client-scopes`)).json()).some((s) => s.name === SCOPE_NAME);

  const steps = planSteps({ scopeExists: Boolean(await findScope()), assigned: await isAssigned() });
  console.log(`realm: ${realmBase}`);
  console.log(`to do: ${steps.length ? steps.join(', ') : 'nothing, already in place'}`);
  if (!steps.length) return 0;
  if (!apply) {
    console.log('dry run: nothing changed. Run again with --apply.');
    return 0;
  }

  if (steps.includes('create-scope')) await call('/client-scopes', { method: 'POST', body: JSON.stringify(SCOPE) });
  const scope = await findScope();
  await call(`/clients/${client.id}/default-client-scopes/${scope.id}`, { method: 'PUT' });

  if (!(await isAssigned())) throw new Error('the assignment did not take effect');
  console.log(`done: ${CLIENT_ID} carries ${SCOPE_NAME} as a default scope.`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      if (err instanceof ArgvError) dieOnArgvError(err);
      console.error(`FAILED: ${err.message}`);
      process.exit(1);
    },
  );
}
