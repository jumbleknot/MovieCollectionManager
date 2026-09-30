// wiki-provider.mjs — which model writes the knowledge bundle, resolved in ONE pure place (feature 078).
//
// ── Why this is a module and not an Nx `env` block ───────────────────────────────────────────────
//
// nx `run-commands` builds the child env as `{ ...process.env, ...targetEnv }` (nx 22.7.8,
// `processEnv` in dist/src/executors/run-commands/running-tasks.js). A provider written into the
// `wiki-update` target's `env` therefore SILENTLY OVERWRITES whatever the workflow exports — the job
// could set a provider and the generator would never see it (research R4). So the target sets no
// provider at all; `wiki-generate.mjs` resolves it here from `MCM_WIKI_PROVIDER`, which nothing in
// the target sets.
//
// ── Credentials ──────────────────────────────────────────────────────────────────────────────────
//
// Each provider accepts its raw name first (what CI injects) and then the `MCM_`-prefixed name (what
// the dev container carries). The `MCM_` form exists because an exported `ANTHROPIC_API_KEY` makes
// Claude Code bill the API instead of the subscription (CLAUDE.md, first gate); the Fireworks key
// follows the same rule for symmetry. The resolved value is mapped to the name the generator reads
// ONLY in the generator's own environment, and the other providers' keys are removed from it: the
// generator gets exactly the credential it uses.
//
// Measured basis for the rows: specs/078-wiki-generator-cost/research.md R1-R3.

/**
 * The default for LOCAL runs, which carry the Anthropic key. CI states its own default — Fireworks at page
 * concurrency 4 — in wiki-maintain.yml (078 FR-002, research R9), overridable by repository variable.
 */
export const DEFAULT_WIKI_PROVIDER = 'anthropic';

export const WIKI_PROVIDERS = Object.freeze({
  anthropic: Object.freeze({
    openwikiProvider: 'anthropic',
    modelId: 'claude-sonnet-5',
    tiers: Object.freeze([]),
    credential: Object.freeze({ accepted: Object.freeze(['ANTHROPIC_API_KEY', 'MCM_ANTHROPIC_API_KEY']), mapTo: 'ANTHROPIC_API_KEY' }),
  }),
  fireworks: Object.freeze({
    openwikiProvider: 'fireworks',
    modelId: 'accounts/fireworks/models/deepseek-v4p1-flash',
    // Fireworks bills `service_tier: "priority"` at +25% for a faster admission path. Measured on this
    // workload it bought no speed (R3), so it is supported but not the default.
    tiers: Object.freeze(['priority']),
    credential: Object.freeze({ accepted: Object.freeze(['FIREWORKS_API_KEY', 'MCM_FIREWORKS_API_KEY']), mapTo: 'FIREWORKS_API_KEY' }),
  }),
});

/** openwiki 0.6.0's own bounds for OPENWIKI_PAGE_CONCURRENCY (`MAX_PAGE_CONCURRENCY = 8`). */
export const MIN_PAGE_CONCURRENCY = 1;
export const MAX_PAGE_CONCURRENCY = 8;

const SELECTOR = 'MCM_WIKI_PROVIDER';
const TIER = 'MCM_WIKI_SERVICE_TIER';
const CONCURRENCY = 'MCM_WIKI_PAGE_CONCURRENCY';

/**
 * An empty string is UNSET: `${{ vars.X }}` renders a repository variable that was never set as ''.
 * Anything else that is not an exact accepted value throws.
 */
const setting = (env, name) => (env[name] === undefined || env[name] === '' ? undefined : env[name]);

/**
 * Resolve the generator configuration from the environment. Every malformed value THROWS: a
 * mis-typed selector that fell back to a default would bill the wrong vendor with no signal.
 */
export function resolveWikiProvider(env = process.env) {
  const raw = setting(env, SELECTOR);
  const provider = raw === undefined ? DEFAULT_WIKI_PROVIDER : raw;
  const row = Object.hasOwn(WIKI_PROVIDERS, provider) ? WIKI_PROVIDERS[provider] : null;
  if (!row) {
    throw new Error(`${SELECTOR}=${JSON.stringify(raw)} is not a supported provider. Expected one of: ${Object.keys(WIKI_PROVIDERS).join(', ')}.`);
  }

  const tierRaw = setting(env, TIER);
  let tier = null;
  if (tierRaw !== undefined) {
    if (row.tiers.length === 0) {
      throw new Error(`${TIER} is set, but the ${provider} provider has no service tiers — unset it rather than have it ignored.`);
    }
    if (!row.tiers.includes(tierRaw)) {
      throw new Error(`${TIER}=${JSON.stringify(tierRaw)} is not a ${provider} tier. Expected one of: ${row.tiers.join(', ')}.`);
    }
    tier = tierRaw;
  }

  const concurrencyRaw = setting(env, CONCURRENCY);
  let pageConcurrency = MIN_PAGE_CONCURRENCY;
  if (concurrencyRaw !== undefined) {
    const n = /^[1-9]\d*$/.test(concurrencyRaw) ? Number(concurrencyRaw) : NaN;
    if (!(n >= MIN_PAGE_CONCURRENCY && n <= MAX_PAGE_CONCURRENCY)) {
      throw new Error(`${CONCURRENCY}=${JSON.stringify(concurrencyRaw)} is invalid. Expected an integer from ${MIN_PAGE_CONCURRENCY} to ${MAX_PAGE_CONCURRENCY}.`);
    }
    pageConcurrency = n;
  }

  return {
    provider,
    openwikiProvider: row.openwikiProvider,
    modelId: row.modelId,
    tier,
    pageConcurrency,
    credential: row.credential,
  };
}

/**
 * The environment the generator process runs with: the caller's env, with the resolved provider,
 * model, concurrency and tier set, the chosen credential mapped to the name the generator reads, and
 * every OTHER provider's credential removed. Throws — naming the accepted variables, never a value —
 * when the chosen provider has no credential.
 */
export const GENERATOR_RETRY_ATTEMPTS = 2;

export function buildGeneratorEnv(env = process.env) {
  const resolved = resolveWikiProvider(env);
  const { accepted, mapTo } = resolved.credential;
  const secret = accepted.map((name) => env[name]).find(Boolean);
  if (!secret) {
    throw new Error(`No ${resolved.provider} credential: set one of ${accepted.join(' / ')}.`);
  }

  const child = { ...env };
  for (const row of Object.values(WIKI_PROVIDERS)) {
    for (const name of [...row.credential.accepted, row.credential.mapTo]) delete child[name];
  }
  delete child[TIER];

  child[mapTo] = secret;
  child.OPENWIKI_PROVIDER = resolved.openwikiProvider;
  child.OPENWIKI_MODEL_ID = resolved.modelId;
  child.OPENWIKI_PAGE_CONCURRENCY = String(resolved.pageConcurrency);
  if (resolved.tier) child[TIER] = resolved.tier;
  // Item #613. openwiki gives an OpenAI-compatible provider (Fireworks) no request timeout, so the
  // OpenAI SDK's 10-minute default applies; at page concurrency > 1 openwiki retries 5 times. One
  // request that is accepted and never answered was therefore ~60 silent minutes — the whole job
  // (runs 4385/4386, 2026-09-30). Two retries bound it at ~30 and still absorb a rate-limit burst.
  // An explicit operator value wins.
  if (!env.OPENWIKI_PROVIDER_RETRY_ATTEMPTS) child.OPENWIKI_PROVIDER_RETRY_ATTEMPTS = String(GENERATOR_RETRY_ATTEMPTS);
  return child;
}
