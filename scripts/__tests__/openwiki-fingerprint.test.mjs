// The source fingerprint of a derived openwiki page (feature 098, research R1): `resource-sha256` is
// the SHA-256 of the page's single `resource` file after CRLF→LF normalisation. V17 in the OKF gate
// and `wiki-refresh.mjs --stale` both call `staleDerivedPages`, so the two can never disagree.
//
// Every case builds its own bundle in a temp directory: the real tree is not fresh until the
// cut-over (T026), and a test that read it would be measuring the migration, not the module.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { sourceFingerprint, staleDerivedPages, recordSourceFingerprint } = await import(
  pathToFileURL(join(REPO_ROOT, 'scripts', 'openwiki-fingerprint.mjs')).href
);

const sha = (s) => createHash('sha256').update(s).digest('hex');

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'openwiki-fp-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return root;
}

const SOURCE = '# Source\n\nline one\nline two\n';
const page = (extra = '', resource = 'docs/src.md') =>
  `---\ntype: Runbook\ntitle: A\nresource: ${resource}\n${extra}tags: [a]\n---\n# A\n\nbody text\n`;

const stale = (root) => staleDerivedPages({ root }).map((s) => `${s.page}|${s.resource}|${s.reason}`);

test('sourceFingerprint: SHA-256 of the bytes, and an LF file and its CRLF copy hash equal', (t) => {
  const root = fixture({ 'lf.md': SOURCE, 'crlf.md': SOURCE.replace(/\n/g, '\r\n') });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(sourceFingerprint(join(root, 'lf.md')), sha(SOURCE));
  assert.equal(sourceFingerprint(join(root, 'crlf.md')), sha(SOURCE));
  assert.match(sourceFingerprint(join(root, 'lf.md')), /^[0-9a-f]{64}$/);
});

test('staleDerivedPages: a fresh page reports nothing', (t) => {
  const root = fixture({ 'docs/src.md': SOURCE, 'openwiki/runbooks/a.md': page(`resource-sha256: ${sha(SOURCE)}\n`) });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(stale(root), []);
});

test('staleDerivedPages: a byte edit to the source is `source changed`', (t) => {
  const root = fixture({ 'docs/src.md': `${SOURCE}new line\n`, 'openwiki/runbooks/a.md': page(`resource-sha256: ${sha(SOURCE)}\n`) });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(stale(root), ['openwiki/runbooks/a.md|docs/src.md|source changed']);
});

test('staleDerivedPages: a CRLF checkout of an unchanged source is still fresh', (t) => {
  const root = fixture({ 'docs/src.md': SOURCE.replace(/\n/g, '\r\n'), 'openwiki/runbooks/a.md': page(`resource-sha256: ${sha(SOURCE)}\n`) });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(stale(root), []);
});

test('staleDerivedPages: a missing `resource-sha256` is `no fingerprint`', (t) => {
  const root = fixture({ 'docs/src.md': SOURCE, 'openwiki/runbooks/a.md': page() });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(stale(root), ['openwiki/runbooks/a.md|docs/src.md|no fingerprint']);
});

