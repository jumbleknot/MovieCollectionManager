// Item #436 — no image may build on the python base known to carry the perl-base CRITICALs.
//
// HISTORY. On 2026-09-12 cd-deploy stopped at `scan-push` on three fixable CRITICALs in perl-base
// 5.40.1-6 (CVE-2026-13221, CVE-2026-42496, CVE-2026-8376) in `python:3.14-slim@sha256:cad9a2c8…`.
// Upstream had not rebuilt the base, so every Python image carried an `apt-get --only-upgrade perl-base`
// layer, and this guard demanded that layer on every final stage pinned to that digest.
//
// THE PREMISE NOW. `python:3.14-slim` was rebuilt on 2026-10-09 as `sha256:a2b82f3c…`, which ships
// perl-base 5.40.1-6+deb13u1 (measured: `dpkg-query -W perl-base` in that exact digest). The base moved
// and the patch layer was deleted from all four Dockerfiles, as the item's removal condition required.
// What remains worth guarding is the regression the patch existed for: a revert, a stale branch or a
// copy-pasted Dockerfile putting the vulnerable digest back WITHOUT the patch. cd-deploy's Trivy gate is
// the backstop for any newer base, but it scans in a fixed order and fails fast — so it would name one
// image while several were affected. This guard names all of them, before CI.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, globSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// The base measured to carry perl-base 5.40.1-6 (2026-09-13: Installed 5.40.1-6 / Candidate
// 5.40.1-6+deb13u1 from trixie/main). Keyed to the digest, not the tag: the tag is fine today.
const VULNERABLE_DIGEST = 'sha256:cad9a2c871761c413caa6fdd6441c783451e740a48aaeba60ae62a8b53525ef6';

const dockerfiles = () =>
  globSync('{agents,mcp-servers,backend,frontend}/**/Dockerfile', { cwd: REPO_ROOT })
    .map((p) => ({ path: p, text: readFileSync(resolve(REPO_ROOT, p), 'utf8') }));

test('the Dockerfile glob still finds the Python images, so the next assertion is not vacuous', () => {
  // A count of 0 must not read as success — the shape this repository has been bitten by before.
  const python = dockerfiles().filter((f) => /^FROM\s+python:/m.test(f.text));
  assert.ok(
    python.length >= 4,
    `expected the four Python images (movie-assistant + three MCP servers), found ${python.length}: ` +
      python.map((f) => f.path).join(', '),
  );
});

test('no Dockerfile pins the perl-base-vulnerable python digest (item #436)', () => {
  const offenders = dockerfiles()
    .filter((f) => f.text.includes(VULNERABLE_DIGEST))
    .map((f) => f.path)
    .sort();
  assert.deepEqual(
    offenders,
    [],
    'Dockerfile(s) pin python:3.14-slim at the digest that carries perl-base 5.40.1-6 (three fixable ' +
      'CRITICALs). Move to a base that ships perl-base >= 5.40.1-6+deb13u1 — do not reintroduce the ' +
      'item #436 `apt-get --only-upgrade perl-base` patch layer:\n' +
      offenders.map((p) => `  ${p}`).join('\n'),
  );
});
