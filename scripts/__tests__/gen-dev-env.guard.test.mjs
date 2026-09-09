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
import { execFileSync, spawn, spawnSync } from 'node:child_process';
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

function runGenerator(root, extraEnv = {}) {
  return execFileSync(process.execPath, [resolve(root, 'scripts/gen-dev-env.mjs')], {
    encoding: 'utf8',
    // The realm check is OFF by default here: these cases are about the files, they must stay
    // offline, and a developer box with the auth stack actually up would otherwise 401 on the
    // synthetic fixture secrets and fail every one of them. Item #395's own cases turn it back on
    // against a stub realm on loopback.
    env: { ...process.env, TMDB_API_KEY: 'tmdb-fixture', MCM_SKIP_REALM_VERIFY: '1', ...extraEnv },
  });
}

const ENV_LOCAL = (root) => resolve(root, 'frontend/mcm-app/.env.local');
const E2E_LOCAL = (root) => resolve(root, 'frontend/mcm-app/.env.e2e.local');

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

// ─── item #395 — a STALE credential must be detected, not reported as synced ─────────────────────
//
// Sibling of the case above, and the harder one. That defect was "the generator does not WRITE a
// file it should"; this one is "it writes the file, prints
//
//     realm-secret == BFF-secret == E2E-cred from stacks/auth.env
//
// and the secret is stale". Measured 2026-09-08: `mcp-servers/movie-mcp`'s integration suite skipped
// every test on `ROPC token request failed (401): unauthorized_client` — 20 errors under
// MCM_REQUIRE_LIVE_STACK=1 — while `.env.e2e.local` EXISTED and carried a 64-char secret. The
// generator projects from `stacks/auth.env` and never asks the realm, so any drift (a re-seed, a
// regenerated client secret) is invisible and that success line actively asserts the opposite.
//
// The repo's own heuristic — "a credential-driven skip is almost always a missing FILE" — sends the
// reader hunting an absent file, which is exactly the case this one is not.
import { createServer } from 'node:http';

/**
 * A stub Keycloak that answers only the token endpoint, on loopback. Keeps these cases keyless and
 * offline while still exercising the real HTTP path the generator uses.
 *
 * `answer(params)` returns `[status, body]` for one token request.
 */
async function stubRealm(answer) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const params = new URLSearchParams(body);
      requests.push({ url: req.url, params: Object.fromEntries(params) });
      const [status, payload] = answer(params);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((r) => server.close(r)),
  };
}

/**
 * Run the generator against a stub realm, returning stdout+stderr and the exit code.
 *
 * ASYNC on purpose: `spawnSync` blocks this process's event loop, so the stub server — which lives
 * here — would never accept the connection and every case would fail on an 8s timeout instead of on
 * the answer it was written to test.
 */
function runAgainstRealm(root, url) {
  const child = spawn(process.execPath, [resolve(root, 'scripts/gen-dev-env.mjs')], {
    env: { ...process.env, TMDB_API_KEY: 'tmdb-fixture', MCM_SKIP_REALM_VERIFY: '', KEYCLOAK_PUBLIC_URL: url },
  });
  let out = '';
  child.stdout.setEncoding('utf8').on('data', (c) => (out += c));
  child.stderr.setEncoding('utf8').on('data', (c) => (out += c));
  return new Promise((r) => child.on('close', (code) => r({ code, out })));
}

