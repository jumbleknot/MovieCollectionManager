// wiki-usage-tap.mjs — a fetch wrapper loaded INTO the generator process (feature 078, plan D3).
//
// Loaded by `wiki-generate.mjs` through `NODE_OPTIONS=--import=<this file>`. openwiki 0.5.x/0.6.x
// reports no token usage and has no way to send a provider's `service_tier` (research R6), so this
// does exactly two things, each only when asked:
//
//   WIKI_USAGE_LOG=<path>        append one JSON line of COUNTS per model call (Anthropic /v1/messages,
//                                OpenAI-shaped /chat/completions): agent kind, status, duration,
//                                uncached / cached / cache-write / output / reasoning tokens.
//   MCM_WIKI_SERVICE_TIER=<tier> set `service_tier` on Fireworks chat-completions request bodies.
//
// With neither set it is inert: the real fetch receives the caller's arguments by identity.
//
// The negative properties are the load-bearing ones and are pinned by wiki-usage-tap.test.mjs:
//   • no prompt, response, error text or header is ever recorded — counts, status and timing only;
//   • a tier changes exactly one key of a Fireworks body and nothing else, and no other request;
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
  if (!log && !tier) return realFetch;

  return async function tappedFetch(input, init) {
    const url = urlOf(input);
    const isAnthropic = ANTHROPIC_MESSAGES.test(url);
    const isChat = CHAT_COMPLETIONS.test(url);
    if (!isAnthropic && !isChat) return realFetch(input, init);

    let sendInit = init;
    if (tier && FIREWORKS_CHAT.test(url) && typeof init?.body === 'string') {
      try {
        const body = JSON.parse(init.body);
        body.service_tier = tier;
        sendInit = { ...init, body: JSON.stringify(body) };
      } catch {
        sendInit = init; // not JSON: send exactly what the caller built
      }
    }

    const started = Date.now();
    const res = await realFetch(input, sendInit);
    if (!log) return res;

    const kind = agentKind(typeof init?.body === 'string' ? init.body : '');
    const record = (fields) => {
      try {
        appendFileSync(log, `${JSON.stringify({ kind, status: res.status, ms: Date.now() - started, ...fields })}\n`);
      } catch {
        // The log is best-effort; the generator's call must never fail because of it.
      }
    };
    res.clone().text()
      .then((text) => record(res.ok ? counts(usageFrom(text)) : {}))
      .catch((error) => record({ tapError: error?.name ?? 'Error' }));
    return res;
  };
}

if (process.env.WIKI_USAGE_LOG || process.env.MCM_WIKI_SERVICE_TIER) {
  globalThis.fetch = wrapFetch(globalThis.fetch.bind(globalThis), process.env);
}
