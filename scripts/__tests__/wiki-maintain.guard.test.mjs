// T032 — shape guard for .forgejo/workflows/wiki-maintain.yml (feature 044, US2).
//
// Follows the agent-stack.guard.test.mjs / zap-scan.guard.test.mjs precedent: assert the workflow's
// SHAPE statically rather than by running CI. The properties below are the ones whose absence is
// invisible until the day they matter — a debounce that does not debounce, a maximum deferral that
// never fires, a self-triggering run, a secret that should not be there.
//
// Deterministic, offline, token-free, `node:` built-ins + `yaml`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

import { shouldDeferMaintenance, MAX_DEFERRAL_SECONDS, DEBOUNCE_SECONDS } from '../wiki-maintain.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW_PATH = join(REPO_ROOT, '.forgejo', 'workflows', 'wiki-maintain.yml');

const raw = readFileSync(WORKFLOW_PATH, 'utf8');
const wf = parse(raw);
const job = () => Object.values(wf.jobs)[0];
const steps = () => job().steps ?? [];
const stepText = () => steps().map((s) => `${s.name ?? ''}\n${s.run ?? ''}\n${JSON.stringify(s.env ?? {})}`).join('\n');

// ── triggers and debounce (FR-009, research R3) ─────────────────────────────────

test('the run is merge-triggered on the default branch', () => {
  assert.ok(wf.on.push, 'maintenance is merge-triggered');
  assert.deepEqual(wf.on.push.branches, ['main']);
});

test('workflow_dispatch exists so an operator can bypass the debounce', () => {
  assert.ok('workflow_dispatch' in wf.on, 'FR-009c: a manual run must not have to wait out the quiet period');
});

test('debounce is concurrency + cancel-in-progress + an initial wait', () => {
  // The debounce mechanism IS this trio: a new push cancels the waiting run and starts a fresh
  // waiter, so the work proceeds only after ~15 quiet minutes. Without cancel-in-progress the waits
  // stack up and every push in a burst eventually runs — the opposite of debouncing.
  assert.ok(wf.concurrency, 'a debounce needs a concurrency group');
  assert.equal(wf.concurrency['cancel-in-progress'], true);
  assert.match(String(wf.concurrency.group), /wiki-maintain/);
  assert.match(stepText(), /sleep/, 'and an initial wait for the quiet period');
});

test('there is no schedule trigger — freshness is merge-driven, not periodic', () => {
  assert.ok(!('schedule' in wf.on), 'a periodic sweep would pay for runs nothing changed under');
});

// ── maximum deferral (FR-009b) ──────────────────────────────────────────────────

test('a maximum-deferral step exists and is git-derived', () => {
  // A busy day would otherwise starve maintenance exactly when drift is fastest. The age must come
  // from git, not from a timer held in the cancelled run — cancellation is what destroys that state.
  assert.match(stepText(), /deferral|deferred|oldest/i, 'the workflow must compute a maximum deferral');
  assert.match(stepText(), /wiki-maintain\.mjs|git log/, 'and derive it from git rather than from run state');
});

test('the deferral decision defers below the threshold and runs at or above it', () => {
  assert.equal(shouldDeferMaintenance({ oldestUncoveredAgeSeconds: 0 }).defer, true);
  assert.equal(shouldDeferMaintenance({ oldestUncoveredAgeSeconds: MAX_DEFERRAL_SECONDS - 1 }).defer, true);
  assert.equal(shouldDeferMaintenance({ oldestUncoveredAgeSeconds: MAX_DEFERRAL_SECONDS }).defer, false,
    'at the threshold the run must proceed — otherwise a never-quiet merge stream never runs');
  assert.equal(shouldDeferMaintenance({ oldestUncoveredAgeSeconds: MAX_DEFERRAL_SECONDS * 2 }).defer, false);
  assert.equal(shouldDeferMaintenance({ oldestUncoveredAgeSeconds: null }).defer, true,
    'nothing uncovered means nothing to hurry for');
  assert.equal(shouldDeferMaintenance({ oldestUncoveredAgeSeconds: 0, dispatched: true }).defer, false,
    'a manual dispatch bypasses the wait entirely (FR-009c)');
  assert.ok(MAX_DEFERRAL_SECONDS > DEBOUNCE_SECONDS, 'the ceiling must be longer than the quiet period it overrides');
});

// ── self-trigger guard (FR-009a) ────────────────────────────────────────────────

test('the run does not trigger itself', () => {
  // Two ways it would: the `[skip ci]` marker commit it pushes to main, and a bundle-only change
  // (its own proposal being merged). SC-005a requires a merged proposal to produce no further run.
  const text = `${stepText()}\n${raw}`;
  assert.match(text, /skip ci/, 'the marker commit must be recognised or marked as skippable');
  assert.match(text, /openwiki/, 'and a bundle-only change must be recognised');
  assert.match(text, /exit 0|SKIP|skip/i);
});

// ── budget and timeout (C6) ─────────────────────────────────────────────────────

test('the job timeout sits above the declared effective ceiling', () => {
  assert.equal(job()['timeout-minutes'], 45, '≤24 pages / ~37 min plus checkout and install overhead');
});

// ── credentials (FR-023, FR-024, FR-025) ────────────────────────────────────────

test('only pre-existing secrets are referenced, and they stay distinct', () => {
  const referenced = [...raw.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]);
  const allowed = new Set(['ANTHROPIC_API_KEY', 'CD_PUSH_TOKEN', 'CI_DIGEST_TOKEN']);
  for (const name of referenced) {
    assert.ok(allowed.has(name), `${name} is not one of the secrets this feature promised not to add to`);
  }
  assert.ok(referenced.includes('ANTHROPIC_API_KEY'), 'the model credential');
  assert.ok(referenced.includes('CD_PUSH_TOKEN'), 'the write credential');
  // FR-025: the model credential and the write credential must never stand in for one another.
  assert.doesNotMatch(raw, /ANTHROPIC_API_KEY:\s*\$\{\{\s*secrets\.CD_PUSH_TOKEN/);
  assert.doesNotMatch(raw, /(FORGE_TOKEN|GIT_TOKEN):\s*\$\{\{\s*secrets\.ANTHROPIC_API_KEY/);
});

test('no credential literal appears in the file', () => {
  assert.doesNotMatch(raw, /sk-ant-/, 'a model key must only ever be a store reference');
  assert.doesNotMatch(raw, /--env\s+[A-Z_]*(TOKEN|KEY|SECRET|PASSWORD)=/, 'and never travel on a command line');
});

// ── evidence and required-context posture (FR-018, FR-019) ──────────────────────

test('the job publishes a feature-042 failure digest', () => {
  const digest = steps().find((s) => /ci-failure-digest\.mjs/.test(s.run ?? ''));
  assert.ok(digest, 'every new job owes a digest, or check-ci-digest-coverage.mjs fails the build');
  assert.match(String(digest.if), /always\(\)/);
  assert.equal(digest['continue-on-error'], true, 'a digest step must never change the job outcome');
  assert.match(JSON.stringify(digest.env ?? {}), /CI_DIGEST_JOB_STATUS/);
});

test('the outcome is reported distinguishably, including exit 3', () => {
  const text = stepText();
  assert.match(text, /nothing-to-do/, 'FR-017: the three outcomes must be distinguishable');
  assert.match(text, /\b3\b/, 'and a budget stop (exit 3) must not be reported as a failure');
});
