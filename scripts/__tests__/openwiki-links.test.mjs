// Body-link scanning and normalization (scripts/openwiki-links.mjs) — item #491.
//
// The module is shared by the OKF gate (rules V14/V15) and by the generator's post-slice
// normalizer in scripts/wiki-maintain.mjs, so a defect here is a defect in both at once. These
// tests pin the two properties that make that sharing safe: the scanner is length-preserving, and
// normalization moves NOTHING but the target inside `](…)`.
//
// Deterministic, offline, token-free, node: built-ins only — CI-enforced on every push by the
// `guardrails / naming` job's `node --test scripts/__tests__/*.test.mjs` glob.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { maskCode, bodyLinks, classifyBodyLink, relativeFormFor, splitTarget, normalizeLinks } from '../openwiki-links.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// ── maskCode ────────────────────────────────────────────────────────────────────
test('maskCode preserves length exactly', () => {
  // Load-bearing: offsets from the masked text are spliced into the ORIGINAL text. If masking
  // changed the length, every rewrite after the first code span would land in the wrong place.
  const t = 'a `code` b\n\n```js\nconst x = 1;\n```\n\ntail\n';
  assert.equal(maskCode(t).length, t.length);
  assert.equal(maskCode(t).split('\n').length, t.split('\n').length);
});

test('maskCode blanks fences and code spans but leaves prose alone', () => {
  const masked = maskCode('keep `drop` keep\n```\ndrop\n```\nkeep\n');
  assert.match(masked, /keep/);
  assert.doesNotMatch(masked, /drop/);
});

test('maskCode closes a fence only on a matching-or-longer marker of the same kind', () => {
  // A ``` inside a ````-fenced block must not end it, or the rest of the file is scanned as prose.
  const t = '````\n```\n[x](/openwiki/a.md)\n````\n[y](/openwiki/b.md)\n';
  assert.deepEqual(bodyLinks(t).map((l) => l.target), ['/openwiki/b.md']);
});

// ── bodyLinks ───────────────────────────────────────────────────────────────────
test('bodyLinks reports offsets that index the ORIGINAL text', () => {
  const t = 'x [A](/a.md) y [B](/b.md) z';
  for (const l of bodyLinks(t)) {
    assert.equal(t.slice(l.targetIndex, l.targetIndex + l.targetLength), l.target);
  }
});

test('bodyLinks finds images, titled links and angle-bracket targets', () => {
  const t = '![i](img.png) [t](a.md "Title") [b](<b c.md>)';
  assert.deepEqual(bodyLinks(t).map((l) => l.target), ['img.png', 'a.md', 'b c.md']);
});

test('bodyLinks reports a 1-based line number', () => {
  assert.equal(bodyLinks('one\ntwo\n[x](a.md)\n')[0].line, 3);
});

// ── classifyBodyLink ────────────────────────────────────────────────────────────
test('classifyBodyLink separates site-root from relative, and skips what is not ours', () => {
  assert.equal(classifyBodyLink('/openwiki/a.md').kind, 'site-root');
  assert.equal(classifyBodyLink('a.md').kind, 'relative');
  assert.equal(classifyBodyLink('../a.md').kind, 'relative');
  for (const skip of ['#anchor', '', 'https://example.invalid/x', 'mailto:a@b.c', '//cdn.example/x']) {
    assert.equal(classifyBodyLink(skip).kind, 'skip', `${skip} should be skipped`);
  }
});

test('a protocol-relative URL is not mistaken for a site-root path', () => {
  // `//host/x` starts with `/` but is an absolute URL. Rewriting it would break a working link.
  const { text, rewrites } = normalizeLinks('[x](//cdn.example/a.md)\n', '/r/openwiki/p.md', '/r');
  assert.deepEqual(rewrites, []);
  assert.equal(text, '[x](//cdn.example/a.md)\n');
});

// ── splitTarget / relativeFormFor ───────────────────────────────────────────────
test('splitTarget separates a fragment from a percent-escaped path', () => {
  const s = splitTarget('b%20c.md#section');
  assert.equal(s.path, 'b c.md');
  assert.equal(s.suffix, '#section');
});

