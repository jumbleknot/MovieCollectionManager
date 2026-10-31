#!/usr/bin/env node
// Package-registry retention (spec 084 US5, item #863). REPORT-ONLY unless told twice.
//
//   node scripts/registry-retention.mjs                    # report: one row per version, then totals
//   node scripts/registry-retention.mjs --json             # the same report as JSON
//   node scripts/registry-retention.mjs --package <name>   # one package only
//   node scripts/registry-retention.mjs --apply            # delete the `delete` rows — ONLY when the
//                                                          # committed config also says `mode: apply`
//
// Env: MCM_FORGE_URL (required, no default), REGISTRY_CLEANUP_TOKEN (`write:package`; a read-only
// MCM_FORGE_TOKEN is enough for a report), REGISTRY_USER (registry basic-auth user; default: owner).
//
// Exit: 0 done · 1 forge/API error · 2 usage, or --apply against `mode: report` · 5 a protected digest
//       could not be found in the registry (nothing is deleted).
//
// WHY A SCRIPT, NOT THE FORGE'S CLEANUP RULES (research R13). Those match versions by name regex, so
// they cannot protect a digest that a git file names; they live only in the web UI; and they have no
// report-only run. Here every protection is computed from git BEFORE the first API call.
//
// THE MEASURED HAZARD (quickstart 0g, 2026-10-31). One push creates two kinds of version: the tag
// `<sha>`, whose manifest.json is the digest `.env.deploy` pins (an OCI image INDEX), and the
// `sha256:<digest>` children that index references (the platform manifest, which owns the layers,
// plus an attestation). An unchanged image REUSES the previous push's platform manifest, so a child
// can be older than the newest tag that needs it. A child is therefore never judged by age alone: it
// is kept while any kept index references it, and when any kept index cannot be read, no child of
// that package is deleted at all.

import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import { ArgvError, partitionArgsWithValues, wantsHelp } from './lib/argv-contract.mjs';
import { DEFAULT_DURATION_RUNS } from './ci-status.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_PATH = 'infrastructure-as-code/forgejo/registry-retention.yaml';
const EXIT = { OK: 0, ERROR: 1, USAGE: 2, UNRESOLVED: 5 };
const DAY_MS = 86_400_000;

const USAGE = `Usage: node scripts/registry-retention.mjs [--json] [--package <name>] [--apply]

Reports what ${CONFIG_PATH} keeps and deletes in the forge's package registry.
--apply deletes the \`delete\` rows, and only when that file says \`mode: apply\`.

Env: MCM_FORGE_URL (required), REGISTRY_CLEANUP_TOKEN (or MCM_FORGE_TOKEN for a report), REGISTRY_USER.
Exit: 0 done · 1 forge error · 2 usage or mode mismatch · 5 a protected digest is not in the registry.`;

// ── config ────────────────────────────────────────────────────────────────────────────────────

export class ConfigError extends Error {}

const TOP_KEYS = new Set(['mode', 'owner', 'evidenceWindowDays', 'packages']);
const PACKAGE_KEYS = new Set(['name', 'type', 'keepNewest', 'keepDays', 'keepAll', 'note']);
const isCount = (n) => Number.isInteger(n) && n >= 0;

/** Jobs that publish a `ci-failures` bundle, counted from the workflows (the durations sample is per job). */
export function bundlePublishingJobs(dir = resolve(REPO_ROOT, '.forgejo/workflows')) {
  let n = 0;
  for (const f of readdirSync(dir).filter((x) => /\.ya?ml$/.test(x))) {
    const wf = parseYaml(readFileSync(join(dir, f), 'utf8'));
    for (const job of Object.values(wf?.jobs ?? {})) {
      if ((job?.steps ?? []).some((s) => /node scripts\/ci-failure-digest\.mjs/.test(s?.run ?? ''))) n += 1;
    }
  }
  return n;
}

/**
 * Parse and validate the retention config. Every refusal names the key, because a config that is
 * silently half-read keeps less than its author believes.
 */
