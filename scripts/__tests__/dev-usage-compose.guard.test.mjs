// Guard (feature 105): the integration stack (dev-usage/compose.yaml) exercises the SAME deploy path as
// production (compose.prod.yaml). Its throwaway Keycloak answers to `keycloak-service` on the project
// network, so the JWKS fetch uses production's exact URL; and the shared services run the same images
// and the same commands. A drift here means the integration tier is testing something prod never runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'infrastructure-as-code', 'docker', 'dev-usage');
const local = parse(readFileSync(resolve(DIR, 'compose.yaml'), 'utf8'));
const prod = parse(readFileSync(resolve(DIR, 'compose.prod.yaml'), 'utf8'));

test('the JWKS fetch uses production\'s URL, and the test Keycloak answers to that name', () => {
  const url = prod.services['dev-usage-jwks-init'].environment.JWKS_URL;
  assert.equal(url, 'http://keycloak-service:8080/realms/grumpyrobot/protocol/openid-connect/certs');
  assert.equal(local.services['dev-usage-jwks-init'].environment.JWKS_URL, url);
  const nets = local.services['dev-usage-keycloak'].networks;
  assert.ok(nets && Object.values(nets).some((n) => n?.aliases?.includes('keycloak-service')),
    'dev-usage-keycloak has no keycloak-service network alias');
});

test('shared services run the same images and commands in both files', () => {
  for (const svc of ['dev-usage-postgres', 'dev-usage-schema-init', 'dev-usage-jwks-init', 'dev-usage-postgrest']) {
    assert.ok(local.services[svc] && prod.services[svc], `${svc} missing from one file`);
    assert.equal(local.services[svc].image, prod.services[svc].image, `${svc} image`);
    assert.deepEqual(local.services[svc].command, prod.services[svc].command, `${svc} command`);
    assert.deepEqual(local.services[svc].entrypoint, prod.services[svc].entrypoint, `${svc} entrypoint`);
  }
  const pick = (e) => Object.fromEntries(Object.entries(e).filter(([k]) => k.startsWith('PGRST_') && k !== 'PGRST_DB_URI'));
  assert.deepEqual(pick(local.services['dev-usage-postgrest'].environment), pick(prod.services['dev-usage-postgrest'].environment));
});
