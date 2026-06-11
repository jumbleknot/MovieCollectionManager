#!/usr/bin/env node
/**
 * agent-e2e.mjs — run the feature-012 agent E2E specs against the CONTAINERIZED production stack.
 *
 * Drives the agent flows (assistant-*.spec.ts) through the dev-container BFF + the containerized
 * production-node gateway + containerized MCP servers (deploy with scripts/agent-stack.mjs) —
 * NO Metro, NO host gateway. `E2E_AGENT_PRODUCTION=1` un-gates the specs; `E2E_BFF_TARGET=
 * dev-container` points Playwright at the container BFF (:8082).
 *
 * Runs each spec FILE in isolation (a fresh `nx e2e` invocation = fresh login/session). This is
 * deliberate: the full PARALLEL suite has 10 workers share ONE test user, which exhausts the
 * per-user 20 req/60 s rate limit and crosses the ~5 min access-token lifetime (no_token) — both
 * harness artifacts unrelated to the agent code. Isolated-per-spec is how these were always run.
 *
 * It first (re)creates the dev BFF with the agent-e2e limit override (compose.agent-e2e.yaml) so
 * the shared test user is not locked out by the cost ceiling / rate limit (the guards work — see
 * SC-011 — they just must not gate a multi-spec agent-flow run).
 *
 * Usage:
 *   node scripts/agent-e2e.mjs                 # all agent specs, isolated
 *   node scripts/agent-e2e.mjs assistant-add   # a single spec (basename, no path/.spec.ts)
 *
 * Prereqs: scripts/agent-stack.mjs deployed (gateway production nodes up) + the shared stack
 * (mc-service/Keycloak/Redis/Mongo). Exits non-zero if any spec fails.
 */

import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GATEWAY = 'agent-gateway';
const OVERRIDE = 'infrastructure-as-code/docker/bff/compose.agent-e2e.yaml';
const ALL_SPECS = [
  'assistant-add',
  'assistant-add-ambiguous',
  'assistant-organize',
  'assistant-organize-update-move',
  'assistant-navigate',
  'assistant-context',
  'assistant-query',
  'assistant-list-refresh',
  'assistant-disambiguate',
];

const log = (m) => console.log(`[agent-e2e] ${m}`);
const die = (m) => {
  console.error(`[agent-e2e] ERROR: ${m}`);
  process.exit(1);
};
// shell:true on Windows so command shims (pnpm.cmd) resolve — without it spawnSync('pnpm') ENOENTs.
const sh = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { cwd: REPO_ROOT, stdio: 'inherit', shell: process.platform === 'win32', ...opts });
const ok = (cmd, args) => spawnSync(cmd, args, { cwd: REPO_ROOT, stdio: 'ignore' }).status === 0;
const out = (cmd, args, opts = {}) => {
  try {
    return execFileSync(cmd, args, { cwd: REPO_ROOT, encoding: 'utf8', ...opts }).trim();
  } catch {
    return '';
  }
};

function preflight() {
  if (!ok('docker', ['inspect', GATEWAY])) {
    die('agent-gateway container not found — deploy the stack first:  node scripts/agent-stack.mjs');
  }
  const prod = out('docker', ['exec', GATEWAY, 'python', '-c',
    'import os; from src.runtime_nodes import production_nodes_enabled; print(production_nodes_enabled(os.environ))']);
  if (prod !== 'True') die(`agent-gateway is not running production nodes (got ${prod || 'unknown'}). Re-run scripts/agent-stack.mjs.`);
  log('gateway production nodes: ON');
}

function ensureBffWithRelaxedLimits() {
  log('(re)creating dev BFF with agent-e2e limit override ...');
  const r = sh('docker', ['compose', '-f', 'compose.yaml', '-f', OVERRIDE, '--profile', 'bff-dev',
    'up', '-d', '--force-recreate', 'mcm-bff-dev']);
  if (r.status !== 0) die('failed to (re)create mcm-bff-dev with the override');
}

function clearCostKeys() {
  // Belt-and-suspenders (the override already raises the ceiling): drop any accrued agent cost.
  const redis = out('docker', ['ps', '--filter', 'name=mcm-redis', '--format', '{{.Names}}']).split('\n')[0];
  if (redis) {
    spawnSync('docker', ['exec', redis, 'sh', '-c',
      'redis-cli --scan --pattern "agent-cost:*" | xargs -r redis-cli del'],
      { cwd: REPO_ROOT, stdio: 'ignore' });
  }
}

function runSpec(spec) {
  clearCostKeys();
  log(`▶ ${spec}`);
  const r = sh('pnpm', ['nx', 'e2e', 'mcm-app', '--', `tests/e2e/web/${spec}.spec.ts`], {
    env: { ...process.env, E2E_BFF_TARGET: 'dev-container', E2E_AGENT_PRODUCTION: '1' },
  });
  return r.status === 0;
}

const requested = process.argv[2];
const specs = requested ? [requested.replace(/\.spec\.ts$/, '')] : ALL_SPECS;
if (requested && !ALL_SPECS.includes(specs[0])) {
  die(`unknown spec '${requested}'. Known: ${ALL_SPECS.join(', ')}`);
}

preflight();
ensureBffWithRelaxedLimits();

const results = [];
for (const spec of specs) results.push([spec, runSpec(spec)]);

log('──── agent E2E summary (containerized production stack) ────');
let failed = 0;
for (const [spec, passed] of results) {
  log(`  ${passed ? '✅ PASS' : '❌ FAIL'}  ${spec}`);
  if (!passed) failed++;
}
log(`──── ${results.length - failed}/${results.length} spec files passed ────`);
process.exit(failed === 0 ? 0 : 1);
