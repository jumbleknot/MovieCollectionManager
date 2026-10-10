// Which pages openwiki will FORCE into the next run, offline and free (item #707).
//
// openwiki 0.7.1's `runClaimsPreflight` (dist/claims/brains/code/preflight.js) re-resolves every
// Claim's `repo://` evidence before a run. A page with any citation that vanished (unresolved) or
// moved (stale) becomes a mandatory "reconcile stale or unresolved Claims" job, whatever was
// requested — and that job is a full paid page regeneration. Runs 4960 and 4972 paid for five such
// pages and discarded them.
//
// This runs the SAME model-free check: openwiki's own `RepositoryEvidenceResolver`, loaded from the
// install the `openwiki` binary on PATH resolves to, over every sidecar under openwiki/.claims whose
// page exists. Stale is `result.evidence.version !== e.version`. NOT `result.version`, which is
// undefined and so flags every page. On 2026-10-10 this matched exactly the pages run 4972 forced.
//
// A citation of a CHURN file — a lockfile, a CD digest pin, a rotating allowlist entry — goes stale
// on routine commits that change no fact a page states. The audit marks those, so a forced page whose
// only issues are churn citations is visible as avoidable (openwiki/INSTRUCTIONS.md forbids them).

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CLAIMS_DIR } from './openwiki-claims.mjs';

const LOCKFILES = new Set(['uv.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'package-lock.json', 'yarn.lock', 'poetry.lock']);

/** `repo://<path>#L<a>-L<b>` → `{ path, lines: [a, b] | null }`. */
export function parseRepoResource(resource) {
  const m = /^repo:\/\/([^#?]+)(?:#L(\d+)(?:-L(\d+))?)?$/u.exec(resource);
  if (!m) return { path: null, lines: null };
  return { path: m[1], lines: m[2] ? [Number(m[2]), Number(m[3] ?? m[2])] : null };
}

/**
 * Why a citation is churn, or null. Each rule is a file that routine commits rewrite without
 * changing what a page can truthfully say about it (measured on main, 2026-09-10 → 2026-10-10).
 */
export function churnReason(resource, root) {
  const { path, lines } = parseRepoResource(resource);
  if (path === null) return null;
  if (LOCKFILES.has(basename(path))) return 'lockfile';
  // Every `chore(cd): promote … image digest(s)` commit rewrites these three files.
  if (/(^|\/)\.env\.deploy$/u.test(path)) return 'CD digest pin';
  if (lines === null) return null;
  if (/(^|\/)allowlist\.ya?ml$/u.test(path)) return 'line-addressed allowlist entry';
  // A range over an image digest. Read at its CURRENT position, which for a stale range may have
  // moved; the label is a hint for review, not a gate.
  try {
    const text = readFileSync(join(root, path), 'utf8').split('\n').slice(lines[0] - 1, lines[1]).join('\n');
    if (/@sha256:[0-9a-f]{12,}/u.test(text)) return 'image digest pin';
  } catch { /* unreadable: not classifiable */ }
  return null;
}

function sidecarFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? sidecarFiles(join(dir, d.name)) : d.name.endsWith('.json') ? [join(dir, d.name)] : []);
}

/**
 * Every page openwiki's preflight would force, as
 * `{ page, claims, staleClaims, unresolvedClaims, citations: [{ resource, kind, churn }], churnOnly }`.
 * `resolver` is anything with openwiki's `resolve(resource, previousVersion)`; tests pass a stub.
 * A resolver ERROR propagates, as it does in openwiki: it is not evidence that a file was deleted.
 */
export async function auditClaims({ root, bundleRoot = null, resolver }) {
  const bundleDir = bundleRoot ?? join(root, 'openwiki');
  const claimsDir = join(bundleDir, CLAIMS_DIR);
  const cache = new Map();
  const resolve = (resource, version) => {
    const key = `${resource}\0${version}`;
    // A containment refusal is permanent for the citation, so openwiki reports it as unresolved.
    if (!cache.has(key)) {
      cache.set(key, Promise.resolve().then(() => resolver.resolve(resource, version)).catch((err) => {
        if (err?.name === 'EvidenceSecurityError' || err?.constructor?.name === 'EvidenceSecurityError') return null;
        throw err;
      }));
    }
    return cache.get(key);
  };
  const rows = [];
  for (const file of sidecarFiles(claimsDir).sort()) {
    const rel = relative(claimsDir, file).split(sep).join('/').replace(/\.json$/u, '.md');
    if (!existsSync(join(bundleDir, rel))) continue; // an orphan sidecar is not a forced page
    const { claims = [] } = JSON.parse(readFileSync(file, 'utf8'));
    let staleClaims = 0;
    let unresolvedClaims = 0;
    const citations = new Map();
    for (const claim of claims) {
      let stale = false;
      let unresolved = false;
      for (const e of claim.evidence ?? []) {
        const current = await resolve(e.resource, e.version);
        const kind = current === null ? 'unresolved' : current.evidence.version !== e.version ? 'stale' : null;
        if (kind === null) continue;
        if (kind === 'unresolved') unresolved = true; else stale = true;
        if (!citations.has(e.resource)) citations.set(e.resource, { resource: e.resource, kind, churn: churnReason(e.resource, root) });
      }
      // openwiki files a claim with any unresolved evidence as unresolved, otherwise as stale.
      if (unresolved) unresolvedClaims += 1; else if (stale) staleClaims += 1;
    }
    if (citations.size === 0) continue;
    const list = [...citations.values()].sort((a, b) => a.resource.localeCompare(b.resource));
    rows.push({ page: rel, claims: claims.length, staleClaims, unresolvedClaims, citations: list, churnOnly: list.every((c) => c.churn !== null) });
  }
  return rows;
}

/** The openwiki package the `openwiki` binary on PATH belongs to, or null. */
export function openwikiPackageDir({ env = process.env } = {}) {
  const found = spawnSync('sh', ['-c', 'command -v openwiki'], { encoding: 'utf8', env });
  const bin = found.status === 0 ? found.stdout.trim() : '';
  if (bin === '') return null;
  let dir = dirname(realpathSync(bin));
  for (;;) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        if (JSON.parse(readFileSync(pkg, 'utf8')).name === 'openwiki') return dir;
      } catch { /* keep walking */ }
    }
    if (dirname(dir) === dir) return null;
    dir = dirname(dir);
  }
}

