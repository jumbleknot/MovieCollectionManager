// Feature 078 — which model writes the wiki is CONFIGURATION, resolved in one pure place.
//
// Why a module and not an env block: nx `run-commands` builds the child env as
// `{ ...process.env, ...targetEnv }` (nx 22.7.8, `processEnv`), so a provider set in the Nx target's
// `env` silently overwrites whatever the workflow exports (research R4). The choice therefore has to be
// resolved in-process, from a selector the target does NOT set.
//
// Deterministic, offline, token-free.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveWikiProvider,
  buildGeneratorEnv,
  WIKI_PROVIDERS,
  DEFAULT_WIKI_PROVIDER,
} from '../wiki-provider.mjs';

// ── the table (T005: US1-AC1/AC2, FR-001) ──────────────────────────────────────────────────────

test('unset selector resolves to the default, which is Anthropic until the FR-002 flip', () => {
  assert.equal(DEFAULT_WIKI_PROVIDER, 'anthropic');
  const p = resolveWikiProvider({});
  assert.equal(p.provider, 'anthropic');
  assert.equal(p.openwikiProvider, 'anthropic');
  assert.equal(p.modelId, 'claude-sonnet-5');
});

test('fireworks resolves to DeepSeek V4.1 Flash on the fireworks provider', () => {
  const p = resolveWikiProvider({ MCM_WIKI_PROVIDER: 'fireworks' });
  assert.equal(p.provider, 'fireworks');
  assert.equal(p.openwikiProvider, 'fireworks');
  assert.equal(p.modelId, 'accounts/fireworks/models/deepseek-v4p1-flash');
});

test('an unknown selector is REJECTED, never read as "the other provider"', () => {
  // A mis-typed selector that silently fell back would bill the wrong vendor with no signal — the
  // rejecting-parser rule this repository learned from --dry-run meaning "do it for real".
  for (const bad of ['Fireworks', 'deepseek', 'anthropic ', ' ']) {
    assert.throws(() => resolveWikiProvider({ MCM_WIKI_PROVIDER: bad }), /MCM_WIKI_PROVIDER.*anthropic.*fireworks/s, `"${bad}"`);
  }
});

test('every provider row names its model and the credential names it accepts', () => {
  for (const [name, row] of Object.entries(WIKI_PROVIDERS)) {
    assert.ok(row.modelId, `${name}: model id`);
    assert.ok(row.openwikiProvider, `${name}: openwiki provider`);
    assert.ok(row.credential.accepted.length >= 1, `${name}: at least one accepted credential name`);
    assert.ok(row.credential.mapTo, `${name}: the name the generator reads`);
  }
  // The Anthropic list is item #209's lesson, kept verbatim: both names, raw first.
  assert.deepEqual(WIKI_PROVIDERS.anthropic.credential.accepted, ['ANTHROPIC_API_KEY', 'MCM_ANTHROPIC_API_KEY']);
  assert.deepEqual(WIKI_PROVIDERS.fireworks.credential.accepted, ['FIREWORKS_API_KEY', 'MCM_FIREWORKS_API_KEY']);
});

test('an EMPTY value means unset — how an Actions repository variable that was never set arrives', () => {
  // `${{ vars.X }}` renders an unset variable as ''. Rejecting '' would fail every run on a repository
  // that simply has not set the variable; reading it as the default is what "unset" means.
  const p = resolveWikiProvider({ MCM_WIKI_PROVIDER: '', MCM_WIKI_SERVICE_TIER: '', MCM_WIKI_PAGE_CONCURRENCY: '' });
  assert.equal(p.provider, 'anthropic');
  assert.equal(p.tier, null);
  assert.equal(p.pageConcurrency, 1);
});

// ── service tier (FR-009) ──────────────────────────────────────────────────────────────────────

test('a service tier applies to fireworks only, and only known values are accepted', () => {
  assert.equal(resolveWikiProvider({ MCM_WIKI_PROVIDER: 'fireworks' }).tier, null);
  assert.equal(resolveWikiProvider({ MCM_WIKI_PROVIDER: 'fireworks', MCM_WIKI_SERVICE_TIER: 'priority' }).tier, 'priority');
  assert.throws(() => resolveWikiProvider({ MCM_WIKI_PROVIDER: 'fireworks', MCM_WIKI_SERVICE_TIER: 'fast' }), /MCM_WIKI_SERVICE_TIER/);
  assert.throws(() => resolveWikiProvider({ MCM_WIKI_SERVICE_TIER: 'priority' }), /anthropic/i,
    'a tier on a provider that has none must fail, not be ignored');
});