test('#395: a STALE ROPC client secret is detected and FAILS LOUDLY — the file being present is not proof', async () => {
  const realm = await stubRealm(() => [401, { error: 'unauthorized_client', error_description: 'Invalid client or Invalid client credentials' }]);
  const root = miniRepo();
  try {
    // A file already holding the value that WORKS — the state measured on the operator's box on
    // 2026-09-09, where auth.env was the stale side and a hand-corrected .env.e2e.local was not.
    writeFileSync(E2E_LOCAL(root), 'E2E_ROPC_CLIENT_SECRET=the-value-the-realm-accepts\n', 'utf8');
    const { code, out } = await runAgainstRealm(root, realm.url);
    assert.equal(
      readFileSync(E2E_LOCAL(root), 'utf8'),
      'E2E_ROPC_CLIENT_SECRET=the-value-the-realm-accepts\n',
      'the generator overwrote a WORKING credential with the stale one before complaining about it — ' +
        'that turns a diagnosis into an outage, and is why the check runs before the writes',
    );
    assert.equal(existsSync(ENV_LOCAL(root)), false, 'nothing may be written on the refusal path');
    assert.notEqual(code, 0, `a realm that rejects the projected credential must not exit 0; got:\n${out}`);
    assert.match(out, /E2E_ROPC_CLIENT_SECRET|mcm-bff-test/, `the failure must name what is stale; got:\n${out}`);
    assert.match(out, /unauthorized_client/, 'the realm\'s own answer must be quoted, not paraphrased away');
    assert.doesNotMatch(
      out,
      /realm-secret == BFF-secret == E2E-cred/,
      'the success claim must not be printed alongside a realm that refuses the credential',
    );
    // The remedy must be a command, not "check your setup".
    assert.match(out, /gen-dev-secrets|up-auth|re-?import|re-?seed/i, `no actionable remedy in:\n${out}`);
    // No secret value may reach the output, on any path.
    assert.doesNotMatch(out, /e2e-ropc-secret-fixture|kc-service-secret-fixture/, 'a secret VALUE was printed');
  } finally {
    await realm.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('#395: a realm that ACCEPTS both grants lets the run claim the equality — and says it was checked', async () => {
  const realm = await stubRealm(() => [200, { access_token: 'stub', expires_in: 60 }]);
  const root = miniRepo();
  try {
    const { code, out } = await runAgainstRealm(root, realm.url);
    assert.equal(code, 0, `a realm that accepts the credentials must exit 0; got:\n${out}`);
    assert.match(out, /verified/i, `the run must say the claim was checked; got:\n${out}`);
    assert.ok(existsSync(ENV_LOCAL(root)), 'a verified run must still do the projection it exists for');
    // Both halves of "realm-secret == BFF-secret == E2E-cred" are exercised: the BFF service
    // account (client_credentials) and the E2E ROPC client (password).
    const grants = realm.requests.map((r) => r.params.grant_type).sort();
    assert.deepEqual(grants, ['client_credentials', 'password']);
    const clients = realm.requests.map((r) => r.params.client_id).sort();
    assert.deepEqual(clients, ['mcm-bff-service', 'mcm-bff-test']);
  } finally {
    await realm.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('#395: an UNREACHABLE realm is not a failure — but the equality is then NOT claimed', async () => {
  // The generator legitimately runs before `up-auth`. Absence of a realm must not fail the run; it
  // must only stop the run asserting something it did not check.
  const root = miniRepo();
  try {
    // A port that was bound and then released: nothing listens, so the connect is REFUSED. (Not a
    // low port such as 1 — undici blocks those before it dials, which is a different error.)
    const closed = await stubRealm(() => [200, {}]);
    await closed.close();
    const { code, out } = await runAgainstRealm(root, closed.url);
    assert.equal(code, 0, `an absent realm must not fail the projection; got:\n${out}`);
    assert.doesNotMatch(
      out,
      /realm-secret == BFF-secret == E2E-cred/,
      'the unverified run still asserted the equality — this is the #395 defect verbatim',
    );
    assert.match(out, /not verified/i, `the run must say the check did not happen; got:\n${out}`);
    // `fetch` buries the real cause one level down; reporting err.name gives a bare `TypeError`,
    // which tells the reader nothing about why the realm could not be reached.
    assert.match(out, /ECONNREFUSED/, `the reason must be the real connect error; got:\n${out}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#395: skipping the check is ANNOUNCED — an env var must not silently restore the old claim', async () => {
  const root = miniRepo();
  try {
    const out = runGenerator(root);
    assert.doesNotMatch(out, /realm-secret == BFF-secret == E2E-cred/);
    assert.match(out, /MCM_SKIP_REALM_VERIFY/, `the skip must name itself; got:\n${out}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
