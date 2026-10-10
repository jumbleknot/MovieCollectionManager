// wiki-usage-tap.mjs — a fetch wrapper loaded INTO the generator process (feature 078, plan D3).
//
// Loaded by `wiki-generate.mjs` through `NODE_OPTIONS=--import=<this file>`. openwiki 0.5.x/0.6.x
// reports no token usage and has no way to send a provider's `service_tier` (research R6), so this
// does exactly three things, each only when asked:
//
//   WIKI_USAGE_LOG=<path>        append one JSON line of COUNTS per model call (Anthropic /v1/messages,
//                                OpenAI-shaped /chat/completions): agent kind, status, duration,
//                                uncached / cached / cache-write / output / reasoning tokens — and,
//                                since item #719, the page a worker owns, the finish reason, the
//                                NAMES of the tools called and how many calls' arguments do not parse.
//   MCM_WIKI_SERVICE_TIER=<tier> set `service_tier` on Fireworks chat-completions request bodies.
//   MCM_WIKI_REASONING_EFFORT=<e> set `reasoning_effort` on the same bodies. openwiki refuses an
//                                effort for its `fireworks` provider; its `openai-compatible`
//                                provider could carry one, but cannot send `service_tier`, so the
//                                tap stays (078 research R15, G1/G2).
//
// With none set it is inert: the real fetch receives the caller's arguments by identity.
//
// The negative properties are the load-bearing ones and are pinned by wiki-usage-tap.test.mjs:
//   • no prompt, response, error text or header is ever recorded — counts, status, timing and
//     identifiers only (a whitelisted bundle page path, declared tool names, a known finish reason);
//   • a tier or an effort changes exactly its own key of a Fireworks body and nothing else, and no
//     other request;
//   • nothing here throws into the generator — a failure to read usage is itself a recorded line.
//
// This is the instrument of research R0, whose counts reconciled to the Fireworks bill to the cent.

import { appendFileSync } from 'node:fs';

const ANTHROPIC_MESSAGES = /anthropic\.com\/v1\/messages(?:\?|$)/;
const CHAT_COMPLETIONS = /\/chat\/completions(?:\?|$)/;
const FIREWORKS_CHAT = /^https:\/\/api\.fireworks\.ai\/.*\/chat\/completions(?:\?|$)/;

const urlOf = (input) => (typeof input === 'string' ? input : input?.url ?? String(input));

/** Which openwiki agent made the call, from the tool names in the request (no content is kept). */
function agentKind(body) {
  try {
    const tools = (JSON.parse(body).tools ?? []).map((t) => t.name ?? t.function?.name);
    if (tools.includes('submit_page')) return 'page';
    if (tools.includes('submit_plan')) return 'plan';
    return 'other';
  } catch {
    return 'unknown';
  }
}

// Item #719. openwiki opens every page worker's system prompt with "You own exactly /openwiki/<page>."
// (dist/agent/repository-prompts.js). Only a plain bundle path is recorded; anything else, nothing.
const OWNED_PAGE = /You own exactly \/openwiki\/([A-Za-z0-9._/-]+\.md)\.(?:\s|$)/u;
const FINISH_REASONS = new Set(['stop', 'length', 'tool_calls', 'content_filter', 'function_call', 'end_turn', 'max_tokens', 'tool_use', 'stop_sequence', 'pause_turn', 'refusal']);

const textOf = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n') : '');

/** The page a worker owns, and the tool names the request declared — identifiers, never content. */
function requestFacts(body) {
  try {
    const req = JSON.parse(body);
    const declared = new Set((req.tools ?? []).map((t) => t.name ?? t.function?.name).filter((n) => typeof n === 'string'));
    const system = [textOf(req.system), ...(req.messages ?? []).filter((m) => m?.role === 'system' || m?.role === 'developer').map((m) => textOf(m.content))].join('\n');
    const page = OWNED_PAGE.exec(system)?.[1];
    return { declared, page: page && !page.split('/').includes('..') ? page : undefined };
  } catch {
    return { declared: new Set(), page: undefined };
  }
}

/**
 * How a model call ENDED: its finish reason (from a fixed set), the NAMES of the tools it called (only
 * names the request declared), and how many tool calls had arguments that do not parse — never the
 * arguments themselves. A JSON body only: a streamed Anthropic body yields its stop_reason alone.
 */
