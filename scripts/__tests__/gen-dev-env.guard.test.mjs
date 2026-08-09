// 048 US6 — gen-dev-env.mjs must CREATE frontend/mcm-app/.env.local, never silently skip it.
//
// Why this guard exists. On 2026-08-07 the agent integration suite reported 38 errors under
// MCM_REQUIRE_LIVE_STACK=1, all `ROPC / service-account creds not set`, and the conclusion drawn was
// "this leg cannot be run in this dev container". That was wrong. `.env.local` simply did not exist,
// and `syncEnvFile` returns early on a missing path — so the three realm client secrets reached
// .env.docker but never the file kc_admin.cfg() reads. One `node scripts/gen-dev-env.mjs` after
// creating the file took the suite from 13 passed / 38 errors to 51 passed / 0 failed.
//
// A generator step that quietly does nothing and reports success is the same defect class as a gate
// that skips to green — which is what feature 048 exists to remove. This test is what keeps the
// early-return from coming back.
//
// The generator resolves REPO_ROOT from its own path (`dirname(script)/..`), so these tests copy it
// into a temporary mini-repo. That keeps them KEYLESS and offline: they never touch the real
// stacks/auth.env (gitignored, absent in CI) or the developer's real env files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_SCRIPT = resolve(REPO_ROOT, 'scripts/gen-dev-env.mjs');

const AUTH_ENV = [
  'KEYCLOAK_CLIENT_SECRET=kc-client-secret-fixture',
  'KEYCLOAK_SERVICE_CLIENT_SECRET=kc-service-secret-fixture',
  'AGENT_SUBJECT_TOKEN_CLIENT_SECRET=agent-subject-secret-fixture',
  'E2E_TEST_PASSWORD=e2e-password-fixture',
  'E2E_ROPC_CLIENT_SECRET=e2e-ropc-secret-fixture',
  '',
].join('\n');

/** Build a throwaway mini-repo containing the generator and a synthetic auth.env. */
function miniRepo() {
  const root = mkdtempSync(resolve(tmpdir(), 'gen-dev-env-'));
  mkdirSync(resolve(root, 'scripts'), { recursive: true });
  mkdirSync(resolve(root, 'frontend/mcm-app'), { recursive: true });
  mkdirSync(resolve(root, 'mcp-servers/web-api-mcp'), { recursive: true });
  mkdirSync(resolve(root, 'infrastructure-as-code/docker/stacks'), { recursive: true });
  copyFileSync(REAL_SCRIPT, resolve(root, 'scripts/gen-dev-env.mjs'));
  writeFileSync(resolve(root, 'infrastructure-as-code/docker/stacks/auth.env'), AUTH_ENV, 'utf8');
  return root;
}

function runGenerator(root) {
  return execFileSync(process.execPath, [resolve(root, 'scripts/gen-dev-env.mjs')], {
    encoding: 'utf8',
    env: { ...process.env, TMDB_API_KEY: 'tmdb-fixture' },
  });
}

const ENV_LOCAL = (root) => resolve(root, 'frontend/mcm-app/.env.local');

test('US6-AC1: an ABSENT .env.local is created, not silently skipped', () => {
  const root = miniRepo();
  try {
    assert.equal(existsSync(ENV_LOCAL(root)), false, 'precondition: the file starts absent');
    runGenerator(root);
    assert.ok(
      existsSync(ENV_LOCAL(root)),
      'gen-dev-env.mjs left .env.local absent. That is the 2026-08-07 defect: the realm client ' +
        'secrets land in .env.docker but never in the file kc_admin.cfg() reads, so every ' +
        'credential-dependent integration test skips and the box looks unrunnable.',
    );
    const written = readFileSync(ENV_LOCAL(root), 'utf8');
    for (const key of [
      'KEYCLOAK_CLIENT_SECRET',
      'KEYCLOAK_SERVICE_CLIENT_SECRET',
      'AGENT_SUBJECT_TOKEN_CLIENT_SECRET',
    ]) {
      assert.match(written, new RegExp(`^${key}=.+$`, 'm'), `${key} must be present and non-empty`);
    }
    // The value must be the one the realm actually imported, not a placeholder.
    assert.match(written, /^KEYCLOAK_SERVICE_CLIENT_SECRET=kc-service-secret-fixture$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('US6-AC1: the generator REPORTS creating the file, so the operator can see it happened', () => {
  const root = miniRepo();
  try {
    const out = runGenerator(root);
    assert.match(
      out,
      /created .*\.env\.local|\.env\.local.*created/i,
      `the run must say it created .env.local; got: ${out.trim()}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('US6-AC2: no output points at frontend/mcm-app/.env.example — that file is not in the repo', () => {
  // Advice that cannot be followed is worse than none: it sends the reader hunting a missing file
  // instead of at the real cause. Asserted against the REAL repo, not the mini-repo.
  //
  // Keyed on VERSION CONTROL, not on the working directory. `frontend/mcm-app/.env.example` is
  // gitignored (`.gitignore:13`, `*.env.*`), so an untracked local copy — which a developer may
  // perfectly reasonably have — tripped a guard whose own message says it is watching for the file
  // being ADDED TO THE REPOSITORY. It fired for the operator and never in CI, which is the worst
  // combination: red on the machine where nothing is wrong, silent where it would matter.
  const tracked = spawnSync('git', ['ls-files', '--error-unmatch', 'frontend/mcm-app/.env.example'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.notEqual(
    tracked.status,
    0,
    'if an .env.example is ever COMMITTED, this guard and the generator advice should be revisited together',
  );
  const source = readFileSync(REAL_SCRIPT, 'utf8');
  const consoleLines = source
    .split('\n')
    .filter((l) => /console\.(log|error|warn)/.test(l) || /^\s*\(?\w+ \?/.test(l));
  for (const line of consoleLines) {
    assert.ok(
      !/\.env\.example/.test(line),
      `gen-dev-env.mjs tells the operator to copy .env.example, which does not exist:\n  ${line.trim()}`,
    );
  }
});

test('US6: an EXISTING .env.local keeps its developer-customised keys (no regression)', () => {
  // The whole reason this file is synced surgically rather than generated: a developer's other keys
  // must survive. Creating it when absent must not turn into clobbering it when present.
  const root = miniRepo();
  try {
    writeFileSync(
      ENV_LOCAL(root),
      '# hand-written\nEXPO_PUBLIC_SOMETHING=keep-me\nKEYCLOAK_CLIENT_SECRET=stale-value\n',
      'utf8',
    );
    runGenerator(root);
    const written = readFileSync(ENV_LOCAL(root), 'utf8');
    assert.match(written, /^EXPO_PUBLIC_SOMETHING=keep-me$/m, 'unrelated developer keys must survive');
    assert.match(written, /^# hand-written$/m, 'comments must survive');
    assert.match(
      written,
      /^KEYCLOAK_CLIENT_SECRET=kc-client-secret-fixture$/m,
      'a stale client secret must be rewritten to the realm value',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
