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
//   4. TELEMETRY (item #516). openwiki sends one usage event per run to a third-party analytics host
//      unless OPENWIKI_TELEMETRY_DISABLED or DO_NOT_TRACK is truthy. Both are forced on here, so the
//      opt-out no longer depends on the Nx target's env. Every run also passes `--telemetry-file`,
//      where openwiki records exactly what it did: `{disabled: true, sent: false}` when the opt-out
//      held. Any other record means an event WAS sent. The launcher then exits 3, and wiki-maintain
//      stops the rebuild. The file is written only once the run reaches openwiki's telemetry
//      boundary, so a run refused earlier (e.g. a missing credential) leaves no file and is not judged.
//
// Usage:
//   node scripts/wiki-generate.mjs              run the generator (WIKI_RUN_MESSAGE scopes it)
//   node scripts/wiki-generate.mjs --preflight  one minimal model call with the resolved provider/tier;
//                                               non-zero on any failure. Costs a fraction of a cent.
//
// Every argument other than --preflight is REJECTED: a flag this script did not recognise must never
// mean "start a paid run" (the --help / --dry-run lesson recorded in CLAUDE.md).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildGeneratorEnv, resolveWikiProvider } from './wiki-provider.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const USAGE_TAP = join(HERE, 'wiki-usage-tap.mjs');
export const RUN_MESSAGE_ENV = 'WIKI_RUN_MESSAGE';

const MIN_OUTPUT_TOKENS = 16_384;

/** Where the generator's telemetry record goes; wiki-maintain sets it per invocation (item #516). */
export const TELEMETRY_FILE_ENV = 'WIKI_TELEMETRY_FILE';
/** The launcher's exit code when the generator's record shows the opt-out did not hold. */
export const TELEMETRY_SENT_EXIT = 3;

function fail(message, code = 2) {
  console.error(`[wiki-generate] ✗ ${message}`);
  process.exit(code);
}

/** The generator argv. The message, when present, is one element — never re-parsed by a shell. */
export function generatorArgs(message, telemetryFile = null) {
  return [
    'code', '--update', '--print',
    ...(telemetryFile ? [`--telemetry-file=${telemetryFile}`] : []),
    ...(message ? [message] : []),
  ];
}

/**
 * Judge openwiki's `--telemetry-file` record (item #516). `null` (no file) means the run never reached
 * the telemetry boundary, so there is nothing to judge. Only `{disabled: true, sent: false}` passes.
 * Anything else, including a record that cannot be parsed, fails: the opt-out is proved by the
 * record, never assumed.
 */
export function judgeTelemetryRecord(text) {
  if (text === null || text === undefined) return { ok: true, reached: false, detail: 'no telemetry record (the run stopped before openwiki\'s telemetry boundary)' };
  let record;
  try { record = JSON.parse(text); } catch { return { ok: false, reached: true, detail: 'the telemetry record is not JSON' }; }
  if (record?.disabled === true && record?.sent === false) return { ok: true, reached: true, detail: 'opt-out held: disabled, nothing sent' };
  return { ok: false, reached: true, detail: `the opt-out did NOT hold: disabled=${JSON.stringify(record?.disabled ?? null)} sent=${JSON.stringify(record?.sent ?? null)}${record?.host ? ` host=${record.host}` : ''}` };
}

/** Read and judge the record at `path`; a missing file is "not reached", never a failure. */
export function readTelemetryVerdict(path) {
  return judgeTelemetryRecord(path && existsSync(path) ? readFileSync(path, 'utf8') : null);
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
  // Item #516: forced here, so a caller that bypasses the Nx target still cannot send telemetry.
  child.OPENWIKI_TELEMETRY_DISABLED = '1';
  child.DO_NOT_TRACK = '1';
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
  // A fresh path per run: openwiki replaces the file atomically, so a stale record from an earlier run
  // could otherwise pass for this one.
  const telemetryFile = process.env[TELEMETRY_FILE_ENV] || join(mkdtempSync(join(tmpdir(), 'wiki-telemetry-')), 'telemetry.json');
  rmSync(telemetryFile, { force: true });
  const r = spawnSync('openwiki', generatorArgs(process.env[RUN_MESSAGE_ENV], telemetryFile), { stdio: 'inherit', env: child });
  if (r.error) fail(`could not start openwiki: ${r.error.code ?? r.error.message}`);
  const telemetry = readTelemetryVerdict(telemetryFile);
  if (!telemetry.ok) fail(`TELEMETRY: ${telemetry.detail} — openwiki ignored the opt-out (item #516). Stop using this openwiki version until it is understood.`, TELEMETRY_SENT_EXIT);
  process.exit(r.status ?? 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main(process.argv.slice(2));
}
