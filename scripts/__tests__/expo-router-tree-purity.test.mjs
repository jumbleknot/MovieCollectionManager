// Feature 076 — nothing under `src/app/` may be a test file.
//
// `expo-router/entry` builds the application's module graph by scanning the routes directory, so
// EVERY matching file under `frontend/mcm-app/src/app/` is bundled into the shipped app. A test
// file placed there drags its testing library in with it.
//
// MEASURED, not theorised. `src/app/unit-tests/account-deleted.test.tsx` was added during feature
// 076 and the Android release build failed at `:app:createBundleReleaseJsAndAssets`:
//
//     Error: Unable to resolve module console from
//       node_modules/@testing-library/react-native/build/helpers/logger.js
//
// The WEB export tolerated it silently, so the mistake survived a green web E2E, a green unit run,
// a green typecheck and a green lint, and only the native bundler objected. That asymmetry is the
// reason this guard exists rather than a review note: the cheap tiers cannot see it.
//
// Deterministic, offline, token-free, node: built-ins only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const APP_DIR = resolve(REPO_ROOT, 'frontend/mcm-app/src/app');

/** Every file under the routes directory, relative to it, POSIX separators. */
function walk(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    return e.isDirectory() ? walk(join(dir, e.name), rel) : [rel];
  });
}

test('the routes directory exists at all', () => {
  // Without this, every assertion below is vacuously true over an empty list.
  assert.ok(existsSync(APP_DIR), `expected the Expo Router tree at ${APP_DIR}`);
  assert.ok(walk(APP_DIR).length > 10, 'expected the routes directory to hold routes');
});

test('no test file lives under src/app — expo-router bundles everything there', () => {
  const offenders = walk(APP_DIR).filter((f) => /\.(test|spec)\.[jt]sx?$/.test(f));

  assert.deepEqual(
    offenders,
    [],
    'these are inside the Expo Router tree, so their testing library is bundled into the ' +
      'shipped app — the Android release build fails on it while the web export does not. ' +
      'Move them beside the code they test (src/screens/…, src/hooks/unit-tests/…) and give ' +
      'the route a thin component that delegates.',
  );
});

test('no test-only directory lives under src/app either', () => {
  const offenders = walk(APP_DIR)
    .map((f) => f.split('/').slice(0, -1).join('/'))
    .filter((d) => /(^|\/)(unit-tests|__tests__|__mocks__|test-support)(\/|$)/.test(d));

  assert.deepEqual(
    [...new Set(offenders)],
    [],
    'a test-only directory under the routes tree is bundled the same way an individual test is',
  );
});