test('relativeFormFor keeps the fragment and points at the same file', () => {
  assert.equal(relativeFormFor('/r/openwiki/runbooks/p.md', '/openwiki/gotchas/g.md#why', '/r'), '../gotchas/g.md#why');
  assert.equal(relativeFormFor('/r/openwiki/p.md', '/docs/runbooks/d.md', '/r'), '../docs/runbooks/d.md');
  assert.equal(relativeFormFor('/r/openwiki/p.md', '/openwiki/q.md', '/r'), './q.md');
});

// ── normalizeLinks ──────────────────────────────────────────────────────────────
test('normalizeLinks rewrites every site-root link and touches nothing else', () => {
  const before = 'Prose with `[skip](/openwiki/x.md)` and:\n\n```\n[skip](/openwiki/y.md)\n```\n\n' +
    '[A](/openwiki/a.md), [B](/docs/b.md), [C](../c.md), [D](https://example.invalid/d).\n';
  const { text, rewrites } = normalizeLinks(before, '/r/openwiki/runbooks/p.md', '/r');
  assert.deepEqual(rewrites.map((r) => [r.from, r.to]), [
    ['/openwiki/a.md', '../a.md'],
    ['/docs/b.md', '../../docs/b.md'],
  ]);
  assert.match(text, /\[A\]\(\.\.\/a\.md\), \[B\]\(\.\.\/\.\.\/docs\/b\.md\), \[C\]\(\.\.\/c\.md\), \[D\]\(https:\/\/example\.invalid\/d\)\./);
  assert.match(text, /`\[skip\]\(\/openwiki\/x\.md\)`/, 'a code span must be left exactly as written');
  assert.match(text, /\n\[skip\]\(\/openwiki\/y\.md\)\n/, 'a fenced sample must be left exactly as written');
});

test('normalizeLinks handles several links on one line without corrupting offsets', () => {
  // Splices run back-to-front for exactly this case; front-to-back shifts every later target.
  const { text } = normalizeLinks('[a](/openwiki/aaaaaaaa.md) [b](/openwiki/b.md) [c](/openwiki/cc.md)\n',
    '/r/openwiki/p.md', '/r');
  assert.equal(text, '[a](./aaaaaaaa.md) [b](./b.md) [c](./cc.md)\n');
});

test('normalizeLinks is idempotent', () => {
  const once = normalizeLinks('[a](/openwiki/a.md)\n', '/r/openwiki/runbooks/p.md', '/r');
  const twice = normalizeLinks(once.text, '/r/openwiki/runbooks/p.md', '/r');
  assert.equal(twice.text, once.text);
  assert.deepEqual(twice.rewrites, []);
});

test('normalizeLinks changes only link targets — the rest of the file is byte-identical', () => {
  const before = '# Title\n\nParagraph with (parentheses) and /slashes/ and [A](/openwiki/a.md).\n\n> quote\n';
  const { text } = normalizeLinks(before, '/r/openwiki/p.md', '/r');
  const blank = (t) => t.replace(/(!?\[[^\]]*\]\(\s*<?)([^)\s>]+)/g, (m, lead) => `${lead}@`);
  assert.equal(blank(text), blank(before));
});

// ── the CLI mode the bundle-wide sweep goes through ─────────────────────────────
function runMaintain(args, cwd) {
  const r = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'wiki-maintain.mjs'), ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' },
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

test('--normalize-links --dry-run reports the rewrites and writes nothing', () => {
  const { code, out } = runMaintain(['--normalize-links', '--dry-run'], REPO_ROOT);
  assert.equal(code, 0, out);
  // The shipped bundle is already normalized, so a dry run over it must find nothing to do.
  assert.match(out, /0 link\(s\) in 0 file\(s\) would be rewritten/);
  // UNCHANGED, not clean: this suite runs on a working tree that may legitimately be dirty, so
  // asserting cleanliness would fail for a reason that has nothing to do with the dry run.
  const status = () => spawnSync('git', ['status', '--porcelain', '--', 'openwiki'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout;
  const before = status();
  runMaintain(['--normalize-links', '--dry-run'], REPO_ROOT);
  assert.equal(status(), before, 'a dry run must leave the working tree exactly as it found it');
});

test('--normalize-links is offered in the usage text and rejects an unknown flag', () => {
  assert.match(runMaintain(['--nope'], REPO_ROOT).out, /--normalize-links/);
  assert.equal(runMaintain(['--nope'], REPO_ROOT).code, 2);
});
