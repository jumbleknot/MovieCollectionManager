// Guard: the OPT-IN full mobile suite in app-ci's app-e2e job (item #254 follow-on).
//
// What it pins, and why each part is load-bearing:
//   * OPT-IN ONLY. Every PR and push must keep running the agent flows alone — the full suite adds
//     ~half an hour to a capacity-1 runner. A trigger expression that defaulted to `full` would read
//     as a harmless tidy-up and cost every PR that half hour.
//   * The label must ALSO force the mobile half on. The emulator steps are gated on the `mobile`
//     paths filter OR a label; a `mobile-e2e-full` label that set MOBILE_SUITE=full without opening
//     that gate would select a suite that never runs — a green tick for nothing.
//   * ONE flow selection, shared with the local suite. A second hand-kept list drifts; and an agent
//     flow run twice (once by each script) is both wasted runner time and a duplicate server-side
//     mutation the agent half's ordering does not expect.
//
// The trigger expressions are EVALUATED, not string-matched: this forge exposes no jobs/steps
// endpoint, so a green run cannot show which arm of an expression fired.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import {
  CI_FULL_EXCLUDED, FLOWS_DIR, MANUAL_FLOWS, ciFullFlows, isAgentFlow, localSuiteFlows,
} from '../mobile-flows.mjs';
import { COUNTS_SOURCES } from '../ci-failure-digest.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW_TEXT = readFileSync(resolve(REPO_ROOT, '.forgejo/workflows/app-ci.yml'), 'utf8');
const workflow = parseYaml(WORKFLOW_TEXT);
const job = workflow?.jobs?.['app-e2e'];
const AGENT_SCRIPT = readFileSync(resolve(REPO_ROOT, 'scripts/ci-mobile-agent-flows.sh'), 'utf8');
const FULL_SCRIPT_PATH = resolve(REPO_ROOT, 'scripts/ci-mobile-full-flows.sh');
const LOCAL_RUNNER = readFileSync(resolve(REPO_ROOT, 'frontend/mcm-app/scripts/maestro-e2e.mjs'), 'utf8');

/**
 * Evaluate a `${{ … }}` expression from this workflow for one event shape. Supports exactly the
 * vocabulary the mobile triggers use; anything else THROWS rather than evaluating to something —
 * an unrecognised term silently read as `undefined` is how a guard passes while checking nothing.
 */
function evaluate(expr, ctx) {
  const m = String(expr).match(/^\$\{\{([\s\S]*)\}\}$/);
  assert.ok(m, `not an expression: ${expr}`);
  const q = (v) => JSON.stringify(v ?? '');
  let js = m[1]
    .replace(/contains\(github\.event\.pull_request\.labels\.\*\.name,\s*'([^']+)'\)/g,
      (_, l) => String((ctx.labels ?? []).includes(l)))
    .replace(/github\.event_name/g, q(ctx.event))
    .replace(/github\.event\.inputs\.mobile_suite/g, q(ctx.mobileSuite))
    .replace(/needs\.changes\.outputs\.mobile/g, q(ctx.mobileFilter ?? 'false'))
    .replace(/env\.MOBILE_SUITE/g, q(ctx.MOBILE_SUITE))
    .replace(/\b(always|failure)\(\)/g, (_, f) => String(f === 'always' ? true : !!ctx.failed))
    .replace(/'([^']*)'/g, (_, s) => JSON.stringify(s));
  assert.doesNotMatch(js, /[A-Za-z_]+\.[A-Za-z_]/, `unhandled term left in expression: ${js}`);
  return Function(`"use strict"; return (${js});`)();
}

const EVENTS = {
  push: { event: 'push' },
  pr: { event: 'pull_request', mobileFilter: 'true' },
  prNoMobilePaths: { event: 'pull_request', mobileFilter: 'false' },
  prMobileLabel: { event: 'pull_request', mobileFilter: 'false', labels: ['mobile-e2e'] },
  prFullLabel: { event: 'pull_request', mobileFilter: 'false', labels: ['mobile-e2e-full'] },
  dispatchDefault: { event: 'workflow_dispatch', mobileSuite: 'agents' },
  dispatchFull: { event: 'workflow_dispatch', mobileSuite: 'full' },
};

const mobileSuite = (ctx) => evaluate(job.env.MOBILE_SUITE, ctx);
const emulatorStep = () => job.steps.find((s) => String(s.uses ?? '').startsWith('reactivecircus/android-emulator-runner'));