test('staleDerivedPages: a fingerprint that is not 64 lowercase hex is `no fingerprint`', (t) => {
  const root = fixture({
    'docs/src.md': SOURCE,
    'openwiki/runbooks/short.md': page('resource-sha256: abc123\n'),
    'openwiki/runbooks/upper.md': page(`resource-sha256: ${sha(SOURCE).toUpperCase()}\n`),
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(stale(root), [
    'openwiki/runbooks/short.md|docs/src.md|no fingerprint',
    'openwiki/runbooks/upper.md|docs/src.md|no fingerprint',
  ]);
});

test('staleDerivedPages: a deleted resource is `resource missing`, ahead of the fingerprint', (t) => {
  const root = fixture({ 'openwiki/runbooks/a.md': page(`resource-sha256: ${sha(SOURCE)}\n`), 'openwiki/runbooks/b.md': page() });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(stale(root), [
    'openwiki/runbooks/a.md|docs/src.md|resource missing',
    'openwiki/runbooks/b.md|docs/src.md|resource missing',
  ]);
});

test('staleDerivedPages: retired `sources` and `verified` are forbidden fields', (t) => {
  const root = fixture({
    'docs/src.md': SOURCE,
    'openwiki/runbooks/s.md': page(`resource-sha256: ${sha(SOURCE)}\nsources:\n  - id: openwiki-source-1\n    resource: repo://docs/src.md\n`),
    'openwiki/runbooks/v.md': page(`resource-sha256: ${sha(SOURCE)}\nverified:\n  - by: openwiki/0.6.0\n    at: 2026-10-04T21:27:12.854Z\n`),
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(stale(root), [
    'openwiki/runbooks/s.md|docs/src.md|forbidden field: sources',
    'openwiki/runbooks/v.md|docs/src.md|forbidden field: verified',
  ]);
});

test('staleDerivedPages: precedence — resource missing, then no fingerprint, then source changed, then a forbidden field', (t) => {
  const root = fixture({
    'docs/src.md': `${SOURCE}changed\n`,
    // Missing resource AND no fingerprint AND a forbidden field: the missing resource wins.
    'openwiki/runbooks/a.md': page('sources: []\n', 'docs/gone.md'),
    // No fingerprint AND a forbidden field: the fingerprint wins.
    'openwiki/runbooks/b.md': page('verified: []\n'),
    // Stale AND a forbidden field: the stale source wins.
    'openwiki/runbooks/c.md': page(`resource-sha256: ${sha(SOURCE)}\nsources: []\n`),
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(stale(root), [
    'openwiki/runbooks/a.md|docs/gone.md|resource missing',
    'openwiki/runbooks/b.md|docs/src.md|no fingerprint',
    'openwiki/runbooks/c.md|docs/src.md|source changed',
  ]);
});

test('staleDerivedPages: a canonical page (no `resource`) and the reserved files are never evaluated', (t) => {
  const root = fixture({
    'openwiki/invariants/canon.md': '---\ntype: Invariant\ntitle: C\nsources: []\n---\n# C\n',
    'openwiki/index.md': '# Index\n',
    'openwiki/INSTRUCTIONS.md': '# Brief\n',
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(stale(root), []);
});

test('staleDerivedPages: all three pages that share one resource are named', (t) => {
  const root = fixture({
    'docs/src.md': `${SOURCE}changed\n`,
    'openwiki/architecture/x.md': page(`resource-sha256: ${sha(SOURCE)}\n`),
    'openwiki/projects/y.md': page(`resource-sha256: ${sha(SOURCE)}\n`),
    'openwiki/projects/z.md': page(`resource-sha256: ${sha(SOURCE)}\n`),
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(stale(root).map((s) => s.split('|')[0]), [
    'openwiki/architecture/x.md',
    'openwiki/projects/y.md',
    'openwiki/projects/z.md',
  ]);
});

test('recordSourceFingerprint: writes only resource-sha256 and timestamp, strips sources/verified, body byte-identical', (t) => {
  const body = '# A\n\nbody text — with an em-dash\n\n```yaml\nsources:\n  - not front matter\n```\n';
  const original =
    '---\ntype: Runbook\ntitle: A\nresource: docs/src.md\ntags: [a]\n' +
    'sources:\n  - id: openwiki-source-1\n    resource: repo://docs/src.md\n' +
    'generated: { by: "openwiki/0.6.0", at: "2026-10-04T21:27:12.854Z" }\n' +
    'verified:\n  - by: openwiki/0.6.0\n    at: 2026-10-04T21:27:12.854Z\n' +
    '---\n' + body;
  const root = fixture({ 'docs/src.md': SOURCE, 'openwiki/runbooks/a.md': original });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pagePath = join(root, 'openwiki/runbooks/a.md');

  const r = recordSourceFingerprint(pagePath, { root, now: new Date('2026-11-10T12:00:00.000Z') });
  assert.equal(r.fingerprint, sha(SOURCE));

  const after = readFileSync(pagePath, 'utf8');
  assert.equal(
    after,
    '---\ntype: Runbook\ntitle: A\nresource: docs/src.md\n' +
      `resource-sha256: ${sha(SOURCE)}\n` +
      'tags: [a]\n' +
      'generated: { by: "openwiki/0.6.0", at: "2026-10-04T21:27:12.854Z" }\n' +
      'timestamp: 2026-11-10T12:00:00.000Z\n' +
      '---\n' + body,
  );
  assert.deepEqual(stale(root), []);
});

test('recordSourceFingerprint: re-recording replaces both keys in place rather than duplicating them', (t) => {
  const root = fixture({ 'docs/src.md': SOURCE, 'openwiki/runbooks/a.md': page('timestamp: 2001-01-01T00:00:00Z\n') });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pagePath = join(root, 'openwiki/runbooks/a.md');
  recordSourceFingerprint(pagePath, { root, now: new Date('2026-11-10T00:00:00.000Z') });
  writeFileSync(join(root, 'docs/src.md'), `${SOURCE}more\n`);
  recordSourceFingerprint(pagePath, { root, now: new Date('2026-11-11T00:00:00.000Z') });
  const fm = readFileSync(pagePath, 'utf8').split('\n---\n')[0];
  assert.equal(fm.match(/^resource-sha256:/gm).length, 1);
  assert.equal(fm.match(/^timestamp:/gm).length, 1);
  assert.match(fm, /^timestamp: 2026-11-11T00:00:00\.000Z$/m);
  assert.match(fm, new RegExp(`^resource-sha256: ${sha(`${SOURCE}more\n`)}$`, 'm'));
});

test('recordSourceFingerprint: a CRLF page keeps CRLF line endings', (t) => {
  const crlf = page().replace(/\n/g, '\r\n');
  const root = fixture({ 'docs/src.md': SOURCE, 'openwiki/runbooks/a.md': crlf });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pagePath = join(root, 'openwiki/runbooks/a.md');
  recordSourceFingerprint(pagePath, { root, now: new Date('2026-11-10T00:00:00.000Z') });
  const after = readFileSync(pagePath, 'utf8');
  assert.ok(!/[^\r]\n/.test(after), 'every newline is still CRLF');
  assert.ok(after.endsWith('# A\r\n\r\nbody text\r\n'));
  assert.deepEqual(stale(root), []);
});

test('recordSourceFingerprint: refuses a canonical page and a page whose resource is missing', (t) => {
  const root = fixture({
    'openwiki/invariants/canon.md': '---\ntype: Invariant\ntitle: C\n---\n# C\n',
    'openwiki/runbooks/gone.md': page('', 'docs/gone.md'),
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => recordSourceFingerprint(join(root, 'openwiki/invariants/canon.md'), { root }), /not a derived page/);
  assert.throws(() => recordSourceFingerprint(join(root, 'openwiki/runbooks/gone.md'), { root }), /resource missing/);
});