// ── reasoning effort (#525 trial, operator 2026-10-05) ─────────────────────────────────────────

test('a reasoning effort applies to fireworks only, and only the values Fireworks documents are accepted', () => {
  assert.equal(resolveWikiProvider({ MCM_WIKI_PROVIDER: 'fireworks' }).reasoningEffort, null, 'unset leaves the model default');
  for (const v of ['none', 'low', 'high', 'max']) {
    assert.equal(resolveWikiProvider({ MCM_WIKI_PROVIDER: 'fireworks', MCM_WIKI_REASONING_EFFORT: v }).reasoningEffort, v);
  }
  assert.equal(resolveWikiProvider({ MCM_WIKI_PROVIDER: 'fireworks', MCM_WIKI_REASONING_EFFORT: '' }).reasoningEffort, null,
    'an unset repository variable / dispatch input arrives as the empty string');
  assert.throws(() => resolveWikiProvider({ MCM_WIKI_PROVIDER: 'fireworks', MCM_WIKI_REASONING_EFFORT: 'medium' }), /MCM_WIKI_REASONING_EFFORT/,
    'a value Fireworks does not document for this model must fail, not be sent');
  assert.throws(() => resolveWikiProvider({ MCM_WIKI_REASONING_EFFORT: 'low' }), /anthropic/i,
    'an effort on a provider that has none must fail, not be ignored');
});

// ── page concurrency (T015d: FR-016, US5-AC1) ──────────────────────────────────────────────────

test('concurrency defaults to 1 and accepts 1..8', () => {
  assert.equal(resolveWikiProvider({}).pageConcurrency, 1);
  assert.equal(resolveWikiProvider({ MCM_WIKI_PAGE_CONCURRENCY: '4' }).pageConcurrency, 4);
  assert.equal(resolveWikiProvider({ MCM_WIKI_PAGE_CONCURRENCY: '8' }).pageConcurrency, 8);
});

test('an out-of-range or malformed concurrency fails BEFORE any paid work', () => {
  // Same rule as openwiki 0.6.0's own resolvePageConcurrency — checked here so a bad value fails in
  // our launcher rather than after the generator has been started.
  for (const bad of ['0', '9', '2.5', 'x', '-1', ' 4']) {
    assert.throws(() => resolveWikiProvider({ MCM_WIKI_PAGE_CONCURRENCY: bad }), /MCM_WIKI_PAGE_CONCURRENCY.*1.*8/s, `"${bad}"`);
  }
});

// ── the child environment (T007: US1-AC3, FR-003, FR-006) ─────────────────────────────────────

test('fireworks: the MCM_ credential is mapped at the point of use, and no Anthropic key rides along', () => {
  const child = buildGeneratorEnv({
    MCM_WIKI_PROVIDER: 'fireworks',
    MCM_FIREWORKS_API_KEY: 'fw-secret',
    MCM_ANTHROPIC_API_KEY: 'ant-secret',
    PATH: '/usr/bin',
  });
  assert.equal(child.FIREWORKS_API_KEY, 'fw-secret');
  assert.equal(child.OPENWIKI_PROVIDER, 'fireworks');
  assert.equal(child.OPENWIKI_MODEL_ID, 'accounts/fireworks/models/deepseek-v4p1-flash');
  assert.equal(child.ANTHROPIC_API_KEY, undefined, 'least privilege: the generator gets only the credential it uses');
  assert.equal(child.MCM_ANTHROPIC_API_KEY, undefined);
  assert.equal(child.PATH, '/usr/bin', 'everything unrelated passes through');
});

test('anthropic: today\'s behaviour — the MCM_ name is mapped to ANTHROPIC_API_KEY', () => {
  const child = buildGeneratorEnv({ MCM_ANTHROPIC_API_KEY: 'ant-secret' });
  assert.equal(child.ANTHROPIC_API_KEY, 'ant-secret');
  assert.equal(child.OPENWIKI_PROVIDER, 'anthropic');
  assert.equal(child.OPENWIKI_MODEL_ID, 'claude-sonnet-5');
});

test('the raw name wins over the MCM_ name when both are set (CI injects the raw name)', () => {
  const child = buildGeneratorEnv({ MCM_WIKI_PROVIDER: 'fireworks', FIREWORKS_API_KEY: 'raw', MCM_FIREWORKS_API_KEY: 'mcm' });
  assert.equal(child.FIREWORKS_API_KEY, 'raw');
});

