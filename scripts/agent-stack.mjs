#!/usr/bin/env node
/**
 * agent-stack.mjs — deploy/teardown the CONTAINERIZED production-node Agent stack for local E2E.
 *
 * Stands up the full feature-012 agent layer as containers so the agent E2E (assistant-*.spec.ts,
 * E2E_AGENT_PRODUCTION=1) runs against the dev-container BFF with NO Metro and NO host gateway:
 *
 *   dev BFF (mcm-bff-service-nonsecure :8082) ──backend──► movie-assistant-gateway (production nodes)
 *                                              ├─backend──► movie-assistant-mcp-movie ──► mc-service
 *                                              └─movie-assistant-mcp-network─► movie-assistant-mcp-webapi ──► TMDB (egress only)
 *
 * This is the LIGHT local-loop variant (host Ollama + in-memory checkpointer — no ~19 GB ollama
 * container, no checkpointer Postgres). The committed `--profile agents` compose is the HEAVY variant
 * (container Ollama + movie-assistant-store-postgres); both share the same image + the gateway production env + the
 * `movie-assistant-mcp-network` network wiring (this script just substitutes host Ollama + MemorySaver + docker run
 * so it boots without the model pull). The Agent Gateway is private-network only — no host port.
 *
 * Three real gaps this codifies (all fixed in-repo; see specs/012-multi-agent-mvp/quickstart.md
 * "Containerized production-agent stack"):
 *   1. The gateway needs BOTH WEB_API_MCP_URL + MOVIE_MCP_URL or `production_nodes_enabled` is
 *      false and it silently serves the tool-free graph.
 *   2. web-api-mcp is off backend-network (egress-only) → reachable only via the isolated
 *      `movie-assistant-mcp-network` network the gateway also joins.
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
 * Prerequisites: the auth + mcm stacks up (Keycloak then mc-service + Redis + Mongo —
 * `pnpm nx up-auth infrastructure-as-code` then `pnpm nx up-mcm infrastructure-as-code`; bring up
 * auth BEFORE mcm so mc-service can fetch Keycloak JWKS on startup, FR-006), host Ollama serving
 * qwen2.5 + qwen2.5:32b, a TMDB_API_KEY in mcp-servers/web-api-mcp/.env.local, and `uv` for the
 * secret fetch.
 *
 * Env overrides: SUPERVISOR_MODEL (default qwen2.5), SPECIALIST_MODEL (default qwen2.5:32b),
 * KEYCLOAK_PUBLIC_URL (admin lookup, default http://localhost:8099).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GATEWAY = 'movie-assistant-gateway';
const CONTAINERS = ['movie-assistant-gateway', 'movie-assistant-mcp-movie', 'movie-assistant-mcp-webapi', 'movie-assistant-mcp-spreadsheet'];
const IMAGES = [
  { tag: 'movie-mcp:latest', dockerfile: 'mcp-servers/movie-mcp/Dockerfile' },
  { tag: 'web-api-mcp:latest', dockerfile: 'mcp-servers/web-api-mcp/Dockerfile' },
  { tag: 'spreadsheet-mcp:latest', dockerfile: 'mcp-servers/spreadsheet-mcp/Dockerfile' },
  { tag: 'agent-gateway:latest', dockerfile: 'agents/movie-assistant/Dockerfile' },
];
// spreadsheet-mcp (014) reads/writes the transient upload/download blobs in the SAME Redis the dev
// BFF uses (it writes import:file:<handle>). Redis is the compose `mcm-bff-cache-redis` on `mcm-bff-network`.
const REDIS_NETWORK = process.env.REDIS_NETWORK || 'mcm-bff-network';
const SPREADSHEET_REDIS_URL = process.env.SPREADSHEET_REDIS_URL || 'redis://mcm-bff-cache-redis:6379';
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
  // Escape hatch for hosts that cannot reach Keycloak over the admin URL from the shell (e.g. a
  // dind dev-container where host->127.0.0.1:<published-port> is unreliable for multi-homed
  // Keycloak): supply the already-fetched secret via AGENT_GATEWAY_CLIENT_SECRET and skip the
  // live admin lookup. The value is never logged. CI/normal hosts leave it unset and fetch live.
  const provided = (process.env.AGENT_GATEWAY_CLIENT_SECRET || '').trim();
  if (provided) {
    log('using AGENT_GATEWAY_CLIENT_SECRET from env (skipping Keycloak admin lookup)');
    return provided;
  }
  log('fetching agent-gateway client secret from Keycloak admin (kc_admin) ...');
  // `--no-project --with httpx --with pytest`: kc_admin.py needs only those two; this avoids a full
  // `uv sync` of the movie-assistant project (annoy/nemoguardrails/grpcio C++ builds) just to read one
  // Keycloak secret — which fails on hosts without a C++ toolchain (e.g. the CI host runner).
  const secret = capture(
    'uv',
    [
      'run',
      '--no-project',
      '--with',
      'httpx',
      '--with',
      'pytest',
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
  ensureNetwork('movie-assistant-mcp-network');
  buildImages(force);
  if (MODEL_PROVIDER === 'ollama') checkHostOllama();
  const secret = fetchGatewaySecret();
  removeContainers();

  log('starting movie-mcp (backend-network → mc-service) ...');
  run('docker', [
    'run', '-d', '--name', 'movie-assistant-mcp-movie', '--network', 'backend-network',
    '-e', 'MC_SERVICE_URL=http://mc-service:3001', 'movie-mcp:latest',
  ]);

  log('starting web-api-mcp (movie-assistant-mcp-network network → TMDB egress only) ...');
  run('docker', [
    'run', '-d', '--name', 'movie-assistant-mcp-webapi', '--network', 'movie-assistant-mcp-network',
    '--env-file', 'mcp-servers/web-api-mcp/.env.local', 'web-api-mcp:latest',
  ]);

  // spreadsheet-mcp (014): file processor on movie-assistant-mcp-network (gateway reaches it) + the redis network
  // (it reads the upload the dev BFF stashed under import:file:<handle> and writes export blobs).
  log('starting spreadsheet-mcp (movie-assistant-mcp-network + redis network) ...');
  run('docker', [
    'run', '-d', '--name', 'movie-assistant-mcp-spreadsheet', '--network', 'movie-assistant-mcp-network',
    '-e', `REDIS_URL=${SPREADSHEET_REDIS_URL}`, 'spreadsheet-mcp:latest',
  ]);
  run('docker', ['network', 'connect', REDIS_NETWORK, 'movie-assistant-mcp-spreadsheet']);

  // Common gateway env (provider-agnostic): production nodes + token exchange + Keycloak.
  const gatewayEnv = [
    '-e', `MODEL_PROVIDER=${MODEL_PROVIDER}`,
    '-e', 'KEYCLOAK_URL=http://keycloak-service:8080',
    '-e', 'KEYCLOAK_REALM=grumpyrobot',
    '-e', 'MOVIE_MCP_URL=http://movie-assistant-mcp-movie:8000/mcp',
    '-e', 'WEB_API_MCP_URL=http://movie-assistant-mcp-webapi:8000/mcp',
    '-e', 'SPREADSHEET_MCP_URL=http://movie-assistant-mcp-spreadsheet:8000/mcp',
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
  // The gateway must also reach web-api-mcp on the isolated movie-assistant-mcp-network network.
  run('docker', ['network', 'connect', 'movie-assistant-mcp-network', GATEWAY]);

  // NOTE: the former `movie-assistant-gw-proxy` socat bridge (host 127.0.0.1:8123 → port-less
  // gateway) is RETIRED (feature 020). This script's gateway stays port-less (container-BFF reaches
  // it by Docker DNS at movie-assistant-gateway:8000). For HOST-side callers that need :8123 (the
  // `agent-config-run-revoked` integration test, or a Metro/host BFF), bring the gateway up via the
  // stack-native `--profile agents-metro` instead — it publishes 127.0.0.1:8123 directly.

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
      "for n,u in [('movie-mcp','http://movie-assistant-mcp-movie:8000/mcp'),('web-api-mcp','http://movie-assistant-mcp-webapi:8000/mcp'),('spreadsheet-mcp','http://movie-assistant-mcp-spreadsheet:8000/mcp')]:\n" +
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
  run('docker', ['ps', '--filter', 'name=movie-assistant-gateway', '--filter', 'name=movie-assistant-mcp-movie', '--filter', 'name=movie-assistant-mcp-webapi',
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
