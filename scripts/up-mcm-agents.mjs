#!/usr/bin/env node
/**
 * up-mcm-agents.mjs — bring up the AI agent layer UNDER the mcm compose stack (the HEAVY variant:
 * compose project `mcm` + the `movie-assistant-store-postgres` checkpointer), in one step.
 *
 * Distinct from scripts/agent-stack.mjs (the LIGHT E2E variant: `docker run`, in-memory MemorySaver,
 * no postgres). This is the path for general local use of the assistant under the named stack.
 *
 * It fetches the agent-gateway Keycloak client secret (there is no committed source) and injects it
 * so token-exchange tool calls work — without it the gateway runs but add/query/organize fail-closed.
 *
 * Prereqs: the `auth` stack (Keycloak) + the `mcm` `app` profile up; host Ollama serving qwen2.5 /
 * qwen2.5:32b (the compose gateway is ollama-only — see infrastructure-as-code/docker/agent-gateway/compose.yaml).
 *
 * Usage:  node scripts/up-mcm-agents.mjs   (or: pnpm nx up-mcm-agents infrastructure-as-code)
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MCM_STACK = 'infrastructure-as-code/docker/stacks/mcm.compose.yaml';
const KEYCLOAK_ADMIN_URL = process.env.KEYCLOAK_PUBLIC_URL || 'http://localhost:8099';

const log = (m) => console.log(`[up-mcm-agents] ${m}`);
const die = (m) => { console.error(`[up-mcm-agents] ERROR: ${m}`); process.exit(1); };

// 1) Fetch the agent-gateway client secret from Keycloak (same path as agent-stack.mjs).
log('fetching agent-gateway client secret from Keycloak ...');
let secret;
try {
  secret = execFileSync('uv', [
    'run', 'python', '-c',
    "import sys;sys.path.insert(0,'tests/integration');import kc_admin;print(kc_admin.gateway_secret(kc_admin.admin_token()))",
  ], {
    cwd: resolve(REPO_ROOT, 'agents/movie-assistant'),
    env: { ...process.env, KEYCLOAK_URL: KEYCLOAK_ADMIN_URL },
    encoding: 'utf8',
  }).trim();
} catch (e) {
  die(`secret fetch failed — is the auth stack (Keycloak) up at ${KEYCLOAK_ADMIN_URL} and the agent-gateway client registered? (${e.message})`);
}
if (!secret || secret === 'None') {
  die('gateway secret lookup returned empty (run the token-exchange setup script for the agent-gateway client).');
}
log(`secret resolved (len ${secret.length}).`);

// 2) Bring up the agent layer under the mcm stack, secret injected.
log('bringing up the mcm `agents` profile (gateway + 3 MCP + movie-assistant-store-postgres) ...');
const r = spawnSync('docker', [
  'compose', '-p', 'mcm', '-f', MCM_STACK, '--profile', 'agents', 'up', '-d',
], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
  env: { ...process.env, AGENT_GATEWAY_CLIENT_SECRET: secret },
});
if (r.status !== 0) die('docker compose up --profile agents failed.');

log('✅ agents up under project `mcm`. The BFF reaches the gateway at movie-assistant-gateway:8000.');
log('   (gateway graph build takes ~20–40s before /health is ok.)');