export function loadConfig(text, { bundleJobs = bundlePublishingJobs() } = {}) {
  const cfg = parseYaml(text);
  if (!cfg || typeof cfg !== 'object') throw new ConfigError('the config is empty or not a mapping');
  for (const k of Object.keys(cfg)) if (!TOP_KEYS.has(k)) throw new ConfigError(`unknown key \`${k}\``);
  if (cfg.mode !== 'report' && cfg.mode !== 'apply') {
    throw new ConfigError(`mode must be \`report\` or \`apply\`, not ${JSON.stringify(cfg.mode)}`);
  }
  if (typeof cfg.owner !== 'string' || !cfg.owner) throw new ConfigError('owner is required');
  if (!Number.isInteger(cfg.evidenceWindowDays) || cfg.evidenceWindowDays < 1) {
    throw new ConfigError('evidenceWindowDays must be a whole number of days');
  }
  if (!Array.isArray(cfg.packages)) throw new ConfigError('packages must be a list');
  const seen = new Set();
  for (const p of cfg.packages) {
    for (const k of Object.keys(p ?? {})) {
      if (!PACKAGE_KEYS.has(k)) throw new ConfigError(`unknown key \`${k}\` in package ${JSON.stringify(p?.name)}`);
    }
    if (typeof p.name !== 'string' || !p.name) throw new ConfigError('every package needs a name');
    if (seen.has(p.name)) throw new ConfigError(`package ${p.name} is configured twice`);
    seen.add(p.name);
    if (p.type !== 'container' && p.type !== 'generic') throw new ConfigError(`${p.name}: type must be container or generic`);
    const hasWindow = p.keepNewest !== undefined || p.keepDays !== undefined;
    if (p.keepAll !== undefined && p.keepAll !== true) throw new ConfigError(`${p.name}: keepAll may only be true`);
    if (p.keepAll && hasWindow) throw new ConfigError(`${p.name}: keepAll and a keepNewest/keepDays window are exclusive`);
    if (!p.keepAll && !hasWindow) throw new ConfigError(`${p.name}: set keepNewest and/or keepDays, or keepAll: true`);
    for (const k of ['keepNewest', 'keepDays']) {
      if (p[k] !== undefined && !isCount(p[k])) throw new ConfigError(`${p.name}: ${k} must be a whole number`);
    }
    if (p.name === 'ci-failures' && !p.keepAll) {
      // `ci-status durations` reads the last DEFAULT_DURATION_RUNS runs of a job from these bundles.
      const floor = DEFAULT_DURATION_RUNS * bundleJobs;
      if ((p.keepDays ?? 0) < cfg.evidenceWindowDays) {
        throw new ConfigError(`ci-failures: keepDays ${p.keepDays ?? 0} is below evidenceWindowDays ${cfg.evidenceWindowDays}`);
      }
      if ((p.keepNewest ?? 0) < floor) {
        throw new ConfigError(
          `ci-failures: keepNewest ${p.keepNewest ?? 0} is below ${floor} ` +
            `(${DEFAULT_DURATION_RUNS} durations runs × ${bundleJobs} bundle-publishing jobs)`,
        );
      }
    }
  }
  return cfg;
}

// ── protections, from git ─────────────────────────────────────────────────────────────────────

const DEPLOY_PATHSPEC = 'infrastructure-as-code/docker/*/.env.deploy';
const DIGEST_LINE = /^([A-Z][A-Z0-9_]*)_DIGEST=(sha256:[0-9a-f]{64})\s*$/gm;

/**
 * Every digest pinned in a `.env.deploy` at the newest promotion and the `history` before it — the
 * deployed set plus the rollback targets (a rollback is a `git revert` of a promotion commit).
 * Keyed by digest; `package` is the variable's name (`MCM_BFF_DIGEST` → `mcm-bff`).
 *
 * A shallow clone is REFUSED: it has no history, so it would read as "nothing but HEAD to protect".
 */
