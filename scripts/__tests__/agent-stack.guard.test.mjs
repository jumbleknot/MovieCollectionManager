// Feature 041 — stale-agent-image guard.
//
// `app-e2e` runs on a PERSISTENT runner whose reset step removes containers + volumes but NOT images.
// agent-stack.mjs used to skip the build whenever the tag existed, so every run silently exercised
// leftover `agent-gateway`/`*-mcp` images instead of the agent/MCP source in the checkout — a
// false-green for the whole agent layer (it hid a committed TMDB-key redaction fix). Building is now
// the default and `--no-build` is refused under CI. Pure-function test — no Docker, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBuildMode } from '../agent-stack.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('builds by default — a bare invocation never reuses a leftover image', () => {
  assert.equal(resolveBuildMode([], {}), true);
});

test('--build stays accepted and still means build', () => {
  assert.equal(resolveBuildMode(['--build'], {}), true);
});

test('--no-build opts out locally', () => {
  assert.equal(resolveBuildMode(['--no-build'], {}), false);
});

test('--no-build is refused under CI (a gate must test the checkout)', () => {
  assert.throws(
    () => resolveBuildMode(['--no-build'], { CI: 'true' }),
    /CI/,
    'CI must not be allowed to deploy stale agent images',
  );
});

test('no CI workflow deploys the agent stack with --no-build', () => {
  for (const wf of ['app-ci.yml', 'guardrails.yml', 'cd-deploy.yml']) {
    const text = readFileSync(resolve(REPO_ROOT, '.forgejo/workflows', wf), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (line.includes('up-agents-prod') || line.includes('agent-stack.mjs')) {
        assert.ok(!line.includes('--no-build'), `${wf}: agent stack brought up with --no-build: ${line.trim()}`);
      }
    }
  }
});
