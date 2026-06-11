#!/usr/bin/env node
/**
 * agent-stack.mjs — deploy/teardown the CONTAINERIZED production-node Agent stack for local E2E.
 *
 * Stands up the full feature-012 agent layer as containers so the agent E2E (assistant-*.spec.ts,
 * E2E_AGENT_PRODUCTION=1) runs against the dev-container BFF with NO Metro and NO host gateway:
 *
 *   dev BFF (mcm-bff-dev :8082) ──backend──► agent-gateway (production nodes)
 *                                              ├─backend──► movie-mcp ──► mc-service
 *                                              └─agent-mcp─► web-api-mcp ──► TMDB (egress only)
 *
 * This is the LIGHT local-loop variant (host Ollama + in-memory checkpointer — no ~19 GB ollama
 * container, no agent-db Postgres). The committed `--profile agents` compose is the HEAVY variant
 * (container Ollama + agent-db); both share the same image + the gateway production env + the
 * `agent-mcp` network wiring (this script just substitutes host Ollama + MemorySaver + docker run
 * so it boots without the model pull). The Agent Gateway is private-network only — no host port.
 *
 * Three real gaps this codifies (all fixed in-repo; see specs/012-multi-agent-mvp/quickstart.md
 * "Containerized production-agent stack"):
 *   1. The gateway needs BOTH WEB_API_MCP_URL + MOVIE_MCP_URL or `production_nodes_enabled` is
 *      false and it silently serves the tool-free graph.
 *   2. web-api-mcp is off backend-network (egress-only) → reachable only via the isolated
 *      `agent-mcp` network the gateway also joins.
 *   3. The gateway's confidential client secret (RFC 8693 token exchange) is fetched live from
 *      Keycloak admin (kc_admin) — never committed — and injected as an env var here.
 *
 * Usage:
 *   node scripts/agent-stack.mjs            # build (if missing) + deploy
 *   node scripts/agent-stack.mjs --build    # force-rebuild the 3 images, then deploy
 *   node scripts/agent-stack.mjs --down     # remove the 3 agent containers
 *   node scripts/agent-stack.mjs --status   # show stack status + production-node check
 *   MODEL_PROVIDER=anthropic node scripts/agent-stack.mjs   # deploy against Claude (haiku/sonnet)
 *
 * Prerequisites: the shared stack up (mc-service + Keycloak + Redis + Mongo — `docker compose
 * --profile app --profile keycloak up -d`), host Ollama serving qwen2.5 + qwen2.5:32b, a
 * TMDB_API_KEY in mcp-servers/web-api-mcp/.env.local, and `uv` for the secret fetch.
 *
 * Env overrides: SUPERVISOR_MODEL (default qwen2.5), SPECIALIST_MODEL (default qwen2.5:32b),
 * KEYCLOAK_PUBLIC_URL (admin lookup, default http://localhost:8099).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GATEWAY = 'agent-gateway';
const CONTAINERS = ['agent-gateway', 'movie-mcp', 'web-api-mcp'];
const IMAGES = [
  { tag: 'movie-mcp:latest', dockerfile: 'mcp-servers/movie-mcp/Dockerfile' },
  { tag: 'web-api-mcp:latest', dockerfile: 'mcp-servers/web-api-mcp/Dockerfile' },
  { tag: 'agent-gateway:latest', dockerfile: 'agents/movie-assistant/Dockerfile' },
];
const KEYCLOAK_ADMIN_URL = process.env.KEYCLOAK_PUBLIC_URL || 'http://localhost:8099';
const SUPERVISOR_MODEL = process.env.SUPERVISOR_MODEL || 'qwen2.5';
const SPECIALIST_MODEL = process.env.SPECIALIST_MODEL || 'qwen2.5:32b';
// MODEL_PROVIDER=anthropic deploys the gateway against Claude (haiku-4-5 supervisor / sonnet-4-6
// specialist defaults — models.py `_FAST/_BALANCED_DEFAULTS`); default `ollama` uses host Ollama.
// For anthropic we deliberately do NOT pass SUPERVISOR_MODEL/SPECIALIST_MODEL (the Ollama IDs would
// be sent to Anthropic → 404) — set ANTHROPIC_SUPERVISOR_MODEL / ANTHROPIC_SPECIALIST_MODEL to pin
// specific Claude models.
const MODEL_PROVIDER = (process.env.MODEL_PROVIDER || 'ollama').toLowerCase();

const log = (m) => console.log(`[agent-stack] ${m}`);
const die = (m) => {
  console.error(`[agent-stack] ERROR: ${m}`);
  process.exit(1);
};

/** Run a command, inheriting stdio; throw on non-zero. */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: REPO_ROOT, stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}`);
}
/** Run a command, capturing stdout (trimmed); throw on non-zero. */
function capture(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: REPO_ROOT, encoding: 'utf8', ...opts }).trim();
}
/** Run a command, returning success boolean (no throw). */
function tryRun(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: REPO_ROOT, stdio: 'ignore', ...opts }).status === 0;
}

function removeContainers() {
  for (const c of CONTAINERS) tryRun('docker', ['rm', '-f', c]);
}

function ensureNetwork(name) {
  if (!tryRun('docker', ['network', 'inspect', name])) {
    log(`creating network ${name}`);
    run('docker', ['network', 'create', name]);
  }
}

function imageExists(tag) {
  return capture('docker', ['images', '-q', tag]) !== '';
}

function buildImages(force) {
  for (const { tag, dockerfile } of IMAGES) {
    if (!force && imageExists(tag)) {
      log(`image ${tag} present (skip; use --build to force)`);
      continue;
    }
    log(`building ${tag} ...`);
    run('docker', ['build', '-t', tag, '-f', dockerfile, '.']);
  }
}

function checkHostOllama() {
  // The gateway reaches host Ollama via host.docker.internal; verify the host side is serving.
  const r = spawnSync(
    'docker',
    ['run', '--rm', 'curlimages/curl:latest', '-s', '-m', '5', 'http://host.docker.internal:11434/api/tags'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  // host.docker.internal isn't resolvable in a default `docker run`; fall back to host loopback.
  const tags = r.stdout || '';
  if (!tags.includes('qwen2.5')) {
    log('WARN: could not confirm host Ollama has qwen2.5 (continuing — verify it is serving on :11434)');
  } else {
    log('host Ollama reachable (qwen2.5 present)');
  }
}

/** Resolve ANTHROPIC_API_KEY from the host env or agents/movie-assistant/.env.local (never logged). */
function anthropicKey() {
  if ((process.env.ANTHROPIC_API_KEY || '').trim()) return process.env.ANTHROPIC_API_KEY.trim();
  const envFile = resolve(REPO_ROOT, 'agents/movie-assistant/.env.local');
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = /^ANTHROPIC_API_KEY=(.+)$/.exec(line.trim());
      if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    }
  }
  die('MODEL_PROVIDER=anthropic but no ANTHROPIC_API_KEY (set it in the env or agents/movie-assistant/.env.local)');
}

function fetchGatewaySecret() {
  log('fetching agent-gateway client secret from Keycloak admin (kc_admin) ...');
  const secret = capture(
    'uv',
    [
      'run',
      'python',
      '-c',
      "import sys;sys.path.insert(0,'tests/integration');import kc_admin;print(kc_admin.gateway_secret(kc_admin.admin_token()))",
    ],
    { cwd: resolve(REPO_ROOT, 'agents/movie-assistant'), env: { ...process.env, KEYCLOAK_URL: KEYCLOAK_ADMIN_URL } },
  );
  if (!secret || secret === 'None') {
    die('gateway secret lookup returned empty (is Keycloak up + the agent-gateway client registered? run the T012 token-exchange script)');
  }
  return secret;
}

function deploy(force) {
  ensureNetwork('backend-network');
  ensureNetwork('agent-mcp');
  buildImages(force);
  if (MODEL_PROVIDER === 'ollama') checkHostOllama();
  const secret = fetchGatewaySecret();
  removeContainers();

  log('starting movie-mcp (backend-network → mc-service) ...');
  run('docker', [
    'run', '-d', '--name', 'movie-mcp', '--network', 'backend-network',
    '-e', 'MC_SERVICE_URL=http://mc-service:3001', 'movie-mcp:latest',
  ]);

  log('starting web-api-mcp (agent-mcp network → TMDB egress only) ...');
  run('docker', [
    'run', '-d', '--name', 'web-api-mcp', '--network', 'agent-mcp',
    '--env-file', 'mcp-servers/web-api-mcp/.env.local', 'web-api-mcp:latest',
  ]);

  // Common gateway env (provider-agnostic): production nodes + token exchange + Keycloak.
  const gatewayEnv = [
    '-e', `MODEL_PROVIDER=${MODEL_PROVIDER}`,
    '-e', 'KEYCLOAK_URL=http://keycloak-service:8080',
    '-e', 'KEYCLOAK_REALM=jumbleknot',
    '-e', 'MOVIE_MCP_URL=http://movie-mcp:8000/mcp',
    '-e', 'WEB_API_MCP_URL=http://web-api-mcp:8000/mcp',
    '-e', 'AGENT_GATEWAY_CLIENT_ID=agent-gateway',
    '-e', `AGENT_GATEWAY_CLIENT_SECRET=${secret}`,
  ];
  if (MODEL_PROVIDER === 'anthropic') {
    // Claude (haiku-4-5 supervisor / sonnet-4-6 specialist defaults). Do NOT pass the Ollama model
    // IDs (they'd be sent to Anthropic → 404); pin via ANTHROPIC_SUPERVISOR/SPECIALIST_MODEL.
    log('starting agent-gateway (production nodes; provider=ANTHROPIC / Claude) ...');
    gatewayEnv.push('-e', `ANTHROPIC_API_KEY=${anthropicKey()}`);
    if ((process.env.ANTHROPIC_SUPERVISOR_MODEL || '').trim())
      gatewayEnv.push('-e', `SUPERVISOR_MODEL=${process.env.ANTHROPIC_SUPERVISOR_MODEL.trim()}`);
    if ((process.env.ANTHROPIC_SPECIALIST_MODEL || '').trim())
      gatewayEnv.push('-e', `SPECIALIST_MODEL=${process.env.ANTHROPIC_SPECIALIST_MODEL.trim()}`);
  } else {
    log('starting agent-gateway (production nodes; provider=OLLAMA / host models; MemorySaver) ...');
    gatewayEnv.push(
      '-e', 'OLLAMA_BASE_URL=http://host.docker.internal:11434',
      '-e', `SUPERVISOR_MODEL=${SUPERVISOR_MODEL}`,
      '-e', `SPECIALIST_MODEL=${SPECIALIST_MODEL}`,
    );
  }
  run('docker', [
    'run', '-d', '--name', GATEWAY, '--network', 'backend-network',
    '--add-host', 'host.docker.internal:host-gateway',
    ...gatewayEnv,
    'agent-gateway:latest',
  ]);
  // The gateway must also reach web-api-mcp on the isolated agent-mcp network.
  run('docker', ['network', 'connect', 'agent-mcp', GATEWAY]);

  verify();
}

function verify() {
  log('verifying gateway health + production nodes (the production graph build can take ~20–40s) ...');
  // /health over backend-network (no host port is published — private only). Poll up to ~90s:
  // the gateway builds the production graph + MCP clients at startup before it serves.
  let health = '';
  for (let i = 0; i < 30; i++) {
    const r = spawnSync('docker', [
      'run', '--rm', '--network', 'backend-network', 'curlimages/curl:latest',
      '-s', '-m', '5', `http://${GATEWAY}:8000/health`,
    ], { cwd: REPO_ROOT, encoding: 'utf8' });
    health = (r.stdout || '').trim();
    if (health.includes('ok')) break;
    spawnSync(process.platform === 'win32' ? 'cmd' : 'sh',
      process.platform === 'win32' ? ['/c', 'timeout', '/t', '3', '/nobreak'] : ['-c', 'sleep 3'],
      { cwd: REPO_ROOT, stdio: 'ignore' });
  }
  if (!health.includes('ok')) die(`gateway /health did not return ok after ~90s (got: ${health || 'no response'})`);

  const prod = capture('docker', [
    'exec', GATEWAY, 'python', '-c',
    'import os; from src.runtime_nodes import production_nodes_enabled; print(production_nodes_enabled(os.environ))',
  ]);
  if (prod !== 'True') die(`gateway is NOT running production nodes (production_nodes_enabled=${prod})`);

  // Confirm the gateway can reach BOTH MCP servers (200 on an MCP initialize; 421 = DNS-rebinding
  // protection still blocking the Docker Host — see the MCP DNS-rebinding fix).
  const probe = capture('docker', [
    'exec', GATEWAY, 'python', '-c',
    "import httpx\n" +
      "for n,u in [('movie-mcp','http://movie-mcp:8000/mcp'),('web-api-mcp','http://web-api-mcp:8000/mcp')]:\n" +
      "    r=httpx.post(u,timeout=8,headers={'Accept':'application/json, text/event-stream','Content-Type':'application/json'},json={'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2024-11-05','capabilities':{},'clientInfo':{'name':'p','version':'1'}}})\n" +
      "    print(n, r.status_code)",
  ]);
  for (const line of probe.split('\n')) {
    const [name, code] = line.trim().split(/\s+/);
    if (code !== '200') die(`gateway → ${name} returned ${code} (expected 200; 421 = MCP DNS-rebinding still blocking)`);
  }
  log(`✅ stack up: gateway healthy, production nodes ON (provider=${MODEL_PROVIDER}), movie-mcp + web-api-mcp reachable.`);
  log('   Run the agent E2E:  node scripts/agent-e2e.mjs   (or: pnpm nx e2e:agents mcm-app)');
}

function status() {
  run('docker', ['ps', '--filter', 'name=agent-gateway', '--filter', 'name=movie-mcp', '--filter', 'name=web-api-mcp',
    '--format', 'table {{.Names}}\t{{.Status}}']);
  if (tryRun('docker', ['inspect', GATEWAY])) {
    const prod = capture('docker', ['exec', GATEWAY, 'python', '-c',
      'import os; from src.runtime_nodes import production_nodes_enabled; print(production_nodes_enabled(os.environ))']);
    log(`production nodes: ${prod}`);
  }
}

const arg = process.argv[2];
try {
  if (arg === '--down') {
    removeContainers();
    log('agent stack removed (agent-gateway, movie-mcp, web-api-mcp).');
  } else if (arg === '--status') {
    status();
  } else {
    deploy(arg === '--build');
  }
} catch (e) {
  die(e.message);
}