export function protectedDigests({ cwd = REPO_ROOT, history = 5 } = {}) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  if (git('rev-parse', '--is-shallow-repository').trim() === 'true') {
    throw new ConfigError('this is a shallow clone, so the rollback targets cannot be read; check out with fetch-depth: 0');
  }
  const commits = git('log', '--format=%H', '-n', String(history + 1), '--', DEPLOY_PATHSPEC).split('\n').filter(Boolean);
  const out = new Map();
  for (const c of commits) {
    const files = git('ls-tree', '-r', '--name-only', c, '--', 'infrastructure-as-code/docker')
      .split('\n').filter((f) => f.endsWith('/.env.deploy'));
    for (const f of files) {
      for (const m of git('show', `${c}:${f}`).matchAll(DIGEST_LINE)) {
        if (!out.has(m[2])) {
          out.set(m[2], { package: m[1].toLowerCase().replace(/_/g, '-'), source: `${f}@${c.slice(0, 8)}` });
        }
      }
    }
  }
  return out;
}

// ── decisions ─────────────────────────────────────────────────────────────────────────────────

const isChildName = (v) => /^sha256:[0-9a-f]{64}$/.test(v);
const newestFirst = (a, b) => b.created_at.localeCompare(a.created_at) || Number(b.id) - Number(a.id);

/**
 * One row per version: `decision` is its FIRST keep reason, else `delete`.
 *
 * @param {{config: object, packages: Record<string, {type: string, versions: object[]}>,
 *          protectedSet: Map<string, {package: string, source: string}>, now: number}} input
 *   Each version: { id, version, created_at, size, indexDigest? (tag), children? (tag: string[] | null) }
 */
export function decide({ config, packages, protectedSet, now }) {
  const rows = [];
  const byName = new Map(config.packages.map((p) => [p.name, p]));
  for (const [name, pkg] of Object.entries(packages)) {
    const rule = byName.get(name);
    // `digest` is what a pull by digest names: a tag's index digest, or a child's own name. It is in
    // the row so a reviewer can grep the report against every .env.deploy before `mode: apply`.
    const row = (v, decision, reason = '') => rows.push({
      package: name, version: v.version, digest: v.indexDigest ?? (isChildName(v.version) ? v.version : null),
      created_at: v.created_at, decision, reason, size: v.size ?? null,
    });
    if (!rule) {
      for (const v of pkg.versions) row(v, 'keep:unconfigured', 'not in the config — reported, never deleted');
      continue;
    }
    if (rule.keepAll) {
      for (const v of pkg.versions) row(v, 'keep:all');
      continue;
    }
    const recent = (v) => rule.keepDays !== undefined && now - Date.parse(v.created_at) <= rule.keepDays * DAY_MS;
    const protectedBy = (v) => protectedSet.get(v.indexDigest) ?? protectedSet.get(v.version) ?? null;
    const container = pkg.type === 'container';
    const heads = pkg.versions.filter((v) => !(container && isChildName(v.version))).sort(newestFirst);
    const children = container ? pkg.versions.filter((v) => isChildName(v.version)) : [];

    const kept = [];
    heads.forEach((v, i) => {
      const p = protectedBy(v);
      if (p) row(v, 'keep:protected', p.source);
      else if (i < (rule.keepNewest ?? 0)) row(v, 'keep:newest', `#${i + 1} of ${rule.keepNewest}`);
      else if (recent(v)) row(v, 'keep:recent', `within ${rule.keepDays} days`);
      else return row(v, 'delete', `older than ${rule.keepDays ?? 0} days and past the newest ${rule.keepNewest ?? 0}`);
      kept.push(v);
    });

    const referenced = new Set(kept.flatMap((v) => v.children ?? []));
    const unreadable = kept.filter((v) => v.children === null);
    for (const v of children) {
      const p = protectedBy(v);
      if (p) row(v, 'keep:protected', p.source);
      else if (referenced.has(v.version)) row(v, 'keep:referenced', 'a kept index points at it');
      else if (unreadable.length) row(v, 'keep:unverified', `${unreadable.length} kept index(es) could not be read`);
      else if (recent(v)) row(v, 'keep:recent', `within ${rule.keepDays} days (may be a push in progress)`);
      else row(v, 'delete', 'no kept index references it');
    }
  }
  return rows;
}

