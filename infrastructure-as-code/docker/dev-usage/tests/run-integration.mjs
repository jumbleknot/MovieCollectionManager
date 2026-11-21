#!/usr/bin/env node
// Feature 105 — the store integration tier: `pnpm nx dev-usage-integration infrastructure-as-code`.
//
// Brings up ../compose.yaml as project `dev-usage-it` (real Postgres + PostgREST + a throwaway
// Keycloak importing ci-realm.json), runs store-contract.test.mjs against it, and removes every
// container and volume afterwards, pass or fail. Every secret is minted here, per run.
//
// MCM_REQUIRE_LIVE_STACK=1 turns "Docker is not available" into a FAILURE instead of a skip
// (AGENTS.md: a skipped test exits 0 and reads as a pass).
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const STACK = resolve(HERE, '..');
const REPO = resolve(STACK, '..', '..', '..');
const COMPOSE = join(STACK, 'compose.yaml');
const PROJECT = process.env.DEV_USAGE_IT_PROJECT || 'dev-usage-it';
const SEED_IMAGE = 'postgres:18.6-alpine3.23@sha256:f1031bf693d8d60b0a0380c51a3510607c7a93c7c1d18bf7af94a3a8dbeb40b8';
const requireLive = process.env.MCM_REQUIRE_LIVE_STACK === '1';

const mint = () => randomBytes(18).toString('hex');
const secrets = {
  DEV_USAGE_IT_KC_ADMIN_PASSWORD: mint(),
  DEV_USAGE_IT_OTHER_CLIENT_SECRET: mint(),
  DEV_USAGE_PG_PASSWORD: mint(),
  DEV_USAGE_AUTHENTICATOR_PASSWORD: mint(),
  DEV_USAGE_READER_PASSWORD: mint(),
};
const env = { ...process.env, ...secrets };

function sh(cmd, args, { quiet = false, allowFail = false } = {}) {
  const r = spawnSync(cmd, args, { env, encoding: 'utf8', stdio: quiet ? 'pipe' : ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0 && !allowFail) throw new Error(`${cmd} ${args.slice(0, 4).join(' ')} … exited ${r.status}${quiet ? `\n${r.stderr}` : ''}`);
  return r;
}
const compose = (args, opts) => sh('docker', ['compose', '-p', PROJECT, '-f', COMPOSE, ...args], opts);

function runTests(extraEnv) {
  const r = spawnSync(process.execPath, ['--test', join(HERE, 'store-contract.test.mjs')], {
    env: { ...env, ...extraEnv }, stdio: 'inherit', cwd: REPO,
  });
  return r.status ?? 1;
}

/** The generated secret of a client, read through the Admin API (the realm file commits none). */
async function clientSecret(kcUrl, clientId) {
  const tok = await fetch(`${kcUrl}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: 'admin', password: secrets.DEV_USAGE_IT_KC_ADMIN_PASSWORD }),
  }).then((r) => r.json());
  const auth = { authorization: `Bearer ${tok.access_token}` };
  const [client] = await fetch(`${kcUrl}/admin/realms/grumpyrobot/clients?clientId=${clientId}`, { headers: auth }).then((r) => r.json());
  if (!client) throw new Error(`client ${clientId} is not in the imported realm`);
  const { value } = await fetch(`${kcUrl}/admin/realms/grumpyrobot/clients/${client.id}/client-secret`, { headers: auth }).then((r) => r.json());
  return value;
}

function hostPort(service, port) {
  const out = compose(['port', service, String(port)], { quiet: true }).stdout.trim();
  return `http://127.0.0.1:${out.split(':').pop()}`;
}

async function main() {
  if (sh('docker', ['info'], { quiet: true, allowFail: true }).status !== 0) {
    if (requireLive) {
      console.error('dev-usage-integration: Docker is not reachable and MCM_REQUIRE_LIVE_STACK=1 — failing, not skipping.');
      return 1;
    }
    console.error('dev-usage-integration: Docker is not reachable — the store tests will SKIP (set MCM_REQUIRE_LIVE_STACK=1 to fail instead).');
    return runTests({});
  }
  compose(['down', '-v', '--remove-orphans'], { quiet: true, allowFail: true });
  let code = 1;
  try {
    compose(['create', '--quiet-pull']);
    const seed = `${PROJECT}-seed`;
    sh('docker', ['rm', '-f', seed], { quiet: true, allowFail: true });
    sh('docker', ['create', '--name', seed, '-v', `${PROJECT}_realm:/realm`, '-v', `${PROJECT}_schema:/schema`, SEED_IMAGE, 'true'], { quiet: true });
    try {
      sh('docker', ['cp', join(REPO, 'infrastructure-as-code/docker/keycloak/ci-realm.json'), `${seed}:/realm/grumpyrobot-realm.json`], { quiet: true });
      sh('docker', ['cp', `${join(STACK, 'schema')}/.`, `${seed}:/schema/`], { quiet: true });
    } finally {
      sh('docker', ['rm', '-f', seed], { quiet: true, allowFail: true });
    }
    compose(['up', '-d', '--wait', '--wait-timeout', '300']);
    const kcUrl = hostPort('dev-usage-keycloak', 8080);
    code = runTests({
      DEV_USAGE_IT_INGEST_URL: hostPort('dev-usage-postgrest', 3000),
      DEV_USAGE_IT_KC_URL: kcUrl,
      DEV_USAGE_IT_TOKEN_URL: `${kcUrl}/realms/grumpyrobot/protocol/openid-connect/token`,
      DEV_USAGE_IT_CLIENT_SECRET: await clientSecret(kcUrl, 'dev-usage-capture'),
      DEV_USAGE_IT_COMPOSE: JSON.stringify(['compose', '-p', PROJECT, '-f', COMPOSE]),
    });
  } catch (e) {
    console.error(`dev-usage-integration: ${e.message}`);
    compose(['logs', '--tail', '40'], { allowFail: true });
    code = 1;
  } finally {
    if (code !== 0) compose(['ps', '-a'], { allowFail: true });
    compose(['down', '-v', '--remove-orphans'], { quiet: true, allowFail: true });
  }
  return code;
}

process.exitCode = await main();
