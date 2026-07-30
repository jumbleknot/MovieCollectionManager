// T013 — link integrity for the relocated live operator documents — feature 043 (FR-024, SC-006).
//
// Two documents under docs/proposals/homelab-setup/ are not proposals at all: they are the
// authoritative live procedures for operating the deployment pipeline and the server, cited by
// CLAUDE.md as such. Feature 043 excludes docs/proposals/** from the knowledge bundle, which would
// have hidden them — so they move to docs/runbooks/, where the bundle can carry a concept for each.
//
// This test asserts the move left no dangling reference behind. It scans the TRACKED tree (the same
// `git ls-files` set the leak gates use), so an untracked scratch file or a build cache cannot
// produce a false failure.
//
// Deterministic, offline, node: built-ins only — CI-enforced on every push by the
// `guardrails / naming` job's `node --test scripts/__tests__/*.test.mjs` glob.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const RELOCATED = [
  { name: 'Phase-15-Operator-Checklist.md', from: 'docs/proposals/homelab-setup', to: 'docs/runbooks' },
  { name: 'Server-Setup-Runbook.md', from: 'docs/proposals/homelab-setup', to: 'docs/runbooks' },
  // Feature 044 (FR-030a). Only the first of its eight sections is architecture; the other seven are
  // operational — the runbook tree is where a reader looks for them, and it is also the only tree the
  // regeneration policy classifies as `regenerate`-and-covered for a document of this kind.
  { name: 'agent-layer.md', from: 'docs', to: 'docs/runbooks' },
];

// The feature's own specification documents legitimately name the OLD paths — describing the move is
// their job. Excluding the feature folder keeps the assertion about live references, not history.
const EXCLUDED_PREFIXES = ['specs/043-openwiki-okf/', 'specs/044-openwiki-automation-migration/'];

function trackedFiles() {
  return execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((p) => !EXCLUDED_PREFIXES.some((prefix) => p.startsWith(prefix)));
}

function isProbablyText(relPath) {
  return /\.(md|ts|tsx|js|mjs|cjs|json|ya?ml|toml|rs|py|sh|ps1|txt)$/i.test(relPath);
}

test('no tracked file references either document at its pre-move location', () => {
  const offenders = [];
  for (const relPath of trackedFiles()) {
    if (!isProbablyText(relPath)) continue;
    const abs = join(REPO_ROOT, relPath);
    if (!existsSync(abs)) continue;
    let text;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    for (const doc of RELOCATED) {
      const oldPath = `${doc.from}/${doc.name}`;
      if (text.includes(oldPath)) offenders.push(`${relPath} → ${oldPath}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `stale references to a relocated operator document:\n  ${offenders.join('\n  ')}\n` +
      'Update each to the docs/runbooks/ location — a dangling link to an authoritative operating ' +
      'procedure is exactly the failure this relocation was meant to prevent.',
  );
});

// The bundle cites the moved document from two concepts. The OKF gate FAILS on an unresolvable
// repo-relative `resource`, so those two fields have to move in the same change as the file — this
// asserts they did.
test('every bundle concept citing a relocated document resolves to the new path', () => {
  const bundle = execFileSync('git', ['ls-files', 'openwiki'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split(/\r?\n/).filter((p) => p.endsWith('.md'));
  const citing = [];
  for (const relPath of bundle) {
    const text = readFileSync(join(REPO_ROOT, relPath), 'utf8');
    const resource = text.match(/^resource:\s*(.+)$/m)?.[1]?.trim();
    if (!resource) continue;
    for (const doc of RELOCATED) {
      if (resource === `${doc.from}/${doc.name}`) citing.push(`${relPath} → ${resource}`);
      if (resource === `${doc.to}/${doc.name}`) {
        assert.ok(existsSync(join(REPO_ROOT, resource)), `${relPath} cites ${resource}, which does not exist`);
      }
    }
  }
  assert.deepEqual(citing, [], `a concept still cites a pre-move path:\n  ${citing.join('\n  ')}`);
});

test('both documents exist at their new location', () => {
  for (const doc of RELOCATED) {
    const newPath = join(REPO_ROOT, doc.to, doc.name);
    assert.ok(existsSync(newPath), `${doc.to}/${doc.name} is missing — the relocation did not complete`);
  }
});

test('neither document remains at its old location', () => {
  for (const doc of RELOCATED) {
    const oldPath = join(REPO_ROOT, doc.from, doc.name);
    assert.ok(
      !existsSync(oldPath),
      `${doc.from}/${doc.name} still exists — a copy was left behind, so the bundle exclusion still hides it`,
    );
  }
});
