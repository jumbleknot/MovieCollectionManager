// Feature 092. `prod-realm.json` defined no permissions for the BFF's service account, so production's
// were set by hand and drifted from CI and dev. CI could never see the difference: it imports its own
// realm file. Account deletion for an administrator and self-registration both failed in production,
// with every CI tier green.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const KEYCLOAK = resolve(REPO_ROOT, 'infrastructure-as-code/docker/keycloak');

const rolesIn = (file) => {
  const realm = JSON.parse(readFileSync(resolve(KEYCLOAK, file), 'utf8'));
  const account = (realm.users ?? []).find((u) => u.serviceAccountClientId === 'mcm-bff-service');
  assert.ok(account, `${file} must define the mcm-bff-service service account`);
  return account.clientRoles?.['realm-management'] ?? [];
};

// Each BFF admin call needs these. `manage-clients` includes `view-clients`, as measured on 26.8.1
// and 26.8.2. `query-clients` is NOT enough: the lookup answers 200 with an empty list.
for (const file of ['ci-realm.json', 'dev-realm.json', 'prod-realm.json']) {
  test(`${file} gives the service account what the BFF's admin calls need`, () => {
    const roles = rolesIn(file);
    for (const role of ['view-users', 'manage-users']) {
      assert.ok(roles.includes(role), `${file} is missing ${role}`);
    }
    assert.ok(
      roles.includes('view-clients') || roles.includes('manage-clients'),
      `${file} needs view-clients or manage-clients: registration and the last-admin check look up the client`,
    );
  });
}

test('prod-realm.json grants no more than production needs', () => {
  assert.deepEqual([...rolesIn('prod-realm.json')].sort(), ['manage-users', 'view-clients', 'view-users']);
});

// `/bff-api/auth/init` registers these itself in dev and CI. Production's account cannot write to a
// client, so there the realm has to list them already. Keycloak refuses anything unlisted with
// `Invalid parameter: redirect_uri`, which is how account deletion failed in production.
test('prod-realm.json lists every address /bff-api/auth/init registers', () => {
  const init = readFileSync(
    resolve(REPO_ROOT, 'frontend/mcm-app/src/app/bff-api/auth/init+api.ts'),
    'utf8',
  );
  const block = init.match(/ensureClientRedirectUris\(\[([\s\S]*?)\]\);/)?.[1];
  assert.ok(block, 'could not find the address list in init+api.ts');
  // Comments only: `mcm-app://` also contains two slashes.
  const code = block.replace(/^\s*\/\/.*$/gm, '').replace(/,\s*\/\/.*$/gm, ',');
  const expected = [...code.matchAll(/[`']([^`']+)[`']/g)].map((m) =>
    m[1].replace('${BASE_URL}', 'https://mcm.${BASE_DOMAIN}'),
  );
  assert.equal(expected.length, 6, `expected six addresses in init+api.ts, read ${expected.length}`);

  const realm = JSON.parse(readFileSync(resolve(KEYCLOAK, 'prod-realm.json'), 'utf8'));
  const client = realm.clients.find((c) => c.clientId === 'movie-collection-manager');
  assert.deepEqual([...client.redirectUris].sort(), [...expected].sort());
});
