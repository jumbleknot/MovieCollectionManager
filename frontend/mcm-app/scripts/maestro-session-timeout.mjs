/**
 * Runs the session-timeout Maestro flow in isolation.
 *
 * WHY SEPARATE: EXPO_PUBLIC_DEV_IDLE_TIMEOUT_OVERRIDE_MS is baked into the Metro
 * bundle at start time. The main e2e:mobile target intentionally excludes
 * session-timeout.yaml (it's in MANUAL_FLOWS) so normal test runs don't require
 * Metro to be restarted with the override.
 *
 * PREREQUISITE (must be done before running this target):
 *   1. Uncomment EXPO_PUBLIC_DEV_IDLE_TIMEOUT_OVERRIDE_MS=60000 in .env.local
 *   2. Restart Metro:  cd frontend/mcm-app && pnpm exec expo start --port 8081 --reset-cache
 *   3. Run:  pnpm nx e2e:mobile:session-timeout mcm-app
 *   4. When done: re-comment the line in .env.local and restart Metro
 *
 * The script validates .env.local before running Maestro so the failure is
 * a clear error rather than a cryptic Maestro timeout.
 */

import { spawnSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const dir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(dir, '..');

// ─── Validate .env.local has the idle-timeout override set ────────────────────

const localEnvFile = resolve(projectRoot, '.env.local');
const overridePattern = /^\s*EXPO_PUBLIC_DEV_IDLE_TIMEOUT_OVERRIDE_MS\s*=\s*\d+/m;

const hasOverride =
  existsSync(localEnvFile) && overridePattern.test(readFileSync(localEnvFile, 'utf8'));

if (!hasOverride) {
  console.error(`
  ╔══════════════════════════════════════════════════════════════════════════╗
  ║  EXPO_PUBLIC_DEV_IDLE_TIMEOUT_OVERRIDE_MS is not set in .env.local.    ║
  ║                                                                          ║
  ║  Steps before running this target:                                       ║
  ║    1. Uncomment EXPO_PUBLIC_DEV_IDLE_TIMEOUT_OVERRIDE_MS=60000          ║
  ║       in frontend/mcm-app/.env.local                                     ║
  ║    2. Restart Metro:                                                     ║
  ║       cd frontend/mcm-app && pnpm exec expo start --port 8081           ║
  ║    3. Re-run: pnpm nx e2e:mobile:session-timeout mcm-app                ║
  ║    4. After the test: re-comment the line and restart Metro              ║
  ╚══════════════════════════════════════════════════════════════════════════╝
`);
  process.exit(1);
}

// ─── Load test credentials from .env.e2e.local ────────────────────────────────

const envFile = resolve(projectRoot, '.env.e2e.local');
const envVars = {
  E2E_TEST_USER: process.env.E2E_TEST_USER,
  E2E_TEST_PASSWORD: process.env.E2E_TEST_PASSWORD,
};

if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*(.+)$/);
    if (!m) continue;
    const key = m[1];
    if (key in envVars && !envVars[key]) envVars[key] = m[2].trim();
  }
}

if (!envVars.E2E_TEST_USER || !envVars.E2E_TEST_PASSWORD) {
  console.error('E2E_TEST_USER and E2E_TEST_PASSWORD must be set in .env.e2e.local');
  process.exit(1);
}

// ─── Run the flow ─────────────────────────────────────────────────────────────

const flow = resolve(projectRoot, 'tests/e2e/mobile/session-timeout.yaml');
const envArgs = Object.entries(envVars)
  .filter(([, v]) => v)
  .flatMap(([k, v]) => ['--env', `${k}=${v}`]);

console.log('\nRunning session-timeout flow (EXPO_PUBLIC_DEV_IDLE_TIMEOUT_OVERRIDE_MS=60000)...\n');

const result = spawnSync('maestro', ['test', flow, ...envArgs], {
  stdio: 'inherit',
  cwd: projectRoot,
  shell: true,
});

process.exit(result.status ?? 1);
