// app-ci-stateful-reset.guard.test.mjs — every stateful volume the E2E jobs CREATE must also be one
// the reset step REMOVES, or state leaks between runs on the persistent runner.
//
// MEASURED 2026-09-05. `mcm-bff-cache-redis-data` was created by "First-time docker setup" and never
// listed in "Reset stateful CI data", so it outlived every run. PR #362's app-e2e ran redis 8.10.1 and
// wrote an RDB v15 dump into it; the next app-e2e on redis 8.6.2 — PR #360, then `main` itself (run
// 2735, the #361 merge) — died at bring-up with
//
//     # Can't handle RDB format version 15
//     # Fatal error loading the DB, check server logs. Exiting.
//
// and `dependency failed to start: container mcm-bff-cache-redis is unhealthy`. Nothing in the failing
// commit touched redis; the failure was carried in from a PREVIOUS run's container, and `main` went
// red on a docs-and-uv merge. A datastore version moving in either direction between consecutive runs
// trips this, which is why the property is asserted for every volume rather than fixed for one.
//
// The reset step is what makes the persistent runner safe (see the comment above it in app-ci.yml);
// a volume it does not know about is a hole in that guarantee, invisible until two runs disagree
// about the on-disk format.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = resolve(REPO_ROOT, '.forgejo/workflows/app-ci.yml');
const workflow = parseYaml(readFileSync(WORKFLOW, 'utf8'));

/** The E2E-style jobs that bring the compose stacks up on the persistent `kvm` runner. */
const STACK_JOBS = ['app-e2e', 'dast'];

const VOLUME = /\b([a-z0-9-]+-data)\b/g;

function stepsOf(jobName) {
  const steps = workflow?.jobs?.[jobName]?.steps;
  assert.ok(Array.isArray(steps), `app-ci.yml has no job "${jobName}" with steps`);
  return steps;
}

/** Volume names appearing in the shell of the step whose `run` contains `marker`. */
function volumesIn(jobName, marker) {
  const step = stepsOf(jobName).find((s) => typeof s?.run === 'string' && s.run.includes(marker));
  assert.ok(step, `job "${jobName}" has no step running \`${marker}\``);
  return new Set([...step.run.matchAll(VOLUME)].map((m) => m[1]));
}

for (const jobName of STACK_JOBS) {
  test(`${jobName}: every volume first-time setup creates is one the reset step removes`, () => {
    const created = volumesIn(jobName, 'docker volume create');
    const removed = volumesIn(jobName, 'docker volume rm');
    assert.ok(created.size > 0, `job "${jobName}" creates no volumes — the setup step has moved or changed shape`);
    const leaked = [...created].filter((v) => !removed.has(v));
    assert.deepEqual(
      leaked,
      [],
      `job "${jobName}" creates ${JSON.stringify(leaked)} but never removes them, so their contents\n` +
        '  survive from one run to the next on the persistent runner. Measured 2026-09-05: the redis\n' +
        '  volume carried an RDB v15 dump from a redis 8.10.1 run into a redis 8.6.2 run, which could\n' +
        '  not load it, and `main` went red at bring-up on a commit that did not touch redis.',
    );
  });

  test(`${jobName}: the reset step runs BEFORE the compose stacks come up`, () => {
    const steps = stepsOf(jobName);
    const resetIndex = steps.findIndex((s) => typeof s?.run === 'string' && s.run.includes('docker volume rm'));
    // Bring-up is delegated to scripts, so the step is recognised by its name rather than its shell.
    const upIndex = steps.findIndex((s) => typeof s?.name === 'string' && /^Bring up\b/.test(s.name));
    assert.ok(resetIndex >= 0, `job "${jobName}" has no reset step`);
    assert.ok(upIndex >= 0, `job "${jobName}" has no "Bring up …" step`);
    assert.ok(
      resetIndex < upIndex,
      `job "${jobName}" brings the stacks up (step ${upIndex}) before resetting stateful data (step ${resetIndex})`,
    );
  });
}
