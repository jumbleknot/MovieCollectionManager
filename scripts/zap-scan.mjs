#!/usr/bin/env node
// DAST scan runner (feature 031, T006/T008/T011/T018).
// Contract: specs/031-dast-zap-scanning/contracts/zap-scan-contract.md.
//
// Resolves the target (local|ci) + mode (baseline|full), maps DAST_* auth env from the existing E2E_*
// secrets (no new secret material — C3), acquires a BFF session (headless PKCE login → mcm_* cookies —
// C2), then launches OWASP ZAP as a container attached to the shared `backend-network` so it reaches
// every target by Compose DNS (no new published host ports — FR-016). Reports land in
// security/zap/reports/ (gitignored).
//
// Usage:
//   node scripts/zap-scan.mjs --target <local|ci> --mode <baseline|full>
//   (default: --target local --mode baseline)
//
// Active (`--mode full`) is destructive and refused unless DAST_ALLOW_ACTIVE=1 against a disposable
// target (FR-017, D8 guard — see assertActiveScanAllowed).

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { login } from './dast-bff-login.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── Target model ─────────────────────────────────────────────────────────────
// All targets resolve on the shared external `backend-network` by Compose DNS. These URLs are the
// ONLY hosts the scanner ever touches; the D8 guard relies on this closed set (no arbitrary host).
export const TARGETS = {
  bff: { key: 'bff', baseUrl: 'http://mcm-bff-service-nonsecure:3000', authStyle: 'session-cookie' },
  'mc-service': { key: 'mc-service', baseUrl: 'http://mc-service:3001', authStyle: 'bearer' },
  'agent-gateway': { key: 'agent-gateway', baseUrl: 'http://movie-assistant-gateway:8000', authStyle: 'bearer' },
};

export const KC_TOKEN_URL = 'http://keycloak-service:8080/realms/grumpyrobot/protocol/openid-connect/token';
export const SCAN_NETWORK = 'backend-network';
export const ZAP_IMAGE = 'ghcr.io/zaproxy/zaproxy:stable';

// Disposable target selectors — the only environments an active scan may point at (D8 / FR-017).
export const DISPOSABLE_TARGETS = ['local', 'ci'];

// ── D8 safety guard (T008) ───────────────────────────────────────────────────
// The active (`full`) scan sends attack payloads and is destructive, so it may run ONLY against a
// disposable throwaway environment and ONLY when explicitly opted in via DAST_ALLOW_ACTIVE=1 — this
// prevents ever pointing the destructive scan at shared/prod data (FR-017). Baseline is always safe
// (spider + passive, non-destructive) and is unconditionally permitted. Throws with a clear message
// on refusal.
export function assertActiveScanAllowed({ mode, target, env = process.env }) {
  if (mode !== 'full') return; // baseline is non-destructive — always allowed
  if (!DISPOSABLE_TARGETS.includes(target)) {
    throw new Error(
      `Refusing active (--mode full) scan against non-disposable target "${target}". ` +
      `Active mode is permitted only against a disposable throwaway stack (${DISPOSABLE_TARGETS.join('|')}).`,
    );
  }
  if (env.DAST_ALLOW_ACTIVE !== '1') {
    throw new Error(
      'Refusing active (--mode full) scan: destructive mode requires DAST_ALLOW_ACTIVE=1 (set only in the CI dast ' +
      'job / an explicit local throwaway run). Use --mode baseline for a non-destructive scan.',
    );
  }
}

// ── DAST_* ← E2E_* mapping (C3) ──────────────────────────────────────────────
// Populate each DAST_* auth var from its E2E_* equivalent when unset, so the existing E2E secrets are
// reused with no new secret material and no CI wiring change.
export function mapDastEnvFromE2E(env = process.env) {
  const pairs = [
    ['DAST_TEST_USER', 'E2E_TEST_USER'],
    ['DAST_TEST_PASSWORD', 'E2E_TEST_PASSWORD'],
    ['DAST_ROPC_CLIENT_ID', 'E2E_ROPC_CLIENT_ID'],
    ['DAST_ROPC_CLIENT_SECRET', 'E2E_ROPC_CLIENT_SECRET'],
  ];
  for (const [dast, e2e] of pairs) {
    if (!env[dast] && env[e2e]) env[dast] = env[e2e];
  }
  return env;
}