test('a missing credential fails naming BOTH accepted names, and never echoes a value', () => {
  let message = '';
  try {
    buildGeneratorEnv({ MCM_WIKI_PROVIDER: 'fireworks', MCM_ANTHROPIC_API_KEY: 'ant-secret-value' });
  } catch (error) {
    message = error.message;
  }
  assert.match(message, /FIREWORKS_API_KEY/);
  assert.match(message, /MCM_FIREWORKS_API_KEY/);
  assert.doesNotMatch(message, /ant-secret-value/);
});

test('concurrency and tier reach the child under the names the generator and the tap read', () => {
  const child = buildGeneratorEnv({
    MCM_WIKI_PROVIDER: 'fireworks', MCM_FIREWORKS_API_KEY: 'k',
    MCM_WIKI_PAGE_CONCURRENCY: '4', MCM_WIKI_SERVICE_TIER: 'priority',
  });
  assert.equal(child.OPENWIKI_PAGE_CONCURRENCY, '4');
  assert.equal(child.MCM_WIKI_SERVICE_TIER, 'priority', 'the usage tap reads the tier from here');
  const plain = buildGeneratorEnv({ MCM_WIKI_PROVIDER: 'fireworks', MCM_FIREWORKS_API_KEY: 'k' });
  assert.equal(plain.OPENWIKI_PAGE_CONCURRENCY, '1', 'explicit, never inherited from a vendor default');
  assert.equal(plain.MCM_WIKI_SERVICE_TIER, undefined);
});

test('a reasoning effort reaches the child under the name the tap reads — and only when set', () => {
  const child = buildGeneratorEnv({ MCM_WIKI_PROVIDER: 'fireworks', MCM_FIREWORKS_API_KEY: 'k', MCM_WIKI_REASONING_EFFORT: 'low' });
  assert.equal(child.MCM_WIKI_REASONING_EFFORT, 'low');
  assert.equal(child.OPENWIKI_PROVIDER, 'fireworks', 'the generator stays on its own fireworks provider');
  assert.equal(child.OPENWIKI_REASONING_EFFORT, undefined, 'openwiki rejects an effort for its fireworks provider — the tap sends it instead');
  const plain = buildGeneratorEnv({ MCM_WIKI_PROVIDER: 'fireworks', MCM_FIREWORKS_API_KEY: 'k', MCM_WIKI_REASONING_EFFORT: '' });
  assert.equal(plain.MCM_WIKI_REASONING_EFFORT, undefined, 'an empty value is not passed through');
});

test('a stray OPENWIKI_PROVIDER in the caller\'s env cannot override the resolved choice', () => {
  // R4 in reverse: whatever reached us from outside, the resolved provider is what the child runs.
  const child = buildGeneratorEnv({
    MCM_WIKI_PROVIDER: 'fireworks', MCM_FIREWORKS_API_KEY: 'k',
    OPENWIKI_PROVIDER: 'anthropic', OPENWIKI_MODEL_ID: 'claude-sonnet-5',
  });
  assert.equal(child.OPENWIKI_PROVIDER, 'fireworks');
  assert.equal(child.OPENWIKI_MODEL_ID, 'accounts/fireworks/models/deepseek-v4p1-flash');
});

// ── a hung request must not eat the job (item #613) ─────────────────────────────────────────────

test('the generator gets an explicit, small provider retry count unless the operator set one', () => {
  // openwiki gives an OpenAI-compatible provider (Fireworks) no request timeout, so the OpenAI SDK's
  // 10-minute default applies, and at page concurrency > 1 it retries 5 times: one request that is
  // accepted but never answered is ~60 silent minutes — the whole job. Measured 2026-09-30, runs
  // 4385 and 4386, both killed at the job timeout with no record. Two retries bound it at ~30.
  const child = buildGeneratorEnv({ MCM_WIKI_PROVIDER: 'fireworks', FIREWORKS_API_KEY: 'fw' });
  assert.equal(child.OPENWIKI_PROVIDER_RETRY_ATTEMPTS, '2');
  const overridden = buildGeneratorEnv({ MCM_WIKI_PROVIDER: 'fireworks', FIREWORKS_API_KEY: 'fw', OPENWIKI_PROVIDER_RETRY_ATTEMPTS: '4' });
  assert.equal(overridden.OPENWIKI_PROVIDER_RETRY_ATTEMPTS, '4', 'an explicit operator value wins');
});
