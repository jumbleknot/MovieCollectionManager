// Feature 105 US3 — the container-side feature bookkeeping that capture runs around each ship
// (tasks.md T052; data-model.md "Feature attribution", identity rule, Local state `state/worktrees.json`):
//
//   attribute(…)        per turn: worktree → branch (git, cached) → the branch's OPEN feature (store
//                       lookup, cached; minted `<branch>@<date>` when there is none or the store is down)
//   collectOutcomes(…)  at SessionEnd and in sweeps, per touched feature, at most once per 15 minutes
//   reconcileOpen(…)    in sweeps: two open features minted offline for one branch collapse to the earlier
//   pushWeights(…)      in sweeps: upsert scripts/cc-usage-weights.json once per asOf
//
// Paths and branch names stay in the container except as the `branch` and `feature_id` columns.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attributeTurns } from './attribute-feature.mjs';
import { collectOutcomes as collectRow, outcomeReaders } from './collect-feature-outcomes.mjs';
import { paths, readJson, writeAtomic } from './local-state.mjs';
import { shapeRows } from './privacy-shape.mjs';
import { OPEN_STATES, reconcile, resolveFeature } from './resolve-feature-identity.mjs';
import { storeClient, Unreachable } from './store-client.mjs';

const BRANCH_TTL_MS = 10 * 60 * 1000;
const FEATURE_TTL_MS = 15 * 60 * 1000;
const WEIGHTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'cc-usage-weights.json');

const cacheFile = (configDir) => join(paths(configDir).state, 'worktrees.json');
export function loadCache(configDir) {
  const c = readJson(cacheFile(configDir), null) ?? {};
  return { roots: c.roots ?? {}, features: c.features ?? {}, collected: c.collected ?? {}, weightsAsOf: c.weightsAsOf ?? null, reconciledAt: c.reconciledAt ?? 0 };
}
export const saveCache = (configDir, cache) => writeAtomic(cacheFile(configDir), JSON.stringify(cache));

