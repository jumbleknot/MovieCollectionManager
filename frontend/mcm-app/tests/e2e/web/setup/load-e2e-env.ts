/**
 * Feature 027 (US4, T016): load the gitignored E2E credential file into `process.env` for the web
 * Playwright path + cleanup tooling, so no consumer needs a hardcoded credential fallback and a
 * local run needs no manual shell export.
 *
 * Mirrors `tests/integration/setup/env.ts` (jest `setupFiles`) and the python `_load_env_file` in
 * the integration `conftest.py`: existing env WINS (CI's job env is authoritative), an absent file
 * is a no-op. Playwright runs each spec in its own worker process — global-setup's env mutations do
 * NOT propagate to spec workers — so any spec that reads a credential at module load must call
 * `loadE2eEnv()`/`requireEnv()` itself, not rely on global-setup having run.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// tests/e2e/web/setup → up 4 → frontend/mcm-app
const APP_ROOT = join(__dirname, '..', '..', '..', '..');

function loadEnvFile(relPath: string): void {
  const file = join(APP_ROOT, relPath);
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf-8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([^#=\s]+)\s*=\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    // Strip surrounding single/double quotes; trim whitespace and trailing CR.
    const value = match[2].trim().replace(/^['"]|['"]$/g, '');
    if (process.env[key] === undefined) process.env[key] = value; // env wins
  }
}

let loaded = false;
/** Idempotently load `.env.e2e.local` (gitignored test creds) into `process.env`. Absent file = no-op. */
export function loadE2eEnv(): void {
  if (loaded) return;
  loaded = true;
  loadEnvFile('.env.e2e.local');
}

/**
 * Read a required E2E credential (loading `.env.e2e.local` first). Throws a clear error when unset —
 * NO hardcoded fallback (feature 027 US4, FR-012/FR-013). Use in must-run consumers (web E2E global
 * setup, cleanup tooling); skip-contract integration suites use their own empty-sentinel + skip.
 */
export function requireEnv(name: string): string {
  loadE2eEnv();
  // Generic env helper for test tooling (not app-bundle code, so the EXPO_PUBLIC inlining the rule
  // guards does not apply) — a dynamic lookup by name is intentional here.
  // eslint-disable-next-line expo/no-dynamic-env-var
  const v = process.env[name];
  if (v === undefined || v === '') {
    throw new Error(
      `Missing required E2E credential ${name}. Set it in frontend/mcm-app/.env.e2e.local ` +
        `(gitignored) or the job environment — no hardcoded fallback is used (feature 027 US4).`
    );
  }
  return v;
}
