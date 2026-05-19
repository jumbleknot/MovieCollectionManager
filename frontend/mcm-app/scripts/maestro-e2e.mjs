import { spawnSync } from 'child_process';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const dir = dirname(fileURLToPath(import.meta.url));
const envFile = resolve(dir, '..', '.env.e2e.local');

let testUser = process.env.E2E_TEST_USER;
let testPassword = process.env.E2E_TEST_PASSWORD;

if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*(.+)$/);
    if (!m) continue;
    if (m[1] === 'E2E_TEST_USER') testUser = m[2].trim();
    if (m[1] === 'E2E_TEST_PASSWORD') testPassword = m[2].trim();
  }
}

if (!testUser || !testPassword) {
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

const result = spawnSync(
  'maestro',
  [
    'test', ...flows,
    '--env', `E2E_TEST_USER=${testUser}`,
    '--env', `E2E_TEST_PASSWORD=${testPassword}`,
  ],
  { stdio: 'inherit', cwd: resolve(dir, '..'), shell: true }
);

process.exit(result.status ?? 1);
