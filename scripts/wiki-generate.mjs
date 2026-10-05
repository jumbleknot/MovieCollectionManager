#!/usr/bin/env node
// wiki-generate.mjs — the ONE place the knowledge-bundle generator is started (feature 078, plan D2).
//
// Run by the `wiki-update` Nx target, which is in turn the only way wiki-maintain.mjs reaches the
// generator. It replaced a shell string in the target for three measured reasons:
//
//   1. PROVIDER. nx lets a target's `env` OVERWRITE the job's environment (research R4), so a provider
//      in the target could never be switched by the workflow. The target now names none; this resolves
//      it from MCM_WIKI_PROVIDER via wiki-provider.mjs.
//   2. MESSAGE. The run message scopes a paid run to named pages. It travels in WIKI_RUN_MESSAGE (never
//      `nx --args`, which strips quoting — 2026-07-30, a paid run went unscoped) and is passed here as
//      ONE argv element with no shell in between, so nothing can split or expand it.
//   3. INSTRUMENT. The generator reports no usage and cannot send `service_tier`; wiki-usage-tap.mjs is
//      loaded into its process for both (research R0/R6).
//
// Usage:
//   node scripts/wiki-generate.mjs              run the generator (WIKI_RUN_MESSAGE scopes it)
//   node scripts/wiki-generate.mjs --preflight  one minimal model call with the resolved provider/tier;
//                                               non-zero on any failure. Costs a fraction of a cent.
//
// Every argument other than --preflight is REJECTED: a flag this script did not recognise must never
// mean "start a paid run" (the --help / --dry-run lesson recorded in CLAUDE.md).

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildGeneratorEnv, resolveWikiProvider } from './wiki-provider.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const USAGE_TAP = join(HERE, 'wiki-usage-tap.mjs');
export const RUN_MESSAGE_ENV = 'WIKI_RUN_MESSAGE';

const MIN_OUTPUT_TOKENS = 16_384;

function fail(message, code = 2) {
  console.error(`[wiki-generate] ✗ ${message}`);
  process.exit(code);
}

/** The generator argv. The message, when present, is one element — never re-parsed by a shell. */
export function generatorArgs(message) {
  return message ? ['code', '--update', '--print', message] : ['code', '--update', '--print'];
}

/** The child env: resolved provider + credential, the explicit cap checked, and the tap loaded. */
export function launchEnv(env = process.env) {
  const cap = env.OPENWIKI_MAX_OUTPUT_TOKENS;
  if (!cap || !/^\d+$/.test(cap) || Number(cap) < MIN_OUTPUT_TOKENS) {
    // The 4096 fallback made the generator write nothing ~half the time while exiting 0 (feature 043).
    // The Nx target sets the cap; refusing to start without it keeps a bare run from reintroducing that.
    throw new Error(`OPENWIKI_MAX_OUTPUT_TOKENS must be an integer >= ${MIN_OUTPUT_TOKENS} (got ${JSON.stringify(cap ?? null)}). Run through \`pnpm nx wiki-update infrastructure-as-code\`, which sets it.`);
  }
  const child = buildGeneratorEnv(env);
  const tap = `--import=${pathToFileURL(USAGE_TAP).href}`;
  child.NODE_OPTIONS = [env.NODE_OPTIONS, tap].filter(Boolean).join(' ');
  return child;
}

const PREFLIGHT = {
  anthropic: (child, model) => ({
    url: `${child.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com'}/v1/messages`,
    headers: { 'x-api-key': child.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    // No `temperature`: Sonnet 5 rejects it with a 400 (075 R13) — the preflight sends only what the
    // generator itself sends, so it cannot fail for a reason a real run would not.
    body: { model, max_tokens: 1, messages: [{ role: 'user', content: 'ok' }] },
  }),
  fireworks: (child, model, tier, effort) => ({
    url: `${child.FIREWORKS_BASE_URL ?? 'https://api.fireworks.ai/inference/v1'}/chat/completions`,
    headers: { authorization: `Bearer ${child.FIREWORKS_API_KEY}`, 'content-type': 'application/json' },
    body: { model, max_tokens: 1, messages: [{ role: 'user', content: 'ok' }], ...(tier ? { service_tier: tier } : {}), ...(effort ? { reasoning_effort: effort } : {}) },
  }),
};

/** One minimal call with the resolved provider, model and tier. Resolves to { ok, status, detail }. */
export async function preflight(env = process.env, fetchImpl = fetch) {
  const resolved = resolveWikiProvider(env);
  const child = buildGeneratorEnv(env);
  const req = PREFLIGHT[resolved.provider](child, resolved.modelId, resolved.tier, resolved.reasoningEffort);
  let res;
  try {
    res = await fetchImpl(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body) });
  } catch (error) {
    return { ok: false, status: null, detail: `${resolved.provider}: request failed (${error?.cause?.code ?? error?.name ?? 'error'}) — is the host allowlisted?` };
  }
  if (res.ok) return { ok: true, status: res.status, detail: `${resolved.provider} ${resolved.modelId}${resolved.tier ? ` (${resolved.tier})` : ''}` };
  // The provider's error TYPE only — never the body, which can echo request content.
  let type = 'unknown';
  try { const j = await res.json(); type = j?.error?.type ?? j?.error?.code ?? j?.type ?? 'unknown'; } catch { /* keep unknown */ }
  return { ok: false, status: res.status, detail: `${resolved.provider} ${resolved.modelId}: HTTP ${res.status} (${type})` };
}

async function main(argv) {
  const known = new Set(['--preflight']);
  const unknown = argv.filter((a) => !known.has(a));
  if (unknown.length > 0) fail(`unrecognised argument(s): ${unknown.join(' ')}. Accepted: --preflight.`);

  if (argv.includes('--preflight')) {
    let result;
    try { result = await preflight(process.env); } catch (error) { fail(error.message); }
    if (!result.ok) fail(`preflight failed — ${result.detail}`, 1);
    console.log(`[wiki-generate] ✓ preflight: ${result.detail} answered HTTP ${result.status}`);
    return;
  }

  let child;
  try { child = launchEnv(process.env); } catch (error) { fail(error.message); }
  const resolved = resolveWikiProvider(process.env);
  console.log(`[wiki-generate] provider=${resolved.provider} model=${resolved.modelId} concurrency=${resolved.pageConcurrency}${resolved.tier ? ` tier=${resolved.tier}` : ''}${resolved.reasoningEffort ? ` effort=${resolved.reasoningEffort}` : ''}`);
  const r = spawnSync('openwiki', generatorArgs(process.env[RUN_MESSAGE_ENV]), { stdio: 'inherit', env: child });
  if (r.error) fail(`could not start openwiki: ${r.error.code ?? r.error.message}`);
  process.exit(r.status ?? 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main(process.argv.slice(2));
}
