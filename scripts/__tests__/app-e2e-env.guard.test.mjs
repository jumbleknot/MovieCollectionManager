// Feature 051 US1 — the web E2E environment-forwarding contract.
//
// `docker run` forwards ONLY the variables named with `-e`. A variable set at job level and not
// named is simply invisible inside the container — and every gate the web E2E suite applies is
// driven by such a variable. So an omission does not produce an error. It produces a SILENT SKIP and
// a green required gate.
//
// Two of them were live at once, for the entire lifetime of the `app-e2e` job:
//
//   E2E_AGENT_PRODUCTION            set at job level, never forwarded → every agent-*.spec.ts skipped
//   KEYCLOAK_SERVICE_CLIENT_SECRET  absent from the job env AND the -e list → admin-settings-access.spec.ts
//                                   and admin-registration.spec.ts skipped
//
// Neither was a broken assertion or a flaky run. The suite reported success, the gate went green,
// and the agent surface that `mcm` exists to ship was never exercised by CI at all.
//
// This is a GUARD, not a one-time edit. The omission survived that long precisely because nothing
// asserted it — a workflow file has no type checker, and a reviewer reading a 20-line `docker run`
// cannot see a variable that is not there. The contract is
// specs/051-ci-diagnostics-closure/contracts/e2e-env-forwarding.md.
//
// Deterministic, offline, token-free, node: built-ins only — it runs in the `guardrails / naming`
// container with no forge access and no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const APP_CI = readFileSync(resolve(REPO_ROOT, '.forgejo/workflows/app-ci.yml'), 'utf8');

/**
 * The `docker run` invocation that starts the Playwright container, as one whitespace-collapsed
 * string with its shell line-continuations joined.
 *
 * Scoped to the invocation rather than the whole file on purpose: `-e ANTHROPIC_API_KEY` appears
 * elsewhere in this workflow, so a file-wide `includes()` would report a flag as forwarded when it
 * is forwarded into a DIFFERENT container. That is the same read-it-and-it-looks-right failure the
 * guard exists to replace.
 */
function playwrightDockerRunStart() {
  const lines = APP_CI.split(/\r?\n/);
  // Anchor on the IMAGE and walk back to its `docker run`. Anchoring on `docker run --network host`
  // instead finds an earlier, unrelated invocation in this job — which is how a guard ends up
  // asserting confidently about the wrong container.
  const image = lines.findIndex((l) => l.includes('mcr.microsoft.com/playwright'));
  assert.notEqual(image, -1, 'no Playwright image reference in app-ci.yml');

  let start = image;
  while (start >= 0 && !/docker run\b/.test(lines[start])) start -= 1;
  assert.ok(start >= 0, 'found the Playwright image but no `docker run` above it');
  return { lines, start };
}

function playwrightDockerRun() {
  const { lines, start } = playwrightDockerRunStart();
  const collected = [lines[start]];
  for (let i = start; lines[i]?.trimEnd().endsWith('\\'); i += 1) collected.push(lines[i + 1] ?? '');
  const joined = collected.join(' ').replace(/\\\s+/g, ' ').replace(/\s+/g, ' ');

  assert.match(joined, /mcr\.microsoft\.com\/playwright/, 'located a docker run, but not the Playwright one');
  assert.match(joined, /playwright test/, 'the located invocation does not run the Playwright suite');
  return joined;
}

/** The `env:` block of the `app-e2e` job, as text — up to the job's `steps:`. */
function appE2eJobEnv() {
  const lines = APP_CI.split(/\r?\n/);
  const jobAt = lines.findIndex((l) => /^ {2}app-e2e:\s*$/.test(l));
  assert.notEqual(jobAt, -1, 'no `app-e2e:` job in app-ci.yml');

  const envAt = lines.findIndex((l, i) => i > jobAt && /^ {4}env:\s*$/.test(l));
  const stepsAt = lines.findIndex((l, i) => i > jobAt && /^ {4}steps:\s*$/.test(l));
  assert.ok(envAt !== -1 && envAt < stepsAt, 'the app-e2e job has no `env:` block before its `steps:`');
  return lines.slice(envAt, stepsAt).join('\n');
}

test('the Playwright container is handed E2E_AGENT_PRODUCTION — without it every agent spec skips', () => {
  // agentStackEnabled() tests process.env['E2E_AGENT_PRODUCTION'] === '1'. Set at job level and not
  // forwarded, it is undefined inside the container, so the gate takes its skip branch.
  assert.match(
    playwrightDockerRun(),
    /-e E2E_AGENT_PRODUCTION(?![=\w])/,
    'E2E_AGENT_PRODUCTION is not forwarded — every agent-*.spec.ts will skip and the gate will still be green',
  );
});