/** Protected digests of a configured, listed package that no version carries — exit 5. */
function unresolvedProtections({ config, packages, protectedSet }) {
  const configured = new Set(config.packages.map((p) => p.name));
  const out = [];
  for (const [digest, p] of protectedSet) {
    if (!configured.has(p.package) || !packages[p.package]) continue;
    const found = packages[p.package].versions.some((v) => v.indexDigest === digest || v.version === digest);
    if (!found) out.push({ digest, ...p });
  }
  return out;
}

// ── the forge ─────────────────────────────────────────────────────────────────────────────────

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

function forgeClient({ base, owner, token, user, fetch }) {
  const api = `${base}/api/v1/packages/${owner}`;
  const auth = { Authorization: `token ${token}` };
  const get = async (url, headers = auth) => {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`GET ${url.replace(base, '<forge>')} → ${res.status}`);
    return res.json();
  };
  return {
    async listAll() {
      const out = [];
      for (let page = 1; page <= 1000; page++) {
        const batch = await get(`${api}?page=${page}&limit=50`);
        out.push(...batch);
        if (batch.length < 50) return out;
      }
      throw new Error('more than 1000 pages of packages — refusing to guess at the rest');
    },
    files: (type, name, version) => get(`${api}/${type}/${name}/${encodeURIComponent(version)}/files`),
    /** Child digests of an index; [] for a single image manifest; null when it cannot be read. */
    async children(name, tag) {
      const res = await fetch(`${base}/v2/${owner}/${name}/manifests/${encodeURIComponent(tag)}`, {
        headers: { Authorization: `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`, Accept: MANIFEST_ACCEPT },
      });
      if (!res.ok) return null;
      const type = String(res.headers.get('content-type') ?? '');
      const body = await res.json();
      if (/index|manifest\.list/.test(type) || Array.isArray(body?.manifests)) return (body.manifests ?? []).map((m) => m.digest);
      return [];
    },
    async remove(type, name, version) {
      const url = `${api}/${type}/${name}/${encodeURIComponent(version)}`;
      const res = await fetch(url, { method: 'DELETE', headers: auth });
      if (!res.ok) throw new Error(`DELETE ${url.replace(base, '<forge>')} → ${res.status}`);
    },
  };
}

