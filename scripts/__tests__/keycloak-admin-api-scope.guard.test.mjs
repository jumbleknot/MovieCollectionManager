// Feature 090. Keycloak 26.8.2 refuses an Admin API token that lacks the `kc-admin-api` scope, and
// neither an upgrade nor a bare reference in a realm file gives our service account that scope. The
// failure is 401 on every BFF admin call, and only a fresh import or a real upgrade shows it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const KEYCLOAK = resolve(REPO_ROOT, 'infrastructure-as-code/docker/keycloak');
const SCRIPT = resolve(KEYCLOAK, 'scripts/ensure-admin-api-scope.mjs');

for (const file of ['ci-realm.json', 'dev-realm.json', 'prod-realm.json']) {
  test(`${file} defines kc-admin-api and gives it to mcm-bff-service`, () => {
    const realm = JSON.parse(readFileSync(resolve(KEYCLOAK, file), 'utf8'));
    const scope = (realm.clientScopes ?? []).find((s) => s.name === 'kc-admin-api');
    assert.ok(scope, 'the scope must be DEFINED here: import ignores a reference to an undefined scope');
    assert.deepEqual(
      (scope.protocolMappers ?? []).map((m) => m.protocolMapper),
      ['oidc-admin-api-audience-mapper'],
    );
    const client = realm.clients.find((c) => c.clientId === 'mcm-bff-service');
    assert.ok(client.defaultClientScopes.includes('kc-admin-api'), 'mcm-bff-service must carry it as a default scope');
  });
}

const run = (...args) =>
  spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    // An address nothing listens on: a run that tried to act would fail differently from a refusal.
    env: { ...process.env, KC_URL: 'http://127.0.0.1:9', KC_ADMIN_PASSWORD: 'x' },
  });

test('the script rejects a mistyped --apply before it contacts anything', () => {
  for (const typo of ['--aply', '--apply=true', '-apply', 'apply']) {
    const r = run(typo);
    assert.equal(r.status, 2, `${typo} must be a usage error, got ${r.status}: ${r.stderr}`);
    assert.doesNotMatch(r.stderr + r.stdout, /ECONNREFUSED|fetch failed/);
  }
});

test('--help explains and contacts nothing', () => {
  const r = run('--help');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--apply/);
});

test('the script needs the admin password', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: { ...process.env, KC_ADMIN_PASSWORD: '' } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /KC_ADMIN_PASSWORD/);
});

test('planSteps does only what is missing', async () => {
  const { planSteps } = await import(SCRIPT);
  assert.deepEqual(planSteps({ scopeExists: false, assigned: false }), ['create-scope', 'assign-scope']);
  assert.deepEqual(planSteps({ scopeExists: true, assigned: false }), ['assign-scope']);
  assert.deepEqual(planSteps({ scopeExists: true, assigned: true }), []);
});