/** The flows ci-mobile-agent-flows.sh runs: its `flows=( … )` array plus the trailing admin flow. */
function agentScriptFlows() {
  const arr = AGENT_SCRIPT.match(/^flows=\(\n([\s\S]*?)\n\)/m);
  assert.ok(arr, 'could not find the flows=( … ) array in ci-mobile-agent-flows.sh');
  const listed = arr[1].split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const extra = [...AGENT_SCRIPT.matchAll(/^until run_flow ([a-z0-9-]+);/gm)].map((x) => x[1]);
  assert.ok(listed.length >= 5 && extra.length >= 1, `agent-script parse looks wrong: ${listed} + ${extra}`);
  return [...listed, ...extra];
}

test('a workflow_dispatch input selects the suite, defaulting to agents', () => {
  const input = workflow?.on?.workflow_dispatch?.inputs?.mobile_suite;
  assert.ok(input, 'no mobile_suite workflow_dispatch input');
  assert.equal(input.type, 'choice');
  assert.deepEqual(input.options, ['agents', 'full']);
  assert.equal(input.default, 'agents', 'a dispatch that does not ask for the full suite must not get it');
});

test('MOBILE_SUITE is `agents` for every ordinary run, `full` only on an explicit opt-in', () => {
  assert.ok(job?.env?.MOBILE_SUITE, 'app-e2e sets no MOBILE_SUITE');
  for (const k of ['push', 'pr', 'prNoMobilePaths', 'prMobileLabel', 'dispatchDefault']) {
    assert.equal(mobileSuite(EVENTS[k]), 'agents', `${k} selected the full suite without opting in`);
  }
  for (const k of ['prFullLabel', 'dispatchFull']) {
    assert.equal(mobileSuite(EVENTS[k]), 'full', `${k} did not select the full suite`);
  }
});

test('the mobile-e2e-full label also opens every mobile gate (APK build, Maestro, emulator, upload)', () => {
  const gated = job.steps.filter((s) => /needs\.changes\.outputs\.mobile/.test(String(s.if ?? '')));
  assert.ok(gated.length >= 4, `expected >= 4 mobile-gated steps, found ${gated.length}`);
  for (const s of gated) {
    const ctx = { ...EVENTS.prFullLabel, failed: true };
    assert.equal(evaluate(s.if, ctx), true, `"${s.name}" stays closed for a PR labelled mobile-e2e-full`);
    // ...and the ordinary closed case is still closed: no label, no mobile paths.
    assert.equal(evaluate(s.if, { ...EVENTS.prNoMobilePaths, failed: true }), false,
      `"${s.name}" opened for a PR with neither mobile paths nor a label — the default changed`);
  }
});

test('the job ceiling is 75 min by default and raised only for the full suite', () => {
  const t = job['timeout-minutes'];
  for (const k of ['push', 'pr', 'prMobileLabel', 'dispatchDefault']) assert.equal(evaluate(t, EVENTS[k]), 75, k);
  for (const k of ['prFullLabel', 'dispatchFull']) assert.equal(evaluate(t, EVENTS[k]), 110, k);
});