/** openwiki's own resolver, with the repository's .openwikiignore, exactly as its runtime builds it. */
export async function loadOpenwikiResolver({ root, packageDir = openwikiPackageDir() }) {
  if (packageDir === null) throw new Error('no `openwiki` binary on PATH — the audit uses its own resolver, so it needs the install');
  const version = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).version;
  const at = (rel) => pathToFileURL(join(packageDir, rel)).href;
  const { RepositoryEvidenceResolver } = await import(at('dist/claims/evidence/repository/resolver.js'));
  const { OpenWikiIgnore } = await import(at('dist/agent/openwiki-ignore.js'));
  return { version, resolver: new RepositoryEvidenceResolver({ rootDir: root, openWikiIgnore: await OpenWikiIgnore.load(root) }) };
}

export function formatAudit(rows, { version = null } = {}) {
  const lines = [];
  if (rows.length === 0) {
    lines.push(`[wiki-maintain] claims audit${version ? ` (openwiki ${version})` : ''}: no page has a stale or unresolved citation — openwiki will force nothing.`);
    return lines.join('\n');
  }
  lines.push(`[wiki-maintain] claims audit${version ? ` (openwiki ${version})` : ''}: openwiki will FORCE ${rows.length} page(s) into the next run, whatever is requested — each a paid regeneration:`);
  for (const r of rows) {
    lines.push(`  ${r.page}  ${r.staleClaims} stale + ${r.unresolvedClaims} unresolved / ${r.claims} claims${r.churnOnly ? '  ← churn citations only: avoidable' : ''}`);
    for (const c of r.citations) lines.push(`      ${c.kind.padEnd(10)} ${c.resource}${c.churn ? `  (churn: ${c.churn})` : ''}`);
  }
  return lines.join('\n');
}
