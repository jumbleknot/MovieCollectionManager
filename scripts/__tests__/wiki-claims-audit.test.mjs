// Item #707 — the offline audit of the pages openwiki's Claims preflight will force into a run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditClaims, churnReason, formatAudit } from '../wiki-claims-audit.mjs';
import { parseArgs } from '../wiki-maintain.mjs';

/** A bundle with one sidecar per `pages` entry: `{ 'area/page.md': [[resource, version], …] per claim }`. */
function bundle(pages, { orphan = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'claims-audit-'));
  for (const [rel, claims] of Object.entries(pages)) {
    const [area, name] = rel.split('/');
    mkdirSync(join(root, 'openwiki', '.claims', area), { recursive: true });
    mkdirSync(join(root, 'openwiki', area), { recursive: true });
    writeFileSync(join(root, 'openwiki', area, name), '---\ntype: Convention\n---\nBody.\n');
    writeFileSync(join(root, 'openwiki', '.claims', area, name.replace(/\.md$/u, '.json')), JSON.stringify({
      claims: claims.map((evidence, i) => ({ id: `c${i}`, evidence: evidence.map(([resource, version]) => ({ resource, version })) })),
    }));
  }
  if (orphan) {
    mkdirSync(join(root, 'openwiki', '.claims', 'gone'), { recursive: true });
    writeFileSync(join(root, 'openwiki', '.claims', 'gone', `${orphan}.json`), JSON.stringify({ claims: [{ id: 'x', evidence: [{ resource: 'repo://missing.md', version: 'v' }] }] }));
  }
  return root;
}

/**
 * openwiki's resolver shape: `{ evidence: { version } }` or null. There is deliberately NO top-level
 * `version`: comparing `result.version` (undefined) with the stored version flags EVERY page, which
 * is the mistake measured on 2026-10-10.
 */
const stubResolver = (current) => ({
  resolve: async (resource) => {
    if (current[resource] instanceof Error) throw current[resource];
    return current[resource] === undefined ? null : { evidence: { resource, version: current[resource] } };
  },
});

test('audit: a page is forced by a STALE or an UNRESOLVED citation, and an unchanged one is not', async () => {
  const root = bundle({
    'projects/fresh.md': [[['repo://a.md#L1-L2', 'v1']]],
    'projects/stale.md': [[['repo://a.md#L1-L2', 'v1'], ['repo://b.md#L3-L4', 'old']]],
    'runbooks/gone.md': [[['repo://deleted.md', 'v1']], [['repo://a.md#L1-L2', 'v1']]],
  });
  try {
    const rows = await auditClaims({ root, resolver: stubResolver({ 'repo://a.md#L1-L2': 'v1', 'repo://b.md#L3-L4': 'new' }) });
    assert.deepEqual(rows.map((r) => [r.page, r.staleClaims, r.unresolvedClaims, r.claims]),
      [['projects/stale.md', 1, 0, 1], ['runbooks/gone.md', 0, 1, 2]], 'compared on evidence.version; the fresh page is not flagged');
    assert.deepEqual(rows[0].citations, [{ resource: 'repo://b.md#L3-L4', kind: 'stale', churn: null }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('audit: a claim with an unresolved citation counts as unresolved, as openwiki files it', async () => {
  const root = bundle({ 'projects/p.md': [[['repo://moved.md#L1-L2', 'old'], ['repo://deleted.md', 'v']]] });
  try {
    const [row] = await auditClaims({ root, resolver: stubResolver({ 'repo://moved.md#L1-L2': 'new' }) });
    assert.deepEqual([row.staleClaims, row.unresolvedClaims], [0, 1]);
    assert.deepEqual(row.citations.map((c) => c.kind), ['unresolved', 'stale'], 'both citations are still listed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('audit: an orphan sidecar (no page) is not a forced page, and a containment refusal is unresolved', async () => {
  const root = bundle({ 'projects/p.md': [[['repo://link.md', 'v']]] }, { orphan: 'page' });
  try {
    const refusal = Object.assign(new Error('symlink'), { name: 'EvidenceSecurityError' });
    const rows = await auditClaims({ root, resolver: stubResolver({ 'repo://link.md': refusal }) });
    assert.deepEqual(rows.map((r) => [r.page, r.unresolvedClaims]), [['projects/p.md', 1]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('audit: any other resolver error propagates — it is not evidence that a file was deleted', async () => {
  const root = bundle({ 'projects/p.md': [[['repo://a.md', 'v']]] });
  try {
    await assert.rejects(auditClaims({ root, resolver: stubResolver({ 'repo://a.md': new Error('EIO') }) }), /EIO/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('churn: lockfiles, CD digest files, line-addressed allowlist entries and digest-pin ranges', () => {
  const root = mkdtempSync(join(tmpdir(), 'claims-churn-'));
  try {
    writeFileSync(join(root, 'Dockerfile'), 'FROM node:22@sha256:0123456789abcdef0123\nRUN true\n');
    writeFileSync(join(root, 'compose.yaml'), 'services:\n  a:\n    image: x\n');
    assert.equal(churnReason('repo://agents/movie-assistant/uv.lock#L10-L20', root), 'lockfile');
    assert.equal(churnReason('repo://pnpm-lock.yaml', root), 'lockfile');
    assert.equal(churnReason('repo://infrastructure-as-code/docker/bff/.env.deploy#L1-L3', root), 'CD digest pin');
    assert.equal(churnReason('repo://security/sast/allowlist.yaml#L211-L263', root), 'line-addressed allowlist entry');
    assert.equal(churnReason('repo://security/sast/allowlist.yaml', root), null, 'the whole policy file is a stable citation');
    assert.equal(churnReason('repo://Dockerfile#L1-L2', root), 'image digest pin');
    assert.equal(churnReason('repo://compose.yaml#L1-L3', root), null);
    assert.equal(churnReason('repo://docs/runbooks/x.md#L1-L9', root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('audit: a page forced ONLY by churn citations is marked avoidable in the report', async () => {
  const root = bundle({
    'projects/agent-gateway.md': [[['repo://agents/movie-assistant/uv.lock#L1-L9', 'old']]],
    'projects/sast.md': [[['repo://security/sast/allowlist.yaml#L1-L9', 'old'], ['repo://docs/x.md#L1-L2', 'old']]],
  });
  try {
    const rows = await auditClaims({ root, resolver: stubResolver({ 'repo://agents/movie-assistant/uv.lock#L1-L9': 'new', 'repo://security/sast/allowlist.yaml#L1-L9': 'new', 'repo://docs/x.md#L1-L2': 'new' }) });
    assert.deepEqual(rows.map((r) => [r.page, r.churnOnly]), [['projects/agent-gateway.md', true], ['projects/sast.md', false]]);
    const text = formatAudit(rows, { version: '0.7.1' });
    assert.match(text, /FORCE 2 page\(s\)/);
    assert.match(text, /agent-gateway\.md .*churn citations only: avoidable/);
    assert.match(formatAudit([]), /will force nothing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cli: --claims-audit is a mode of its own', () => {
  assert.equal(parseArgs(['--claims-audit']).mode, 'claims-audit');
  assert.throws(() => parseArgs(['--claims-audit', '--plan']), /mutually exclusive/);
});
