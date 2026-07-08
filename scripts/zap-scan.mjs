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

// ── Authenticated-coverage assertion (T013, SC-002 / FR-012) ─────────────────
// Protected post-auth URL patterns that MUST appear in the crawl if the authenticated session worked.
// If none appear, auth silently failed and the "clean" report is meaningless — fail hard.
const PROTECTED_URL_PATTERNS = [
  /\/bff-api\/collections/i,
  /\/api\/v1\//i,
];
// URLs that are reachable without auth — their presence alone does NOT prove an authenticated crawl.
const PUBLIC_URL_PATTERNS = [
  /\/login/i, /\/register/i, /\/bff-api\/auth\/(init|login|register|verify|resend)/i, /\/health/i,
];

/**
 * Flatten URLs from a ZAP traditional-json report. ZAP's traditional-json does NOT enumerate the full
 * crawl tree — only URIs attached to alert instances — so this is a supplementary signal, not the
 * authoritative coverage source (the runner uses a direct authenticated probe for that; see
 * verifyAuthenticatedAccess). Kept because the report-instance URIs are still useful context.
 */
export function extractCrawledUrls(report) {
  const urls = new Set();
  for (const site of report?.site ?? []) {
    for (const u of site.urls ?? []) urls.add(u);
    for (const alert of site.alerts ?? []) {
      for (const inst of alert.instances ?? []) if (inst.uri) urls.add(inst.uri);
    }
  }
  return [...urls];
}

/**
 * Throw unless at least one authenticated request reached a protected post-auth endpoint (SC-002).
 * `urls` is the list of URLs that were confirmed reachable WITH the authenticated session (from the
 * runner's direct probe). An empty/public-only list means the authenticated session was never
 * established — a silent auth failure that must fail the run, not pass as clean (FR-012).
 */
export function assertAuthenticatedCoverage(urls) {
  const list = Array.isArray(urls) ? urls : [];
  const hitProtected = list.some((u) => PROTECTED_URL_PATTERNS.some((re) => re.test(u)));
  if (!hitProtected) {
    const publicOnly = list.filter((u) => PUBLIC_URL_PATTERNS.some((re) => re.test(u)));
    throw new Error(
      'Authenticated coverage check FAILED: no protected post-auth endpoint was reachable with the ' +
      `authenticated session (e.g. /bff-api/collections, mc-service /api/v1/…). Confirmed ${list.length} URL(s)` +
      (publicOnly.length ? `, all public (${publicOnly.slice(0, 3).join(', ')})` : '') +
      '. The authenticated session likely failed — refusing to report a clean public-only scan (FR-012).',
    );
  }
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

/**
 * Directly confirm the authenticated session works by requesting a protected endpoint with the BFF
 * cookies. GET /bff-api/collections proxies through to mc-service, so a 200 proves BOTH the BFF
 * session AND the BFF→mc-service bearer path. Returns the list of URLs confirmed reachable with auth
 * (used by assertAuthenticatedCoverage). Reliable where ZAP's traditional-json has no crawl inventory.
 */
async function probeAuthenticatedUrls(cookies) {
  const bffBase = process.env.DAST_BFF_BASE_URL ?? 'http://localhost:8082';
  const cookieHeader = ['mcm_access_token', 'mcm_refresh_token', 'mcm_session_id']
    .filter((k) => cookies[k]).map((k) => `${k}=${cookies[k]}`).join('; ');
  const url = `${bffBase}/bff-api/collections`;
  try {
    const res = await fetch(url, { headers: { Cookie: cookieHeader } });
    if (res.status === 200) return [url];
    console.warn(`[zap-scan] auth probe GET /bff-api/collections → HTTP ${res.status} (expected 200).`);
  } catch (e) {
    console.warn(`[zap-scan] auth probe failed: ${e.message}`);
  }
  return [];
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
  let cookies = null;
  if (reachable.bff) {
    cookies = await login();
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

  // Post-scan authenticated-coverage check (SC-002 / FR-012): if the BFF was in scope, directly
  // confirm a protected endpoint is reachable with the session — a failure means auth silently failed,
  // so refuse to report a clean public-only scan.
  if (reachable.bff && cookies) {
    const confirmed = await probeAuthenticatedUrls(cookies);
    assertAuthenticatedCoverage(confirmed); // throws → non-zero exit via main().catch
    console.log('[zap-scan] authenticated coverage confirmed (protected endpoint reachable with session).');
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
