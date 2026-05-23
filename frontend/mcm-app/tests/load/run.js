#!/usr/bin/env node
/**
 * Load test runner for movie collection endpoints (T164)
 *
 * Usage:
 *   node tests/load/run.js [k6-extra-args...]
 *
 * Environment variables:
 *   BASE_URL           BFF URL (default: http://localhost:8081)
 *   LOAD_TEST_COOKIE   Session cookie from a BFF login (required for auth)
 *                      Format: "mcm-session=<session-id>"
 *
 * Prerequisites:
 *   1. k6 installed — https://k6.io/docs/get-started/installation/
 *      Windows: winget install k6 --source winget
 *      macOS:   brew install k6
 *   2. Full stack running (Keycloak + Redis + mc-service + MongoDB + BFF)
 *      See specs/002-manage-movie-collection/quickstart.md
 *   3. LOAD_TEST_COOKIE obtained from a manual BFF login session
 *
 * What this script does:
 *   1. Compiles collection-load-impl.ts → collection-load-impl.js (via esbuild)
 *   2. Runs the compiled script with k6
 *
 * The k6 test itself:
 *   - setup():    Creates a collection, seeds 10,000 movies via BFF API
 *   - default():  Concurrent VUs measure SC-004/SC-006 thresholds
 *   - teardown(): Deletes the test collection
 *
 * Nx invocation (from repo root):
 *   pnpm nx test:load mcm-app
 */

'use strict';

const { execSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// ─── Paths ──────────────────────────────────────────────────────────────────────

// This script lives at tests/load/run.js; projectRoot is two levels up
const projectRoot = path.resolve(__dirname, '..', '..');
const loadDir = __dirname;
const srcFile = path.join(loadDir, 'collection-load-impl.ts');
const outFile = path.join(loadDir, 'collection-load-impl.js');

// ─── Validate prerequisites ────────────────────────────────────────────────────

/** Check whether an executable is available on PATH */
function commandExists(cmd) {
  const result = spawnSync(cmd, ['--version'], { encoding: 'utf8', shell: true });
  return result.status === 0;
}

if (!commandExists('k6')) {
  console.error('[load] ERROR: k6 is not installed or not on PATH.');
  console.error('       Install: https://k6.io/docs/get-started/installation/');
  console.error('       Windows: winget install k6 --source winget');
  console.error('       macOS:   brew install k6');
  process.exit(1);
}

if (!fs.existsSync(srcFile)) {
  console.error(`[load] ERROR: Source file not found: ${srcFile}`);
  process.exit(1);
}

// ─── Configuration ─────────────────────────────────────────────────────────────

const baseUrl = process.env.BASE_URL || 'http://localhost:8081';
const cookie = process.env.LOAD_TEST_COOKIE || '';
const extraArgs = process.argv.slice(2).join(' ');

if (!cookie) {
  console.warn('[load] WARNING: LOAD_TEST_COOKIE is not set.');
  console.warn('       All requests will receive HTTP 401 (unauthenticated).');
  console.warn('       Log in via the app and copy the session cookie value.');
}

// ─── Step 1: Compile TypeScript → JavaScript ───────────────────────────────────

console.log('[load] Compiling collection-load-impl.ts...');
try {
  execSync(
    [
      'npx esbuild',
      `"${srcFile}"`,
      '--bundle',
      '--platform=browser',
      '--target=es2015',
      `--outfile="${outFile}"`,
    ].join(' '),
    {
      stdio: 'inherit',
      cwd: projectRoot,
      shell: true,
    },
  );
  console.log('[load] Compilation successful.');
} catch {
  console.error('[load] ERROR: TypeScript compilation failed (see esbuild output above).');
  process.exit(1);
}

// ─── Step 2: Run k6 ───────────────────────────────────────────────────────────

console.log(`[load] Target: ${baseUrl}`);
console.log('[load] Thresholds:');
console.log('         SC-004  collections list  p(95) < 3000ms');
console.log('         SC-006  movie list         p(95) < 3000ms');
console.log('         SC-006  movie search       p(95) < 3000ms');
console.log('[load] Stages: 30s ramp → 2m at 100 VUs → 30s ramp-down');
console.log('[load] Starting k6...\n');

const k6Cmd = [
  'k6 run',
  `-e BASE_URL="${baseUrl}"`,
  `-e LOAD_TEST_COOKIE="${cookie}"`,
  extraArgs,
  `"${outFile}"`,
].join(' ');

try {
  execSync(k6Cmd, { stdio: 'inherit', shell: true });
  console.log('\n[load] Load test PASSED — all thresholds met.');
} catch {
  // k6 exits with code 99 when thresholds fail, code 108 on error
  console.error('\n[load] Load test FAILED — one or more thresholds were not met.');
  console.error('       Review the k6 summary above for which threshold failed.');
  process.exit(1);
}
