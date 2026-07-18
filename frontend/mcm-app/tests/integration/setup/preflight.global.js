/**
 * BFF integration-test dependency preflight (feature 041, T004) — the jest arm of the shared
 * cross-language skip-escalation convention
 * (specs/041-integration-test-ci-enforcement/contracts/skip-escalation-convention.md).
 *
 * WHY: this suite drives the LIVE BFF over HTTP against real Keycloak + Redis + Mongo. When those
 * are absent the individual tests either error or are skipped, and a misconfigured CI run could
 * silently report green (the exact false-confidence PR #77 exposed for the agent suite). Jest has
 * no per-test skip-escalation hook, so a fail-fast `globalSetup` precondition is the equivalent
 * guarantee: when `MCM_REQUIRE_LIVE_STACK=1` (set by app-ci's app-e2e job, where the full stack IS
 * up) we probe every required dependency and THROW if any is unreachable — turning a silent
 * all-skip into a hard suite failure.
 *
 * Locally the flag is unset, so this is a no-op and the credential-less / partial-stack dev
 * experience is unchanged (a bare checkout stays green).
 *
 * LEGITIMATE SKIPS: only the env-gated OPTIONAL profiles the default gate never brings up
 * (observability: OPA/LangFuse/OTel; audit: OpenSearch). This suite does not depend on any of
 * them, so there is nothing to allowlist here — the four probed deps are ALL required. If a future
 * BFF integration test depends on an optional profile, gate that individual test on its own env
 * flag (do NOT weaken this preflight).
 *
 * Dependency-free by design (this feature adds no new deps — see setup/env.ts): raw node:http /
 * node:net probes only.
 */
const http = require('node:http');
const net = require('node:net');
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const appRoot = join(__dirname, '..', '..', '..'); // tests/integration/setup → frontend/mcm-app
const PROBE_TIMEOUT_MS = 4000;

/** Mirror env.ts loading so a local `MCM_REQUIRE_LIVE_STACK=1` run resolves the same URLs. */
function loadEnvFile(relPath) {
  const file = join(appRoot, relPath);
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf-8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([^#=\s]+)\s*=\s*(.*)$/);
    if (!match) continue;
    const value = match[2].trim().replace(/^['"]|['"]$/g, '');
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

function httpProbe(url, { expectStatus } = {}) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: PROBE_TIMEOUT_MS }, (res) => {
      res.resume(); // drain
      if (expectStatus && res.statusCode !== expectStatus) {
        resolve(`unexpected status ${res.statusCode} (wanted ${expectStatus})`);
      } else {
        resolve(null); // any response means the server is up
      }
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(`timed out after ${PROBE_TIMEOUT_MS}ms`);
    });
    req.on('error', (err) => resolve(err.message));
  });
}

/** TCP connect + optional line exchange. `expectPrefix` checks the first reply (e.g. Redis +PONG). */
function tcpProbe(host, port, { send, expectPrefix } = {}) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: PROBE_TIMEOUT_MS });
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.on('connect', () => {
      if (!send) return done(null); // port open is enough
      socket.write(send);
    });
    socket.on('data', (buf) => {
      const reply = buf.toString('utf-8');
      if (expectPrefix && !reply.startsWith(expectPrefix)) done(`unexpected reply: ${reply.slice(0, 40)}`);
      else done(null);
    });
    socket.on('timeout', () => done(`timed out after ${PROBE_TIMEOUT_MS}ms`));
    socket.on('error', (err) => done(err.message));
  });
}

function parseRedis(url) {
  try {
    const u = new URL(url);
    return { host: u.hostname || 'localhost', port: Number(u.port || 6379) };
  } catch {
    return { host: 'localhost', port: 6379 };
  }
}

function parseMongo(url) {
  try {
    const u = new URL(url);
    return { host: u.hostname || 'localhost', port: Number(u.port || 27018) };
  } catch {
    return { host: 'localhost', port: 27018 };
  }
}

module.exports = async function preflight() {
  if (process.env.MCM_REQUIRE_LIVE_STACK !== '1') return; // local / credential-less: unchanged.

  loadEnvFile('.env.e2e.local');
  loadEnvFile('.env.local');

  const bffUrl = process.env.BFF_BASE_URL || 'http://localhost:8082';
  const keycloakUrl = process.env.KEYCLOAK_URL || 'http://localhost:8099';
  const realm = process.env.KEYCLOAK_REALM || 'grumpyrobot';
  const redis = parseRedis(process.env.REDIS_TEST_URL || process.env.REDIS_URL || 'redis://localhost:6379/1');
  const mongo = parseMongo(process.env.MONGO_URL || 'mongodb://localhost:27018');

  const checks = [
    ['BFF', bffUrl, httpProbe(bffUrl)],
    [
      'Keycloak',
      `${keycloakUrl}/realms/${realm}/.well-known/openid-configuration`,
      httpProbe(`${keycloakUrl}/realms/${realm}/.well-known/openid-configuration`, { expectStatus: 200 }),
    ],
    ['Redis', `${redis.host}:${redis.port}`, tcpProbe(redis.host, redis.port, { send: 'PING\r\n', expectPrefix: '+PONG' })],
    ['BFF Mongo', `${mongo.host}:${mongo.port}`, tcpProbe(mongo.host, mongo.port)],
  ];

  const results = await Promise.all(checks.map(([, , p]) => p));
  const down = checks
    .map(([name, target], i) => ({ name, target, error: results[i] }))
    .filter((c) => c.error !== null);

  if (down.length) {
    const detail = down.map((c) => `  • ${c.name} (${c.target}): ${c.error}`).join('\n');
    throw new Error(
      'MCM_REQUIRE_LIVE_STACK=1: the BFF integration suite requires a live stack, but these ' +
        `required dependencies were unreachable:\n${detail}\n\n` +
        'In CI a down dependency is a BROKEN HARNESS, not a pass — a silently-skipped suite reports ' +
        'green and gives false confidence. Bring up the auth + mcm stacks (or fix the step env). ' +
        'Locally, unset MCM_REQUIRE_LIVE_STACK to restore skip-clean behaviour.',
    );
  }
};