test('the emulator runs the agent half first, then the full suite only when MOBILE_SUITE=full', () => {
  const lines = String(emulatorStep()?.with?.script ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const agent = lines.findIndex((l) => /ci-log-step\.sh maestro-agent-flows bash scripts\/ci-mobile-agent-flows\.sh/.test(l));
  const full = lines.findIndex((l) => /ci-log-step\.sh maestro-full-flows bash scripts\/ci-mobile-full-flows\.sh/.test(l));
  assert.ok(agent >= 0, 'the agent flows are no longer run on the emulator');
  assert.ok(full > agent, 'the full suite must run AFTER the agent half (it relies on its admin flow finishing first)');
  assert.match(lines[full], /^if \[ "\$MOBILE_SUITE" = full \]; then /, 'the full suite is not gated on MOBILE_SUITE=full');
});

test('the full-suite results table is published (wrapped step + counts source)', () => {
  const step = job.steps.find((s) => /maestro-full-results/.test(String(s.run ?? '')));
  assert.ok(step, 'no wrapped maestro-full-results step');
  assert.equal(evaluate(step.if, { MOBILE_SUITE: 'full' }), true);
  assert.equal(evaluate(step.if, { MOBILE_SUITE: 'agents' }), false, 'the results step runs outside full mode');
  assert.ok(COUNTS_SOURCES.includes('step:maestro-full-results'),
    'a green full run would publish no per-flow table — the forge exposes no job log');
});

test('the full selection is the local suite minus agent flows, MANUAL_FLOWS and justified exclusions', () => {
  const local = localSuiteFlows().map((p) => p.replace(/^.*[\\/]/, '').replace(/\.yaml$/, ''));
  const full = ciFullFlows();
  assert.ok(full.length >= 20, `only ${full.length} full-mode flows — the selector is broken`);
  for (const must of ['login-keycloak', 'movie-add', 'collection-create', 'settings-nav']) {
    assert.ok(full.includes(must), `${must} is missing from the full suite`);
  }
  for (const f of MANUAL_FLOWS) assert.ok(!full.includes(f.replace(/\.yaml$/, '')), `${f} must stay manual`);
  for (const f of full) {
    assert.ok(!isAgentFlow(f), `${f} is an agent flow — the agent half owns those`);
    assert.ok(!f.startsWith('_'), `${f} is a helper, not a flow`);
    assert.ok(local.includes(f), `${f} is not in the local e2e:mobile suite — the two selections diverged`);
  }
  assert.equal(new Set(full).size, full.length, 'a flow appears twice in the full suite');
  for (const [name, reason] of CI_FULL_EXCLUDED) {
    assert.ok(existsSync(resolve(FLOWS_DIR, `${name}.yaml`)), `excluded flow ${name} does not exist — stale entry`);
    assert.ok(String(reason).trim().length > 20, `exclusion ${name} carries no real reason`);
  }
  // Every local-suite flow is accounted for: run in full mode, owned by the agent side, or excluded.
  for (const f of local) {
    assert.ok(full.includes(f) || isAgentFlow(f) || CI_FULL_EXCLUDED.has(f), `${f} fell through every bucket`);
  }
});

test('no flow is run by BOTH the agent half and the full suite', () => {
  const agentRun = agentScriptFlows();
  assert.ok(agentRun.includes('admin-settings-access'), 'the agent script no longer runs admin-settings-access — re-check CI_FULL_EXCLUDED');
  const twice = ciFullFlows().filter((f) => agentRun.includes(f));
  assert.deepEqual(twice, [], `run twice: ${twice.join(', ')}`);
});

test('the local runner takes its flow list from the shared selector, not its own', () => {
  assert.match(LOCAL_RUNNER, /from '\.\.\/\.\.\/\.\.\/scripts\/mobile-flows\.mjs'/);
  assert.match(LOCAL_RUNNER, /localSuiteFlows\(/);
  assert.doesNotMatch(LOCAL_RUNNER, /MANUAL_FLOWS\s*=/, 'maestro-e2e.mjs defines its own MANUAL_FLOWS again');
  assert.doesNotMatch(LOCAL_RUNNER, /readdirSync/, 'maestro-e2e.mjs lists the flows directory itself again');
});

test('the full-suite runner hands each flow a logged-out app, resets the admin SSO, and keeps secrets off argv', () => {
  assert.ok(existsSync(FULL_SCRIPT_PATH), 'scripts/ci-mobile-full-flows.sh is missing');
  const s = readFileSync(FULL_SCRIPT_PATH, 'utf8');
  assert.match(s, /node scripts\/mobile-flows\.mjs ci-full/, 'the CI runner does not use the shared selector');
  assert.match(s, /pm clear "\$APP_ID"/, 'no per-attempt app reset — clearState:false flows would start logged in');
  const loop = s.indexOf('for flow in');
  assert.ok(loop > 0 && s.lastIndexOf('reset_chrome_sso', loop) > 0,
    'no Chrome SSO reset before the batch — every flow would re-auth as the admin the agent half left');
  assert.match(s, /bash scripts\/maestro-run\.sh /, 'flows must go through maestro-run.sh (secrets via env, not argv)');
  assert.doesNotMatch(s, /--env\s+"?(E2E_TEST_PASSWORD|E2E_TEST_USER|ANTHROPIC_API_KEY|TMDB_API_KEY)=/,
    'a credential is passed on the maestro argv');
  for (const p of ['scripts/ci-mobile-full-flows.sh', 'scripts/ci-mobile-lib.sh', 'scripts/mobile-flows.mjs']) {
    const filters = parseYaml(job ? workflow.jobs.changes.steps.find((x) => x?.with?.filters).with.filters : '');
    assert.ok(filters.app.includes(p) && filters.mobile.includes(p), `${p} must be in BOTH the app and mobile filters`);
  }
});
