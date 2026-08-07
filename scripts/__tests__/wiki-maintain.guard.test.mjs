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

// ── the runner has to actually have the generator ───────────────────────────────

test('the workflow installs the generator, pinned to the dev container version', () => {
  // The first real run on `main` died with `/bin/sh: 1: openwiki: not found`. The generator is a
  // GLOBAL npm binary baked into the dev container's toolchain image, not a workspace dependency, so
  // nothing put it on the CI runner. The orchestrator planned correctly and then had nothing to call.
  const install = raw.match(/npm install -g openwiki@([\d.]+)/);
  assert.ok(install, 'the workflow must install the generator');

  const dockerfile = readFileSync(join(REPO_ROOT, '.devcontainer', 'toolchain.Dockerfile'), 'utf8');
  const pinned = dockerfile.match(/npm install -g openwiki@([\d.]+)/);
  assert.ok(pinned, 'the dev container pins a version');
  assert.equal(install[1], pinned[1],
    'CI and the dev container must run the SAME generator version — otherwise they silently differ on the thing whose output is gated');
});

// ── injection (found by semgrep on this workflow's first CI run) ────────────────

test('no dispatch input is interpolated into a run block', () => {
  // `${{ … }}` is substituted into the shell SOURCE before the shell runs, so an input containing
  // `;` or `$(…)` executes as code. Inputs must arrive as environment variables and be quoted.
  const runBlocks = [...raw.matchAll(/^\s+run: \|([\s\S]*?)(?=\n\s+- name:|\n\s*$)/gm)].map((m) => m[1]);
  assert.ok(runBlocks.length > 0, 'the workflow has run blocks');
  for (const block of runBlocks) {
    assert.ok(!/\$\{\{\s*github\.event\.inputs/.test(block),
      `a dispatch input is interpolated into a run block:\n${block.slice(0, 200)}`);
  }
});

test('dispatch inputs are validated, not merely quoted', () => {
  // An operator-supplied value should be REJECTED for being malformed, not silently rendered inert.
  assert.match(raw, /INPUT_MAX_SLICES:/);
  assert.match(raw, /INPUT_SINCE:/);
  assert.match(raw, /must be a positive integer/);
  assert.match(raw, /must be a git ref/);
});

// ── credentials (FR-023, FR-024, FR-025) ────────────────────────────────────────

test('only pre-existing secrets are referenced, and they stay distinct', () => {
  const referenced = [...raw.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]);
  // Updated 2026-08-07 (feature 048 US4). The model credential moved from the shared
  // `ANTHROPIC_API_KEY` to the per-surface `ANTHROPIC_API_WIKI_MAINTAIN`: one secret backed three
  // unrelated surfaces (this workflow, app-ci's app-e2e job, and app-ci's dast job), so Anthropic
  // console spend conflated them and no one could say what a wiki run costs versus a CI run.
  // This guard still says what it always said — the workflow may not MINT a secret. It may only
  // reference one that already exists in Forgejo Actions Secrets, and `ANTHROPIC_API_WIKI_MAINTAIN`
  // was provisioned by the product owner before this change landed.
  // Note the ENV VAR name is deliberately unchanged (048 FR-015) — only the secret behind it moved,
  // which is why the FR-025 distinctness assertions below still read `ANTHROPIC_API_KEY:`.
  const allowed = new Set(['ANTHROPIC_API_WIKI_MAINTAIN', 'CD_PUSH_TOKEN', 'CI_DIGEST_TOKEN']);
  for (const name of referenced) {
    assert.ok(allowed.has(name), `${name} is not one of the secrets this feature promised not to add to`);
  }
  assert.ok(referenced.includes('ANTHROPIC_API_WIKI_MAINTAIN'), 'the model credential');
  assert.ok(referenced.includes('CD_PUSH_TOKEN'), 'the write credential');
  // 048 FR-017: the retired shared key must not linger here once the split has landed.
  assert.ok(!referenced.includes('ANTHROPIC_API_KEY'),
    'the shared ANTHROPIC_API_KEY secret was retired by 048 US4 — this surface has its own');
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

// ── the generator's per-turn output ceiling (research 2026-08-01) ────────────────
//
// THIS IS THE GUARD FOR THE BUG THAT LOOKED LIKE NON-DETERMINISM.
//
// openwiki never passes `maxTokens`, so `@langchain/anthropic` resolves a per-turn output cap by
// PREFIX-MATCHING the configured model id against a hard-coded table, falling back to 4096 on a miss.
// `claude-sonnet-5` — which this target pinned for the whole of feature 044 — is absent from that
// table, so every turn was capped at 4096. A turn truncated at the cap BEFORE it opens a `tool_use`
// block returns an assistant message with zero tool calls, and zero tool calls is precisely
// LangGraph's ReAct stop condition: the graph exits cleanly, openwiki exits 0, Nx reports success,
// and no page is written. That was the measured ~50% zero-page rate.
//
// Nothing in the stack reports this. Not openwiki, which never inspects `stop_reason`; not Nx, which
// sees exit 0; not the verifier, which can say a page is missing but never why. The failure is
// therefore INVISIBLE UNTIL SOMEONE MEASURES THE WIRE — which is exactly the class of property this
// file exists to pin down.
//
// A model rename, an openwiki upgrade, or a LangChain upgrade can reintroduce it in one line. So the
// check is mechanical: resolve the pinned id through the INSTALLED table and fail on the fallback.
// Offline, token-free, no API call.

const PROJECT_JSON = join(REPO_ROOT, 'infrastructure-as-code', 'project.json');
const MIN_OUTPUT_TOKENS = 16_384;
const LANGCHAIN_FALLBACK_TOKENS = 4096;

/** The id the generator will actually run with. */
function pinnedModelId() {
  const project = JSON.parse(readFileSync(PROJECT_JSON, 'utf8'));
  return project.targets['wiki-update'].options.env.OPENWIKI_MODEL_ID;
}

/**
 * Resolve a model id the way `@langchain/anthropic` does, reading ITS table rather than a copy —
 * a copy would drift and then agree with itself while the real cap moved.
 */
function resolveMaxOutputTokens(modelId) {
  const source = readFileSync(
    '/usr/local/lib/node_modules/openwiki/node_modules/@langchain/anthropic/dist/chat_models.js',
    'utf8',
  );
  const table = source.match(/const MODEL_DEFAULT_MAX_OUTPUT_TOKENS = \{([\s\S]*?)\n\};/);
  assert.ok(table, 'could not locate the max-output-token table — the upstream shape changed, re-verify by hand');
  const entries = [...table[1].matchAll(/"([^"]+)":\s*(\d+)/g)].map((m) => [m[1], Number(m[2])]);
  const hit = entries.find(([prefix]) => modelId.startsWith(prefix));
  return { tokens: hit ? hit[1] : LANGCHAIN_FALLBACK_TOKENS, matched: hit?.[0] ?? null };
}

test('the pinned generator model does NOT fall back to the 4096-token per-turn cap', (t) => {
  let resolved;
  try {
    resolved = resolveMaxOutputTokens(pinnedModelId());
  } catch (error) {
    // The guard is only meaningful where openwiki is installed. Skipping is honest; passing is not.
    t.skip(`openwiki not installed here (${error.code ?? error.message}) — cannot resolve the cap`);
    return;
  }
  const id = pinnedModelId();
  assert.notEqual(
    resolved.matched,
    null,
    `OPENWIKI_MODEL_ID="${id}" matches NO prefix in @langchain/anthropic's table, so it silently gets ` +
      `${LANGCHAIN_FALLBACK_TOKENS} output tokens per turn. That is the defect that made the generator ` +
      `write nothing ~half the time. Pin a model the table covers, or set maxTokens explicitly upstream.`,
  );
  assert.ok(
    resolved.tokens >= MIN_OUTPUT_TOKENS,
    `OPENWIKI_MODEL_ID="${id}" resolves to ${resolved.tokens} output tokens per turn (via prefix ` +
      `"${resolved.matched}"), below the ${MIN_OUTPUT_TOKENS} a page-writing turn needs.`,
  );
});

test('the target records WHY the model is pinned, so it is not "tidied" back', () => {
  // The one-line change that reintroduces this bug is indistinguishable from a routine model bump
  // unless the reason travels with the value.
  const project = JSON.parse(readFileSync(PROJECT_JSON, 'utf8'));
  const description = project.targets['wiki-update'].metadata.description;
  assert.match(description, /maxTokens|max_tokens|output cap|per-turn/i, 'the token cap must be named');
  assert.match(description, /4096/, 'and the specific fallback that bit us');
});