test('the Playwright container is handed E2E_REQUIRE_AGENT_STACK=1 — a missing stack must be loud', () => {
  // Un-gating without the require-flag only moves the failure mode from "always skips" to "skips
  // whenever the stack happens to be down" (contract invariant 2). agentStackRequired() is what turns
  // that second case into a failure instead of a quiet pass.
  assert.match(
    playwrightDockerRun(),
    /-e E2E_REQUIRE_AGENT_STACK=1\b/,
    'E2E_REQUIRE_AGENT_STACK=1 is not set — a down agent stack would skip silently instead of failing',
  );
});

test('the Playwright container is handed KEYCLOAK_SERVICE_CLIENT_SECRET — the admin specs gate on it', () => {
  assert.match(
    playwrightDockerRun(),
    /-e KEYCLOAK_SERVICE_CLIENT_SECRET(?![=\w])/,
    'KEYCLOAK_SERVICE_CLIENT_SECRET is not forwarded — admin-settings-access.spec.ts and admin-registration.spec.ts will skip',
  );
});

test('the app-e2e job DEFINES KEYCLOAK_SERVICE_CLIENT_SECRET from a secret', () => {
  // The `-e` flag alone forwards nothing when the runner has nothing to forward. This secret is
  // absent from the job's env: block entirely, so the fix needs BOTH halves. It does exist in the
  // forge — the same workflow already consumes it for the integration step.
  assert.match(
    appE2eJobEnv(),
    /^\s*KEYCLOAK_SERVICE_CLIENT_SECRET:\s*\$\{\{\s*secrets\.\w+\s*\}\}\s*$/m,
    'the app-e2e job env: block does not define KEYCLOAK_SERVICE_CLIENT_SECRET, so `-e` would forward nothing',
  );
});

test('no secret is forwarded in `-e NAME=$NAME` form — that would put its value on the command line', () => {
  // Contract invariant 1. `-e NAME` forwards the runner's value; `-e NAME=$NAME` expands it into
  // argv, where it reaches process listings and step logs. The argv-secret gate in
  // `guardrails / naming` exists for exactly this class of mistake; this asserts it locally, at the
  // one invocation where a well-meaning "just make it explicit" edit is most likely.
  const invocation = playwrightDockerRun();
  const assigned = [...invocation.matchAll(/-e (\w+)=(\S+)/g)];
  for (const [, name, value] of assigned) {
    assert.ok(
      !/^\$/.test(value) && !/^["']?\$\{/.test(value),
      `-e ${name}=${value} expands a value into argv — use the pass-through form \`-e ${name}\``,
    );
    assert.ok(
      !/SECRET|TOKEN|PASSWORD|API_KEY/i.test(name),
      `-e ${name}=… places a credential-shaped variable on the command line — use \`-e ${name}\``,
    );
  }
});

test('the deliberately-unforwarded set is documented beside the invocation, not just in the contract', () => {
  // FR-003's enumeration turned up four variables the suite reads and CI correctly does not forward.
  // Without the reasons written down HERE, the next reader re-derives the table — or, worse, adds
  // them speculatively and changes what the merge gate actually tests.
  const { lines, start } = playwrightDockerRunStart();
  const nearby = lines.slice(Math.max(0, start - 30), start).join('\n');
  for (const name of ['KEYCLOAK_URL', 'E2E_AGENT_OLLAMA_URL', 'E2E_LARGE_LIBRARY']) {
    assert.ok(
      nearby.includes(name),
      `${name} is deliberately not forwarded, but no comment near the invocation says so`,
    );
  }
});

// ── The result gate (item #150 follow-up) ────────────────────────────────────────────────────────
//
// Forwarding the right env vars is only half of "no silent skip". The other half is checking, after
// the fact, that nothing WAS skipped — because Playwright exits 0 with tests skipped, the forge API
// exposes no job logs, and the failure digest publishes only on failure. Without the gate step, a
// passing run's counts are unreadable by anyone and "green" says nothing about how many tests ran.

test('the app-e2e job gates on the web E2E counts, so a green run cannot hide a skip', () => {
  assert.match(
    APP_CI,
    /e2e-failure-set\.mjs gate/,
    'the `E2E result gate` step is gone. Without it, `skipped=33` exits 0 and reports success — ' +
      'exactly how feature 040 validated green while five agent specs were hidden (item #150).',
  );
});

test('the result gate runs even when the web E2E failed, and reads that step\'s captured log', () => {
  const step = APP_CI.slice(APP_CI.indexOf('- name: E2E result gate'));
  const block = step.slice(0, step.indexOf('# ── Contention tally'));
  assert.match(block, /if: \$\{\{ always\(\) \}\}/, 'the gate must run on failure too — that is when the counts matter most');
  assert.match(
    block,
    /mcm-ci-step-logs\/\$GITHUB_RUN_ID\/web-e2e\.log/,
    'the gate must read the run-scoped step log ci-log-step.sh writes; a bare or unscoped path ' +
      'would read a PREVIOUS run on this persistent runner and pass on stale counts.',
  );
});