/** Run `fn` over `items`, `width` at a time, preserving order. */
async function pool(items, width, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

const sizeOf = (files) => (files ?? []).reduce((n, f) => n + (Number(f.Size) || 0), 0);

/** List every version, then read each container head's index digest and children. */
async function collect(client, { only }) {
  const packages = {};
  for (const v of await client.listAll()) {
    if (only && v.name !== only) continue;
    (packages[v.name] ??= { type: v.type, versions: [] }).versions.push({
      id: v.id, version: v.version, created_at: v.created_at, size: null,
    });
  }
  for (const [name, pkg] of Object.entries(packages)) {
    if (pkg.type !== 'container') continue;
    const heads = pkg.versions.filter((v) => !isChildName(v.version));
    await pool(heads, 8, async (v) => {
      const files = await client.files('container', name, v.version);
      const manifest = files.find((f) => f.name === 'manifest.json');
      v.indexDigest = manifest ? `sha256:${manifest.sha256}` : null;
      v.size = sizeOf(files);
      v.children = await client.children(name, v.version);
    });
  }
  return packages;
}

// ── report ────────────────────────────────────────────────────────────────────────────────────

function totals(rows) {
  const t = {};
  for (const r of rows) {
    const p = (t[r.package] ??= { total: 0, keep: 0, delete: 0, bytesFreed: 0 });
    p.total += 1;
    if (r.decision === 'delete') {
      p.delete += 1;
      p.bytesFreed += r.size ?? 0;
    } else p.keep += 1;
  }
  return t;
}

const human = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${b} B`);

function renderText(report, log) {
  const w = Math.max(...report.rows.map((r) => r.package.length), 8);
  for (const r of report.rows) {
    log(`${r.package.padEnd(w)}  ${r.version}  ${r.created_at.slice(0, 10)}  ${r.decision.padEnd(17)}  ${r.reason}`.trimEnd());
  }
  log('');
  for (const [name, t] of Object.entries(report.packages)) {
    log(`${name.padEnd(w)}  ${t.total} versions: keep ${t.keep}, delete ${t.delete}, would free ${human(t.bytesFreed)}`);
  }
  log(`protected digests from git: ${report.protected}`);
  log(`mode: ${report.mode}${report.applied ? ' — DELETED the rows above marked delete' : ' — nothing was deleted'}`);
  log('(bytes are an upper bound: a blob shared with a kept version is not freed.)');
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────

export async function main(argv, {
  env = process.env,
  fetch = globalThis.fetch,
  configPath = resolve(REPO_ROOT, CONFIG_PATH),
  protectedDigests: readProtected = () => protectedDigests(),
  now = Date.now(),
  log = console.log,
  logError = console.error,
} = {}) {
  if (wantsHelp(argv)) {
    log(USAGE);
    return EXIT.OK;
  }
  let flags;
  let values;
  try {
    ({ flags, values } = partitionArgsWithValues(argv, {
      accepted: ['--apply', '--json'], withValues: ['--package'], usage: USAGE,
    }));
  } catch (e) {
    if (!(e instanceof ArgvError)) throw e;
    logError(e.message);
    return EXIT.USAGE;
  }
  const base = String(env.MCM_FORGE_URL ?? '').replace(/\/+$/, '');
  const token = env.REGISTRY_CLEANUP_TOKEN || env.MCM_FORGE_TOKEN || '';
  if (!base) {
    logError('MCM_FORGE_URL is not set. There is no default forge: set it to the forge base URL.');
    return EXIT.USAGE;
  }
  if (!token) {
    logError('no token: set REGISTRY_CLEANUP_TOKEN (write:package), or MCM_FORGE_TOKEN for a report.');
    return EXIT.USAGE;
  }

  let config;
  let protectedSet;
  try {
    config = loadConfig(readFileSync(configPath, 'utf8'));
    // BEFORE any API call: what must survive is decided from git alone.
    protectedSet = readProtected();
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    logError(`registry-retention: ${e.message}`);
    return EXIT.USAGE;
  }
  const apply = flags.has('--apply');
  if (apply && config.mode !== 'apply') {
    logError(`--apply refused: ${CONFIG_PATH} says \`mode: ${config.mode}\`. Review a report, then flip it to \`mode: apply\` in a PR.`);
    return EXIT.USAGE;
  }

  const client = forgeClient({ base, owner: config.owner, token, user: env.REGISTRY_USER || config.owner, fetch });
  try {
    const packages = await collect(client, { only: values.get('--package') });
    const rows = decide({ config, packages, protectedSet, now });
    // Size the deletions that have no size yet (children are only read when they would go).
    const unsized = rows.filter((r) => r.decision === 'delete' && r.size === null);
    await pool(unsized, 8, async (r) => {
      r.size = sizeOf(await client.files(packages[r.package].type, r.package, r.version));
    });
    const unresolved = unresolvedProtections({ config, packages, protectedSet });
    const report = {
      mode: config.mode, generatedAt: new Date(now).toISOString(), applied: false,
      protected: protectedSet.size, unresolved, packages: totals(rows), rows,
    };
    if (unresolved.length) {
      if (flags.has('--json')) log(JSON.stringify(report, null, 2));
      else renderText(report, log);
      for (const u of unresolved) {
        logError(`✗ protected digest ${u.digest} (${u.package}, pinned in ${u.source}) is not in the registry.`);
      }
      logError('A deployed or rollback image is missing, or the pin is wrong. Nothing was deleted (exit 5).');
      return EXIT.UNRESOLVED;
    }
    if (apply) {
      const doomed = rows.filter((r) => r.decision === 'delete')
        // Indexes before children, so no index that survives a partial run points at a deleted child.
        .sort((a, b) => Number(isChildName(a.version)) - Number(isChildName(b.version)));
      for (const r of doomed) {
        await client.remove(packages[r.package].type, r.package, r.version);
        logError(`deleted ${r.package} ${r.version}`);
      }
      report.applied = true;
    }
    if (flags.has('--json')) log(JSON.stringify(report, null, 2));
    else renderText(report, log);
    return EXIT.OK;
  } catch (e) {
    logError(`registry-retention: ${e.message}`);
    return EXIT.ERROR;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
