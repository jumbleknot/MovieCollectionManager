// Feature 078 — the usage tap loaded into the generator process (plan D3, research R0/R6).
//
// The generator (openwiki) reports no token usage and cannot send a provider's `service_tier`. The tap
// is a fetch wrapper that does exactly two things and nothing else: record per-call COUNTS, and set
// `service_tier` on Fireworks chat-completions bodies when asked. Because it sits inside a paid,
// page-writing process, the properties that matter are negative ones: inert when unconfigured, never
// alters any other byte of a request, never records content, never throws into the generator.
//
// Deterministic, offline, token-free: every test drives a stub fetch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { wrapFetch } from '../wiki-usage-tap.mjs';

const FW_URL = 'https://api.fireworks.ai/inference/v1/chat/completions';
const ANT_URL = 'https://api.anthropic.com/v1/messages';

function stubFetch(responseBody, { status = 200, contentType = 'application/json' } = {}) {
  const calls = [];
  const fn = async (input, init) => {
    calls.push({ input, init });
    return new Response(typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody), {
      status, headers: { 'content-type': contentType },
    });
  };
  return { fn, calls };
}

const tmp = () => mkdtempSync(join(tmpdir(), 'wiki-tap-'));
const readLines = (p) => readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const settle = () => new Promise((r) => setTimeout(r, 20));

const fwBody = (extra = {}) => JSON.stringify({
  model: 'accounts/fireworks/models/deepseek-v4p1-flash',
  messages: [{ role: 'user', content: 'SECRET PROMPT TEXT' }],
  tools: [{ type: 'function', function: { name: 'submit_page' } }],
  ...extra,
});
const fwResponse = {
  choices: [{ message: { content: 'RESPONSE TEXT' }, finish_reason: 'tool_calls' }],
  usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 900 }, completion_tokens_details: { reasoning_tokens: 20 } },
};

// ── (a) inert when unconfigured ────────────────────────────────────────────────────────────────

test('unconfigured: the real fetch receives the caller\'s exact arguments, and nothing is written', async () => {
  const { fn, calls } = stubFetch(fwResponse);
  const wrapped = wrapFetch(fn, {});
  const init = { method: 'POST', body: fwBody() };
  const res = await wrapped(FW_URL, init);
  assert.equal(calls[0].init, init, 'identity, not a copy: an unconfigured tap must not touch the request');
  assert.equal(calls[0].input, FW_URL);
  assert.equal(res.status, 200);
});

// ── (b) counts only, never content ─────────────────────────────────────────────────────────────

