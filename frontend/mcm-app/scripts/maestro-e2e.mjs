import { spawnSync } from 'child_process';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const dir = dirname(fileURLToPath(import.meta.url));
const envFile = resolve(dir, '..', '.env.e2e.local');

// Env vars read from .env.e2e.local (required unless already in process.env)
const envVars = {
  E2E_TEST_USER: process.env.E2E_TEST_USER,
  E2E_TEST_PASSWORD: process.env.E2E_TEST_PASSWORD,
  E2E_MOVIE_TITLE: process.env.E2E_MOVIE_TITLE,
  E2E_COLLECTION_NAME: process.env.E2E_COLLECTION_NAME,
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

// Flows that require a non-default Metro env config (e.g. a short absolute-timeout
// override) and must be run in isolation with Metro restarted. See each file for
// manual invocation instructions.
const MANUAL_FLOWS = new Set(['session-timeout-absolute.yaml']);

const flowsDir = resolve(dir, '..', 'tests/e2e/mobile');
const flows = readdirSync(flowsDir)
  .filter(f => f.endsWith('.yaml') && !f.startsWith('_') && !MANUAL_FLOWS.has(f))
  .sort()
  .map(f => resolve(flowsDir, f));

// Build --env args for all non-empty vars.
// Values with spaces must be quoted so the shell (shell: true) passes them
// as a single argument to maestro, e.g.: --env "KEY=value with spaces"
const envArgs = Object.entries(envVars)
  .filter(([, v]) => v)
  .flatMap(([k, v]) => {
    const arg = v.includes(' ') ? `"${k}=${v}"` : `${k}=${v}`;
    return ['--env', arg];
  });

const result = spawnSync(
  'maestro',
  ['test', ...flows, ...envArgs],
  { stdio: 'inherit', cwd: resolve(dir, '..'), shell: true }
);

process.exit(result.status ?? 1);