function outcomeFrom(text, declared) {
  const name = (n) => (declared.has(n) ? n : 'undeclared');
  const reason = (r) => (r === undefined || r === null ? undefined : FINISH_REASONS.has(r) ? r : 'other');
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{')) {
    let stop;
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try { stop = JSON.parse(line.slice(5)).delta?.stop_reason ?? stop; } catch { /* not an event */ }
    }
    return stop === undefined ? {} : { finish: reason(stop) };
  }
  const res = JSON.parse(trimmed);
  if (Array.isArray(res.choices)) {
    const choice = res.choices[0] ?? {};
    const calls = choice.message?.tool_calls ?? [];
    let badArgs = 0;
    for (const c of calls) {
      try { JSON.parse(c.function?.arguments ?? ''); } catch { badArgs += 1; }
    }
    return { finish: reason(choice.finish_reason), tools: calls.map((c) => name(c.function?.name)), badArgs };
  }
  const uses = (res.content ?? []).filter((b) => b?.type === 'tool_use');
  return { finish: reason(res.stop_reason), tools: uses.map((b) => name(b.name)), badArgs: uses.filter((b) => typeof b.input !== 'object' || b.input === null).length };
}

/** Normalise either provider's usage object to one shape. Fireworks' prompt_tokens INCLUDES cached. */
function counts(usage = {}) {
  if ('prompt_tokens' in usage || 'completion_tokens' in usage) {
    const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
    return {
      uncached: (usage.prompt_tokens ?? 0) - cached,
      cached,
      cacheWrite: 0,
      output: usage.completion_tokens ?? 0,
      reasoning: usage.completion_tokens_details?.reasoning_tokens ?? 0,
    };
  }
  return {
    uncached: usage.input_tokens ?? 0,
    cached: usage.cache_read_input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    reasoning: usage.output_tokens_details?.thinking_tokens ?? 0,
  };
}

/** Usage from a JSON body, or from an Anthropic SSE stream (message_start + message_delta). */
function usageFrom(text) {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed).usage;
  const usage = {};
  let seen = false;
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    let event;
    try { event = JSON.parse(line.slice(5)); } catch { continue; }
    if (event.type === 'message_start') { Object.assign(usage, event.message?.usage); seen = true; }
    if (event.type === 'message_delta') { Object.assign(usage, event.usage); seen = true; }
  }
  if (!seen) throw new Error('no usage in response');
  return usage;
}

/**
 * Wrap a fetch implementation. Exported for the tests; the side effect at the bottom installs it on
 * `globalThis.fetch` when the module is loaded by the generator.
 */
export function wrapFetch(realFetch, env = process.env) {
  const log = env.WIKI_USAGE_LOG || null;
  const tier = env.MCM_WIKI_SERVICE_TIER || null;
  const effort = env.MCM_WIKI_REASONING_EFFORT || null;
  if (!log && !tier && !effort) return realFetch;

  return async function tappedFetch(input, init) {
    const url = urlOf(input);
    const isAnthropic = ANTHROPIC_MESSAGES.test(url);
    const isChat = CHAT_COMPLETIONS.test(url);
    if (!isAnthropic && !isChat) return realFetch(input, init);

    let sendInit = init;
    if ((tier || effort) && FIREWORKS_CHAT.test(url) && typeof init?.body === 'string') {
      try {
        const body = JSON.parse(init.body);
        if (tier) body.service_tier = tier;
        if (effort) body.reasoning_effort = effort;
        sendInit = { ...init, body: JSON.stringify(body) };
      } catch {
        sendInit = init; // not JSON: send exactly what the caller built
      }
    }

    const started = Date.now();
    const res = await realFetch(input, sendInit);
    if (!log) return res;

    const body = typeof init?.body === 'string' ? init.body : '';
    const kind = agentKind(body);
    const { declared, page } = requestFacts(body);
    const record = (fields) => {
      try {
        appendFileSync(log, `${JSON.stringify({ kind, ...(page ? { page } : {}), status: res.status, ms: Date.now() - started, ...fields })}\n`);
      } catch {
        // The log is best-effort; the generator's call must never fail because of it.
      }
    };
    res.clone().text()
      .then((text) => {
        if (!res.ok) return record({});
        const usage = counts(usageFrom(text));
        let ended = {};
        try { ended = outcomeFrom(text, declared); } catch { ended = {}; }
        return record({ ...usage, ...ended });
      })
      .catch((error) => record({ tapError: error?.name ?? 'Error' }));
    return res;
  };
}

if (process.env.WIKI_USAGE_LOG || process.env.MCM_WIKI_SERVICE_TIER || process.env.MCM_WIKI_REASONING_EFFORT) {
  globalThis.fetch = wrapFetch(globalThis.fetch.bind(globalThis), process.env);
}