test('configured: one line per model call, counts and timing only', async () => {
  const dir = tmp();
  try {
    const log = join(dir, 'usage.jsonl');
    const { fn } = stubFetch(fwResponse);
    const wrapped = wrapFetch(fn, { WIKI_USAGE_LOG: log });
    const res = await wrapped(FW_URL, { method: 'POST', body: fwBody() });
    assert.equal((await res.json()).choices[0].message.content, 'RESPONSE TEXT', 'the generator still reads the full response');
    await settle();
    const [line] = readLines(log);
    assert.equal(line.kind, 'page', 'agent kind comes from the tool list');
    assert.equal(line.status, 200);
    assert.equal(line.uncached, 100, 'Fireworks prompt_tokens INCLUDES the cached ones');
    assert.equal(line.cached, 900);
    assert.equal(line.cacheWrite, 0);
    assert.equal(line.output, 50);
    assert.equal(line.reasoning, 20);
    assert.equal(typeof line.ms, 'number');
    const text = readFileSync(log, 'utf8');
    assert.doesNotMatch(text, /SECRET PROMPT TEXT|RESPONSE TEXT/, 'no prompt or response content');
    for (const k of Object.keys(line)) assert.ok(!/message|content|authorization|header/i.test(k), `no key named ${k}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('configured: Anthropic usage maps to the same fields', async () => {
  const dir = tmp();
  try {
    const log = join(dir, 'usage.jsonl');
    const { fn } = stubFetch({
      content: [{ type: 'text', text: 'x' }],
      usage: { input_tokens: 5, cache_creation_input_tokens: 300, cache_read_input_tokens: 4000, output_tokens: 70, output_tokens_details: { thinking_tokens: 30 } },
    });
    const wrapped = wrapFetch(fn, { WIKI_USAGE_LOG: log });
    await wrapped(ANT_URL, { method: 'POST', body: JSON.stringify({ tools: [{ name: 'submit_plan' }], messages: [] }) });
    await settle();
    const [line] = readLines(log);
    assert.deepEqual(
      { kind: line.kind, uncached: line.uncached, cached: line.cached, cacheWrite: line.cacheWrite, output: line.output, reasoning: line.reasoning },
      { kind: 'plan', uncached: 5, cached: 4000, cacheWrite: 300, output: 70, reasoning: 30 },
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('configured: a non-model URL is passed through untouched and not logged', async () => {
  const dir = tmp();
  try {
    const log = join(dir, 'usage.jsonl');
    const { fn, calls } = stubFetch('{}');
    const init = { method: 'GET' };
    await wrapWith(fn, log)('https://registry.npmjs.org/x', init);
    assert.equal(calls[0].init, init);
    await settle();
    assert.equal(existsSync(log), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
const wrapWith = (fn, log) => wrapFetch(fn, { WIKI_USAGE_LOG: log });

// ── (c) service_tier: exactly one key, Fireworks only ──────────────────────────────────────────

test('tier set: a Fireworks body gains service_tier and differs in NO other key', async () => {
  const { fn, calls } = stubFetch(fwResponse);
  const original = fwBody({ temperature: 0.2 });
  await wrapFetch(fn, { MCM_WIKI_SERVICE_TIER: 'priority' })(FW_URL, { method: 'POST', body: original });
  const sent = JSON.parse(calls[0].init.body);
  const before = JSON.parse(original);
  assert.equal(sent.service_tier, 'priority');
  delete sent.service_tier;
  assert.deepEqual(sent, before, 'every other key must be byte-for-byte the caller\'s');
  assert.equal(calls[0].init.method, 'POST', 'and the rest of init is preserved');
});

test('tier set: an Anthropic request is left exactly as the caller built it', async () => {
  const { fn, calls } = stubFetch({ usage: {} });
  const init = { method: 'POST', body: JSON.stringify({ messages: [] }) };
  await wrapFetch(fn, { MCM_WIKI_SERVICE_TIER: 'priority' })(ANT_URL, init);
  assert.equal(calls[0].init, init);
});

// ── (c2) reasoning_effort: exactly one key, Fireworks only ─────────────────────────────────────

test('effort set: a Fireworks body gains reasoning_effort and differs in NO other key', async () => {
  const { fn, calls } = stubFetch(fwResponse);
  const original = fwBody({ temperature: 0.2 });
  await wrapFetch(fn, { MCM_WIKI_REASONING_EFFORT: 'low' })(FW_URL, { method: 'POST', body: original });
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.reasoning_effort, 'low');
  delete sent.reasoning_effort;
  assert.deepEqual(sent, JSON.parse(original), 'every other key must be the caller\'s');
});

test('effort and tier together: exactly those two keys change', async () => {
  const { fn, calls } = stubFetch(fwResponse);
  const original = fwBody();
  await wrapFetch(fn, { MCM_WIKI_REASONING_EFFORT: 'low', MCM_WIKI_SERVICE_TIER: 'priority' })(FW_URL, { method: 'POST', body: original });
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.reasoning_effort, 'low');
  assert.equal(sent.service_tier, 'priority');
  delete sent.reasoning_effort; delete sent.service_tier;
  assert.deepEqual(sent, JSON.parse(original));
});

test('effort set: an Anthropic request is left exactly as the caller built it', async () => {
  const { fn, calls } = stubFetch({ usage: {} });
  const init = { method: 'POST', body: JSON.stringify({ messages: [] }) };
  await wrapFetch(fn, { MCM_WIKI_REASONING_EFFORT: 'low' })(ANT_URL, init);
  assert.equal(calls[0].init, init);
});

// ── (d) never throws into the generator ────────────────────────────────────────────────────────

test('a malformed response body records {tapError} and the response still reaches the generator', async () => {
  const dir = tmp();
  try {
    const log = join(dir, 'usage.jsonl');
    const { fn } = stubFetch('{"a": not json at all}');
    const res = await wrapWith(fn, log)(FW_URL, { method: 'POST', body: fwBody() });
    assert.equal(await res.text(), '{"a": not json at all}');
    await settle();
    const [line] = readLines(log);
    assert.ok(line.tapError, 'the failure is recorded, not thrown');
    assert.equal(line.status, 200);
    // A JSON.parse message quotes the start of the body it failed on — that is response content.
    assert.doesNotMatch(readFileSync(log, 'utf8'), /not json/, 'the error is named, its message (which quotes content) is not');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a non-2xx model response is recorded with its status (rate limits under concurrency)', async () => {
  const dir = tmp();
  try {
    const log = join(dir, 'usage.jsonl');
    const { fn } = stubFetch({ error: { message: 'rate limited' } }, { status: 429 });
    const res = await wrapWith(fn, log)(FW_URL, { method: 'POST', body: fwBody() });
    assert.equal(res.status, 429);
    await settle();
    const [line] = readLines(log);
    assert.equal(line.status, 429);
    assert.doesNotMatch(readFileSync(log, 'utf8'), /rate limited/, 'error text is content too');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── (e) item #719: which PAGE a call belongs to, and how it ENDED — still no content ───────────
//
// Four page workers run concurrently, so a log of counts could not say which page's worker "exited
// without submitting" (devcontainer-sandbox, renovate), nor why. openwiki names the page in the
// worker's system prompt ("You own exactly /openwiki/<page>.md."), and a response's finish reason,
// tool-call NAMES and whether each call's arguments parse are metadata, not content. A stream that
// ends without submit_page reads off the last lines: `length` (truncated), `stop` with no tool call,
// or a tool call whose arguments are not valid JSON (an error openwiki swallows into the same exit).

const pageBody = (page, extra = {}) => JSON.stringify({
  model: 'm',
  messages: [
    { role: 'system', content: `You own exactly /openwiki/${page}.\nSECRET PROMPT TEXT` },
    { role: 'user', content: 'Research and document the assigned page, then submit it.' },
  ],
  tools: ['write_file', 'read_file', 'submit_page'].map((name) => ({ type: 'function', function: { name } })),
  ...extra,
});
const fwToolResponse = (finish, toolCalls = []) => ({
  choices: [{ message: { content: 'RESPONSE TEXT', tool_calls: toolCalls.map(([name, args]) => ({ type: 'function', function: { name, arguments: args } })) }, finish_reason: finish }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});

async function tapOne(body, response, url = FW_URL) {
  const dir = tmp();
  try {
    const log = join(dir, 'usage.jsonl');
    const { fn } = stubFetch(response);
    await wrapWith(fn, log)(url, { method: 'POST', body });
    await settle();
    return { line: readLines(log)[0], text: readFileSync(log, 'utf8') };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('#719: a page worker\'s call names its page, its finish reason and its tool calls — no content', async () => {
  const { line, text } = await tapOne(pageBody('runbooks/renovate.md'),
    fwToolResponse('tool_calls', [['write_file', '{"path":"/openwiki/runbooks/renovate.md","content":"SECRET PAGE"}']]));
  assert.equal(line.page, 'runbooks/renovate.md');
  assert.equal(line.finish, 'tool_calls');
  assert.deepEqual(line.tools, ['write_file']);
  assert.equal(line.badArgs, 0);
  assert.doesNotMatch(text, /SECRET|RESPONSE TEXT/, 'no prompt, response or argument content');
});

test('#719: the three ways a worker stream ends without submitting are distinguishable', async () => {
  const truncated = await tapOne(pageBody('runbooks/a.md'), fwToolResponse('length'));
  assert.deepEqual([truncated.line.finish, truncated.line.tools], ['length', []]);
  const stopped = await tapOne(pageBody('runbooks/a.md'), fwToolResponse('stop'));
  assert.deepEqual([stopped.line.finish, stopped.line.tools], ['stop', []]);
  const malformed = await tapOne(pageBody('runbooks/a.md'), fwToolResponse('tool_calls', [['submit_page', '{"claims": [ SECRET']]));
  assert.deepEqual([malformed.line.tools, malformed.line.badArgs], [['submit_page'], 1]);
  assert.doesNotMatch(malformed.text, /SECRET/);
});

test('#719: only DECLARED tool names, a whitelisted page path and a known finish reason are recorded', async () => {
  const { line, text } = await tapOne(pageBody('runbooks/a.md SECRET'),
    fwToolResponse('SECRET_REASON', [['SECRET_TOOL', '{}']]));
  assert.equal(line.page, undefined, 'a path that is not a plain bundle page is not recorded');
  assert.equal(line.finish, 'other');
  assert.deepEqual(line.tools, ['undeclared']);
  assert.doesNotMatch(text, /SECRET/);
});

test('#719: a planner call carries no page, and Anthropic responses map to the same fields', async () => {
  const plan = await tapOne(fwBody(), fwResponse);
  assert.equal(plan.line.page, undefined, 'the fixture names no page');
  const ant = await tapOne(JSON.stringify({
    system: [{ type: 'text', text: 'You own exactly /openwiki/projects/sast.md.\nSECRET PROMPT TEXT' }],
    tools: [{ name: 'submit_page' }, { name: 'write_file' }], messages: [],
  }), { content: [{ type: 'text', text: 'RESPONSE TEXT' }, { type: 'tool_use', name: 'submit_page', input: { a: 1 } }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } }, ANT_URL);
  assert.deepEqual([ant.line.page, ant.line.finish, ant.line.tools, ant.line.badArgs], ['projects/sast.md', 'tool_use', ['submit_page'], 0]);
  assert.doesNotMatch(ant.text, /SECRET|RESPONSE TEXT/);
});
