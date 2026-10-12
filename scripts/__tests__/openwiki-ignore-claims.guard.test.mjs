// Item #739. `.openwikiignore` keeps openwiki from reading or citing a path, which is how churn files
// (CD digest pins, lockfiles, the rotating SAST allowlist) are kept out of Claims evidence. But a path
// added there while a `.claims` sidecar still cites it CRASHES openwiki's claims preflight
// (EvidenceResourceError, which preflight does not catch): every later run dies before writing a page.
// This guard reads the real ignore file and every real sidecar, so that state cannot be committed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** gitignore-style patterns as used in .openwikiignore: `**\/`, `*`, `?`, leading `/` anchors. */
export function ignorePatterns(text) {
  return text.split(/\r?\n/u).map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#') && !l.startsWith('!'))
    .map((p) => {
      const anchored = p.startsWith('/') || p.replace(/\/$/u, '').includes('/') && !p.startsWith('**/');
      const body = p.replace(/^\//u, '').replace(/\/$/u, '');
      const re = body.split(/(\*\*\/|\*\*|\*|\?)/u).map((t) => (t === '**/' ? '(?:.*/)?' : t === '**' ? '.*' : t === '*' ? '[^/]*' : t === '?' ? '[^/]'
        : t.replace(/[.+^${}()|[\]\\]/gu, '\\$&'))).join('');
      return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${re}(?:/.*)?$`, 'u');
    });
}

const ignored = (patterns, path) => patterns.some((re) => re.test(path));

function sidecars(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? sidecars(join(dir, d.name)) : d.name.endsWith('.json') ? [join(dir, d.name)] : []);
}

test('#739 matcher: the patterns in use match what openwiki ignores', () => {
  const p = ignorePatterns('**/.env.deploy\n**/pnpm-lock.yaml\nsecurity/sast/allowlist.yaml\n# c\n');
  assert.ok(ignored(p, 'infrastructure-as-code/docker/bff/.env.deploy'));
  assert.ok(ignored(p, 'pnpm-lock.yaml'), '**/ also matches at the root, as in gitignore');
  assert.ok(ignored(p, 'tools/openwiki-generator/pnpm-lock.yaml'));
  assert.ok(ignored(p, 'security/sast/allowlist.yaml'));
  assert.ok(!ignored(p, 'docs/security/sast/allowlist.yaml'), 'a path with a slash is anchored to the root');
  assert.ok(!ignored(p, 'security/sast/README.md'));
});

test('#739: no Claims sidecar cites a path that .openwikiignore excludes (that state crashes openwiki preflight)', () => {
  const patterns = ignorePatterns(readFileSync(join(REPO_ROOT, '.openwikiignore'), 'utf8'));
  const offenders = [];
  for (const file of sidecars(join(REPO_ROOT, 'openwiki', '.claims'))) {
    for (const claim of JSON.parse(readFileSync(file, 'utf8')).claims ?? []) {
      for (const e of claim.evidence ?? []) {
        const path = /^repo:\/\/([^#?]+)/u.exec(e.resource)?.[1];
        if (path && ignored(patterns, path)) offenders.push(`${file.slice(REPO_ROOT.length + 1)}: ${claim.id} → ${e.resource}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `remove these citations (or uncover their pages) before ignoring the path:\n${offenders.join('\n')}`);
});
