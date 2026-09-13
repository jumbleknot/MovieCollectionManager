// Item #436 — the perl-base CRITICAL patch must cover EVERY image on the affected base.
//
// WHAT THIS CATCHES, and why a green cd-deploy does not. `scripts/cd/scan-push.sh` scans six images in a
// fixed order and FAILS FAST. On 2026-09-12 it stopped at `agent-gateway` (3rd) and never reached the three
// MCP servers, which carry the identical base and the identical three CRITICALs. So the failure named ONE
// image while FOUR were affected, and patching only the one it named would have produced a run that failed
// one image later — the same day, with the same three CVEs, looking like a new problem.
//
// A guard is the right shape here for a second reason: a NEW Python service added tomorrow would inherit
// the same base and ship unpatched, and nothing would say so until the next deploy.
//
// TIED TO THE DIGEST, DELIBERATELY. The requirement is keyed to the base digest that is known to carry
// perl-base 5.40.1-6. When Renovate moves the base, this guard stops demanding the patch by itself —
// because the patch is upstream LAG, not a permanent layer, and a guard that outlived its cause would
// convert a temporary workaround into a fixture nobody dares delete. cd-deploy's Trivy gate remains the
// backstop if a newer base still lacks the fix.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, globSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// The base known to carry perl-base 5.40.1-6 (measured against this digest, 2026-09-13:
// Installed 5.40.1-6 / Candidate 5.40.1-6+deb13u1 from trixie/main).
const AFFECTED_BASE = 'python:3.14-slim@sha256:cad9a2c871761c413caa6fdd6441c783451e740a48aaeba60ae62a8b53525ef6';

const dockerfiles = () =>
  globSync('{agents,mcp-servers,backend,frontend}/**/Dockerfile', { cwd: REPO_ROOT })
    .map((p) => ({ path: p, text: readFileSync(resolve(REPO_ROOT, p), 'utf8') }));

/**
 * The FINAL stage's lines. Trivy scans the built image, which is the last stage — so the build stage is
 * irrelevant to this CVE and must not be allowed to satisfy any assertion here. That is not theoretical:
 * `agents/movie-assistant` pins the SAME base in its build stage AND runs its own
 * `apt-get … && rm -rf /var/lib/apt/lists/*` there, so a whole-file check for the cleanup passes on the
 * build stage's line even when the patch's own cleanup has been deleted. Found by mutation-testing this
 * guard rather than by reading it.
 */
function finalStage(text) {
  const lines = text.split('\n');
  const starts = lines.map((l, i) => (/^FROM\s/.test(l) ? i : -1)).filter((i) => i >= 0);
  const from = starts.length ? starts[starts.length - 1] : 0;
  return { lines: lines.slice(from), fromLine: lines[from] ?? '' };
}

/** The one RUN block (continuations included) that performs the perl-base upgrade, or null. */
function perlPatchBlock(stageLines) {
  for (let i = 0; i < stageLines.length; i++) {
    if (!/^\s*RUN\s/.test(stageLines[i])) continue;
    const block = [stageLines[i]];
    let j = i;
    while (/\\\s*$/.test(stageLines[j]) && j + 1 < stageLines.length) block.push(stageLines[++j]);
    const joined = block.join('\n');
    if (/--only-upgrade/.test(joined) && /perl-base/.test(joined)) return { joined, start: i, end: j };
  }
  return null;
}

test('every image on the affected python base carries the perl-base upgrade in its FINAL stage (item #436)', () => {
  const affected = dockerfiles().filter((f) => finalStage(f.text).fromLine.includes(AFFECTED_BASE));

  // A count of 0 must not read as success — the shape this repository has been bitten by before.
  assert.ok(
    affected.length > 0,
    'No Dockerfile builds its FINAL stage on the affected base any more. If Renovate moved it, DELETE ' +
      "this guard and the `apt-get --only-upgrade perl-base` block it protects (item #436's removal " +
      'condition) — do not leave either sitting here unexercised.',
  );

  const unpatched = affected.filter((f) => !perlPatchBlock(finalStage(f.text).lines));
  assert.deepEqual(
    unpatched.map((f) => f.path).sort(),
    [],
    'Dockerfile(s) build their final stage on the perl-base-vulnerable pinned python base without the ' +
      'upgrade:\n' +
      unpatched.map((f) => `  ${f.path}`).join('\n') +
      '\n  cd-deploy scans images in a fixed order and FAILS FAST, so it blocks on whichever of these it ' +
      'reaches first and says nothing about the rest (item #436).',
  );
});

test('the perl-base upgrade runs as root, before the image drops privilege', () => {
  // `apt-get` after `USER app` fails with a permission error that reads as a broken build rather than as
  // a misordered Dockerfile. Every one of these images drops privilege (feature 034), so this is a real
  // constraint, not a stylistic one.
  for (const f of dockerfiles().filter((x) => finalStage(x.text).fromLine.includes(AFFECTED_BASE))) {
    const { lines } = finalStage(f.text);
    const patch = perlPatchBlock(lines);
    assert.ok(patch, `${f.path}: the perl-base upgrade is not in the final stage`);
    const userAt = lines.findIndex((l) => /^\s*USER\s+(?!root\b)/.test(l));
    assert.ok(userAt >= 0, `${f.path}: the final stage no longer drops privilege — check feature 034`);
    assert.ok(
      patch.start < userAt,
      `${f.path}: the perl-base upgrade is placed AFTER \`USER\`, so apt-get runs unprivileged and the ` +
        'build fails with a permission error that does not point at the ordering',
    );
  }
});

test('the upgrade cleans the apt lists WITHIN its own RUN, so the patch does not bloat the image', () => {
  // Asserted against the patch's OWN block, not the file: a cleanup in the build stage does nothing for
  // the shipped image, and checking the whole file lets it stand in for one that was deleted.
  for (const f of dockerfiles().filter((x) => finalStage(x.text).fromLine.includes(AFFECTED_BASE))) {
    const patch = perlPatchBlock(finalStage(f.text).lines);
    assert.ok(patch, `${f.path}: no perl-base upgrade block`);
    assert.match(
      patch.joined,
      /rm -rf \/var\/lib\/apt\/lists\/\*/,
      `${f.path}: the perl-base upgrade does not clean /var/lib/apt/lists inside its own RUN — a ` +
        'temporary patch should not permanently grow the image it patches',
    );
  }
});
