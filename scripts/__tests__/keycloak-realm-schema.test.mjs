// Keycloak realm JSON takes no comments — a guard, because the failure is silent locally and fatal
// in CI (feature 052).
//
// Keycloak imports these files into `RealmRepresentation` with unknown fields REJECTED. An extra key
// is not ignored: the import fails, the server refuses to start, the container reports `unhealthy`,
// and every job depending on it dies at bring-up, long before any test runs.
//
//     ERROR: Unrecognized field "_comment_accessTokenLifespan"
//            (class org.keycloak.representations.idm.RealmRepresentation)
//     ERROR: Failed to run import
//
// Measured on app-ci run 1611: one explanatory key cost a whole CI run. What makes it worth a guard
// rather than a lesson is that the obvious local check does not catch it — `JSON.parse` succeeds,
// because JSON syntax was never the constraint. Only Keycloak's schema is, and the only thing that
// exercises it is starting Keycloak.
//
// Document a realm setting in infrastructure-as-code/docker/keycloak/README.md instead.
//
// Deterministic, offline, token-free, node: built-ins only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const REALM_DIR = resolve(REPO_ROOT, 'infrastructure-as-code/docker/keycloak');

const realmFiles = readdirSync(REALM_DIR).filter((f) => f.endsWith('-realm.json'));

/** Every key in the document, at any depth, with a path for a useful failure message. */
function* keysDeep(value, path = '$') {
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) yield* keysDeep(v, `${path}[${i}]`);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      yield { key: k, path: `${path}.${k}` };
      yield* keysDeep(v, `${path}.${k}`);
    }
  }
}

test('there are realm files to check', () => {
  // Without this every assertion below is vacuously true over an empty list.
  assert.ok(realmFiles.length >= 2, `expected the realm JSONs, found ${realmFiles.join(', ')}`);
});

test('no realm JSON carries a comment-style key at any depth', () => {
  const offenders = [];
  for (const file of realmFiles) {
    const doc = JSON.parse(readFileSync(join(REALM_DIR, file), 'utf8'));
    for (const { key, path } of keysDeep(doc)) {
      if (key.startsWith('_')) offenders.push(`${file} ${path}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'Keycloak rejects unrecognized fields and refuses to start — put the explanation in ' +
      'infrastructure-as-code/docker/keycloak/README.md instead',
  );
});

test('every realm file is still parseable JSON', () => {
  // Weaker than the check above and kept deliberately: a malformed file fails the same way, and this
  // says which one rather than leaving a stack trace from the loop above.
  for (const file of realmFiles) {
    assert.doesNotThrow(
      () => JSON.parse(readFileSync(join(REALM_DIR, file), 'utf8')),
      `${file} is not valid JSON`,
    );
  }
});
