// Feature 086 — a test run cannot take the dev sandbox's service stacks down.
//
// On 2026-11-01 one `pnpm nx test mcm-app` fanned out to ~19 Jest workers (Jest's default is
// cores − 1, and the sandbox has 20 vCPUs), ~6.9 GB together, in a 16 GiB VM with no swap. The
// kernel's global OOM killer then took Keycloak's JVM — the largest single process in the VM, and a
// bystander — so the auth stack restart-looped while the test run that caused it carried on.
//
// Two layers, both pinned here:
//   - every Jest config caps its workers (≤ 4, ~0.9 GB each at peak) and recycles a worker that
//     keeps growing (workerIdleMemoryLimit);
//   - the sandbox dev container has a memory limit, so an exhaustion inside it is resolved inside
//     it, never against the stacks beside it.
//
// Jest configs are DISCOVERED from git, not listed: a new Jest project added later without a cap
// fails here by name. Values are read from source, never by executing a config — a config can load
// env files or run a preflight, which a guard test must not do. See specs/086-dev-memory-bounds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MAX_WORKERS = 4;
const DEVCONTAINER_MEMORY = '10g';

const tracked = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && !f.includes('node_modules/'));

/** @returns {{ file: string, maxWorkers: number | undefined, idleLimit: boolean }[]} */
function discoverJestConfigs() {
  const found = [];
  for (const file of tracked) {
    const name = basename(file);
    if (/^jest(\.[^.]+)?\.config\.[cm]?[jt]s$/.test(name)) {
      const src = readFileSync(resolve(REPO_ROOT, file), 'utf8');
      const m = src.match(/^\s*maxWorkers\s*:\s*(\d+)\s*,?\s*(\/\/.*)?$/m);
      found.push({
        file,
        maxWorkers: m ? Number(m[1]) : undefined,
        idleLimit: /^\s*workerIdleMemoryLimit\s*:/m.test(src),
      });
    } else if (name === 'package.json') {
      const jest = JSON.parse(readFileSync(resolve(REPO_ROOT, file), 'utf8')).jest;
      if (!jest) continue;
      found.push({
        file,
        maxWorkers: Number.isInteger(jest.maxWorkers) ? jest.maxWorkers : undefined,
        idleLimit: jest.workerIdleMemoryLimit !== undefined,
      });
    }
  }
  return found;
}

const configs = discoverJestConfigs();

test('discovery finds the known Jest configs (an empty discovery must not pass vacuously)', () => {
  const files = configs.map((c) => c.file);
  for (const known of [
    'frontend/mcm-app/package.json',
    'frontend/mcm-app/jest.integration.config.js',
    'packages/design-system/jest.config.js',
  ]) {
    assert.ok(files.includes(known), `expected to discover ${known}; found: ${files.join(', ')}`);
  }
});

for (const c of configs) {
  test(`${c.file}: maxWorkers is a literal integer between 1 and ${MAX_WORKERS}`, () => {
    assert.ok(
      c.maxWorkers !== undefined,
      `${c.file} sets no literal integer maxWorkers, so Jest defaults to (cores − 1) — 19 workers on the ` +
        `20-vCPU sandbox. Set maxWorkers to an integer ≤ ${MAX_WORKERS} (specs/086-dev-memory-bounds).`,
    );
    assert.ok(
      c.maxWorkers >= 1 && c.maxWorkers <= MAX_WORKERS,
      `${c.file} sets maxWorkers=${c.maxWorkers}; the cap is ${MAX_WORKERS} (~0.9 GB per worker at peak).`,
    );
  });

  if (c.maxWorkers === undefined || c.maxWorkers > 1) {
    test(`${c.file}: a multi-worker config recycles a growing worker (workerIdleMemoryLimit)`, () => {
      assert.ok(
        c.idleLimit,
        `${c.file} allows more than one worker but sets no workerIdleMemoryLimit, so a leaking worker ` +
          `keeps its memory for the whole run.`,
      );
    });
  }
}

test(`the sandbox dev container has a ${DEVCONTAINER_MEMORY} memory limit, with no swap above it`, () => {
  const src = readFileSync(resolve(REPO_ROOT, '.devcontainer/sandbox/devcontainer.json'), 'utf8');
  const memory = [...src.matchAll(/^\s*"--memory=(\w+)"/gm)].map((m) => m[1]);
  const swap = [...src.matchAll(/^\s*"--memory-swap=(\w+)"/gm)].map((m) => m[1]);
  assert.deepEqual(
    memory,
    [DEVCONTAINER_MEMORY],
    'runArgs must carry exactly one "--memory=10g": without it a runaway in the dev container is ' +
      'resolved by a VM-wide OOM kill, which picks the largest process anywhere — Keycloak, on 2026-11-01.',
  );
  assert.deepEqual(swap, memory, 'runArgs must carry "--memory-swap" equal to "--memory".');
});
