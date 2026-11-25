// Every relative link in docs/MCM-Learnings.md resolves — item #1133.
//
// The ledger's "Canonical home" column is the whole point of a ledger line: it says where the
// learning actually lives. A dead link there is a lesson nobody can follow, and nothing else checks
// this file (the OKF gate's V15 covers openwiki/ only).
//
// A link resolves when its target is a TRACKED file, or a directory holding tracked files, at the
// path the link names relative to the document. Tracked, not merely present on disk: an untracked
// or gitignored local file would pass here and 404 on the forge. Site-root links (`/docs/x.md`)
// fail too: the forge resolves a leading `/` against the site, not the repository (see
// scripts/openwiki-links.mjs). In-page anchors and external URLs are not checked.
//
// Deterministic, offline, node: built-ins plus the shared link scanner.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bodyLinks, classifyBodyLink, splitTarget } from '../openwiki-links.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DOC = 'docs/MCM-Learnings.md';

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const trackedSet = new Set(tracked);
const trackedDirs = new Set(
  tracked.flatMap((path) => {
    const parts = path.split('/');
    return parts.slice(1).map((_, i) => parts.slice(0, i + 1).join('/'));
  }),
);

/** The links in `text` (a document at repo-relative `docPath`) that do not resolve. */
function brokenLinks(text, docPath) {
  const broken = [];
  for (const link of bodyLinks(text)) {
    const kind = classifyBodyLink(link.target).kind;
    if (kind === 'skip') continue;
    if (kind === 'site-root') {
      broken.push(`line ${link.line}: ${link.target} (site-root link; write it relative)`);
      continue;
    }
    const { path } = splitTarget(link.target);
    const target = posix.normalize(posix.join(posix.dirname(docPath), path)).replace(/\/$/, '');
    if (target.startsWith('..')) {
      broken.push(`line ${link.line}: ${link.target} (outside the repository)`);
    } else if (!trackedSet.has(target) && !trackedDirs.has(target)) {
      broken.push(`line ${link.line}: ${link.target} (no tracked file or directory ${target})`);
    }
  }
  return broken;
}

test(`every relative link in ${DOC} resolves to a tracked file or directory`, () => {
  const text = readFileSync(resolve(REPO_ROOT, DOC), 'utf8');
  const links = bodyLinks(text).filter((l) => classifyBodyLink(l.target).kind !== 'skip');
  assert.ok(links.length > 20, `expected the ledger's links, found ${links.length}: is the scan broken?`);
  const broken = brokenLinks(text, DOC);
  assert.deepEqual(broken, [], `broken links in ${DOC}:\n  ${broken.join('\n  ')}`);
});

test('the check fails on a broken relative link, and passes the forms that resolve (control)', () => {
  const sample = [
    '[ok file](../AGENTS.md) [ok dir](../specs) [ok anchor](runbooks/doc-drift.md#the-quarterly-drift-audit-layer-3)',
    '[in page](#part-1) [web](https://example.invalid/x) `[code](nowhere.md)`',
    '[dead](runbooks/no-such-runbook.md) [root](/docs/MCM-Learnings.md) [escape](../../outside.md)',
  ].join('\n');
  const broken = brokenLinks(sample, DOC);
  assert.equal(broken.length, 3, broken.join('\n'));
  assert.match(broken[0], /no-such-runbook\.md/);
  assert.match(broken[1], /site-root/);
  assert.match(broken[2], /outside the repository/);
});