/** Worktree root → current branch: `git rev-parse` cached 10 min; a gone worktree keeps its last branch. */
export function branchResolver(cfg, cache) {
  const fixture = cfg.testWorktrees ? (readJson(cfg.testWorktrees, null)?.worktrees ?? {}) : null;
  return (root) => {
    if (fixture) return fixture[root]?.branch ?? null;
    const hit = cache.roots[root];
    if (hit && cfg.now() - hit.at < BRANCH_TTL_MS) return hit.branch;
    let branch = null;
    try {
      branch = execFileSync('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    } catch { /* removed worktree: fall back to the cache */ }
    if (branch) cache.roots[root] = { branch, at: cfg.now() };
    return branch ?? hit?.branch ?? null;
  };
}

/** The branch's open feature: cache (15 min) → store → mint. Returns the id and the row to ship if minted. */
async function openFeature(cfg, cache, branch, turnIso, store) {
  const hit = cache.features[branch];
  if (hit && cfg.now() - hit.at < FEATURE_TTL_MS) return { feature_id: hit.feature_id, first_seen_at: hit.first_seen_at };
  let known = [];
  let reached = false;
  try {
    known = await store.get(`/features?branch=eq.${encodeURIComponent(branch)}&pr_state=in.(none,open)&order=first_seen_at.asc&limit=5`);
    reached = true;
  } catch (e) {
    if (!(e instanceof Unreachable)) throw e;
  }
  // Offline, a cached id (even stale) beats minting a second one for the same branch.
  if (!reached && hit) return { feature_id: hit.feature_id, first_seen_at: hit.first_seen_at };
  const r = resolveFeature(branch, turnIso, known);
  const first_seen_at = r.created ? turnIso : (known.find((k) => k.feature_id === r.feature_id)?.first_seen_at ?? turnIso);
  cache.features[branch] = { feature_id: r.feature_id, first_seen_at, at: cfg.now() };
  return { feature_id: r.feature_id, first_seen_at };
}

/**
 * Attribute the parsed turns (mutates `records.turns`: feature_id, attribution_rule) and return a
 * MINIMAL features row (feature_id, branch, first_seen_at) for every feature they reference, shipped
 * first in the same batch: the FK is then satisfied even when another session minted the id and has
 * not shipped it yet. Minimal rows never carry outcome columns, so their upsert cannot overwrite them.
 * `st.attribution` carries the previous turn's branch across ships.
 */
export async function attribute(cfg, { records, signals, st }) {
  const turns = records.turns ?? [];
  if (!turns.length) return [];
  const cache = loadCache(cfg.configDir);
  const resolveBranch = branchResolver(cfg, cache);
  const att = st.attribution ?? { bySeq: {} };
  const first = turns[0].turn_seq;
  const decided = attributeTurns(
    turns.map((t) => ({ turn_seq: t.turn_seq, roots: signals[t.turn_seq]?.roots ?? {}, startBranch: signals[t.turn_seq]?.startBranch ?? null })),
    { resolveBranch, prevBranch: att.bySeq[first - 1] ?? null, hasEarlierTurn: first > 1 },
  );
  const store = storeClient(cfg);
  const rows = [];
  const touched = new Set(st.featuresTouched ?? []);
  for (const [i, d] of decided.entries()) {
    const t = turns[i];
    t.attribution_rule = d.attribution_rule;
    t.feature_id = null;
    att.bySeq[t.turn_seq] = d.branch;
    if (!d.branch) continue;
    const f = await openFeature(cfg, cache, d.branch, t.started_at ?? new Date(cfg.now()).toISOString(), store);
    t.feature_id = f.feature_id;
    touched.add(f.feature_id);
    if (!rows.some((r) => r.feature_id === f.feature_id)) rows.push({ feature_id: f.feature_id, branch: d.branch, first_seen_at: f.first_seen_at });
  }
  // Keep the map small: only the latest turns matter for inheritance.
  const keep = Object.keys(att.bySeq).map(Number).sort((a, b) => b - a).slice(0, 20);
  att.bySeq = Object.fromEntries(keep.map((k) => [k, att.bySeq[k]]));
  st.attribution = att;
  st.featuresTouched = [...touched].slice(-50);
  saveCache(cfg.configDir, cache);
  return rows;
}

/**
 * Outcomes for the features this session touched, each at most once per 15 min, upserted in their own
 * request (never in a batch with minimal rows). A feature counts as collected only once that succeeds.
 */
export async function collectOutcomes(cfg, st, { budgetMs = 4000, readers = null } = {}) {
  const t0 = Date.now();
  const cache = loadCache(cfg.configDir);
  const byId = new Map(Object.entries(cache.features).map(([branch, v]) => [v.feature_id, { branch, ...v }]));
  const roots = Object.entries(cache.roots);
  const out = [];
  for (const id of st.featuresTouched ?? []) {
    if (Date.now() - t0 > budgetMs) break;
    const f = byId.get(id);
    if (!f) continue;
    const worktree = roots.find(([, v]) => v.branch === f.branch)?.[0] ?? null;
    const rd = readers ?? outcomeReaders({ repo: worktree ?? cfg.repoDir });
    const row = await collectRow(
      { feature_id: id, branch: f.branch, first_seen_at: f.first_seen_at, pr_state: 'none', collected_at: cache.collected[id] ?? null },
      { now: cfg.now(), worktree, ...rd },
    );
    if (!row) continue;
    out.push(row);
  }
  if (out.length) {
    await storeClient(cfg).upsert('features', 'feature_id', shapeRows('features', out));
    for (const row of out) {
      cache.collected[row.feature_id] = row.collected_at;
      if (!OPEN_STATES.has(row.pr_state)) delete cache.features[row.branch]; // closed: the next turn opens a new one
    }
  }
  saveCache(cfg.configDir, cache);
  return out;
}

/** Sweep-time: two open, PR-less features minted for one branch collapse to the earlier (research R17). */
export async function reconcileOpen(cfg) {
  const cache = loadCache(cfg.configDir);
  if (cfg.now() - cache.reconciledAt < FEATURE_TTL_MS) return { repoint: [], close: [] };
  const store = storeClient(cfg);
  const open = await store.get('/features?pr_state=eq.none&select=feature_id,branch,first_seen_at,pr_state');
  const r = reconcile(open);
  for (const { from, to } of r.repoint) await store.patch(`/turns?feature_id=eq.${encodeURIComponent(from)}`, { feature_id: to });
  for (const id of r.close) await store.patch(`/features?feature_id=eq.${encodeURIComponent(id)}`, { pr_state: 'closed' });
  for (const [branch, v] of Object.entries(cache.features)) if (r.close.includes(v.feature_id)) delete cache.features[branch];
  cache.reconciledAt = cfg.now();
  saveCache(cfg.configDir, cache);
  return r;
}

export function weightsRow(file = WEIGHTS) {
  const w = JSON.parse(readFileSync(file, 'utf8'));
  return { as_of: w.asOf, ...w.ratios, source: w.source };
}

/** Upsert the committed weight table once per asOf (also `cc-usage.mjs weights push`, unconditionally). */
export async function pushWeights(cfg, { force = false } = {}) {
  const cache = loadCache(cfg.configDir);
  const row = weightsRow();
  if (!force && cache.weightsAsOf === row.as_of) return false;
  await storeClient(cfg).upsert('token_weights', 'as_of', [row]);
  cache.weightsAsOf = row.as_of;
  saveCache(cfg.configDir, cache);
  return true;
}
