// T007 — DAST active-scan safety guard (feature 031, FR-017 / research D8).
// Asserts scripts/zap-scan.mjs refuses `--mode full` unless DAST_ALLOW_ACTIVE=1 AND the target is a
// known disposable (Compose/localhost) environment. Pure-function test — no Docker, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertActiveScanAllowed } from '../zap-scan.mjs';

test('permits baseline mode unconditionally', () => {
  assert.doesNotThrow(() => assertActiveScanAllowed({ mode: 'baseline', target: 'local', env: {} }));
  assert.doesNotThrow(() => assertActiveScanAllowed({ mode: 'baseline', target: 'ci', env: { DAST_ALLOW_ACTIVE: '1' } }));
});

test('rejects --mode full without DAST_ALLOW_ACTIVE', () => {
  assert.throws(
    () => assertActiveScanAllowed({ mode: 'full', target: 'ci', env: {} }),
    /DAST_ALLOW_ACTIVE/,
    'active scan must be refused when DAST_ALLOW_ACTIVE is not set',
  );
});

test('rejects --mode full against a non-disposable target even with DAST_ALLOW_ACTIVE', () => {
  assert.throws(
    () => assertActiveScanAllowed({ mode: 'full', target: 'production', env: { DAST_ALLOW_ACTIVE: '1' } }),
    /disposable/i,
    'active scan must be refused against an unknown/shared target',
  );
});

test('permits --mode full with DAST_ALLOW_ACTIVE=1 against a disposable target', () => {
  assert.doesNotThrow(() => assertActiveScanAllowed({ mode: 'full', target: 'ci', env: { DAST_ALLOW_ACTIVE: '1' } }));
  assert.doesNotThrow(() => assertActiveScanAllowed({ mode: 'full', target: 'local', env: { DAST_ALLOW_ACTIVE: '1' } }));
});