function parseArgs(argv) {
  const args = { target: 'local', mode: 'baseline' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--target') args.target = argv[++i];
    else if (argv[i] === '--mode') args.mode = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}. Usage: zap-scan.mjs --target <local|ci> --mode <baseline|full>`);
  }
  if (!DISPOSABLE_TARGETS.includes(args.target)) {
    throw new Error(`--target must be one of ${DISPOSABLE_TARGETS.join('|')} (got "${args.target}").`);
  }
  if (!['baseline', 'full'].includes(args.mode)) {
    throw new Error(`--mode must be baseline|full (got "${args.mode}").`);
  }
  return args;
}

// Probe a target on the scan network; returns true if it answers at all (any HTTP status). Distinct
// from an auth *failure* — an unreachable target is WARN+skip (C6), never a silent clean pass.
function targetReachable(baseUrl) {
  const r = spawnSync('docker', [
    'run', '--rm', '--network', SCAN_NETWORK, 'curlimages/curl:latest',
    '-s', '-o', '/dev/null', '-m', '8', '-w', '%{http_code}', baseUrl,
  ], { encoding: 'utf8' });
  const code = (r.stdout || '').trim();
  return r.status === 0 && code !== '' && code !== '000';
}

function planFile(mode) {
  return mode === 'full' ? 'security/zap/zap-full.yaml' : 'security/zap/zap-baseline.yaml';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mapDastEnvFromE2E();
  assertActiveScanAllowed({ mode: args.mode, target: args.target, env: process.env });

  console.log(`[zap-scan] target=${args.target} mode=${args.mode}`);

  // Reachability sweep (C6): warn + skip any target that does not respond; never silently pass.
  const reachable = {};
  for (const t of Object.values(TARGETS)) {
    reachable[t.key] = targetReachable(t.baseUrl);
    if (!reachable[t.key]) {
      console.warn(`[zap-scan] WARNING: target ${t.key} (${t.baseUrl}) is unreachable on ${SCAN_NETWORK} — skipping it. ` +
        (t.key === 'agent-gateway' ? 'Bring up the agent stack (pnpm nx up-agents-prod) for gateway coverage.' : ''));
    }
  }
  if (!Object.values(reachable).some(Boolean)) {
    throw new Error('No scan target is reachable on the network — is the stack up? Refusing to report a clean pass.');
  }

  // BFF session (C2): headless PKCE login → mcm_* cookies, written to the mounted reports dir so the
  // in-scanner bff-session-refresh.js can read them. Fail fast if the BFF is reachable but auth fails
  // (FR-012); if the BFF itself is unreachable it was already warned above.
  const cookieFile = resolve(REPO_ROOT, 'security/zap/reports/.auth.local.json');
  if (reachable.bff) {
    const cookies = await login();
    mkdirSync(dirname(cookieFile), { recursive: true });
    writeFileSync(cookieFile, JSON.stringify(cookies, null, 2));
    console.log('[zap-scan] BFF session established (mcm_* cookies written).');
  }

  // Launch ZAP attached to the scan network; mount security/zap at /zap/wrk (plans + scripts + reports).
  const dockerArgs = [
    'run', '--rm', '--network', SCAN_NETWORK,
    '-v', `${resolve(REPO_ROOT, 'security/zap')}:/zap/wrk/:rw`,
    '-e', `KC_TOKEN_URL=${KC_TOKEN_URL}`,
    '-e', 'DAST_BFF_COOKIE_FILE=/zap/wrk/reports/.auth.local.json',
  ];
  for (const v of ['DAST_TEST_USER', 'DAST_TEST_PASSWORD', 'DAST_ROPC_CLIENT_ID', 'DAST_ROPC_CLIENT_SECRET']) {
    if (process.env[v]) dockerArgs.push('-e', `${v}=${process.env[v]}`);
  }
  dockerArgs.push(ZAP_IMAGE, 'zap.sh', '-cmd', '-autorun', `/zap/wrk/${planFile(args.mode).replace('security/zap/', '')}`);

  console.log(`[zap-scan] launching ZAP (${args.mode}) …`);
  const zap = spawnSync('docker', dockerArgs, { stdio: 'inherit' });
  // ZAP's -autorun exit code reflects plan job failures; the merge gate is check-dast-findings.mjs,
  // so a non-zero here is surfaced but the authoritative pass/fail is the gate over report.json.
  if (zap.status !== 0) {
    console.warn(`[zap-scan] ZAP exited ${zap.status} — inspect the reports; the gate (check-dast-findings.mjs) is authoritative.`);
  }
  console.log('[zap-scan] done — reports in security/zap/reports/.');
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[zap-scan] FAILED: ${err.message}`);
    process.exit(1);
  });
}
