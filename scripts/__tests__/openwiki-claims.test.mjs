// The Markdown/Claims durability invariant (scripts/openwiki-claims.mjs) — items #611 and #616.
//
// openwiki 0.6.0 re-proves every page that has a `.page-manifest.json` entry before it will run
// (generation/page-manifest.js, buildManifestEntry): the page's `.claims` sidecar must exist, carry a
// `verification`, and record `pageVersion` equal to the sha256 of the page's current bytes. Anything
// else throws "Markdown and verified Claims are not durable" and fails the WHOLE run, not the page.
// Measured twice on 2026-09-29: a reviewer's hand edit (#606 → #610) and a run's own output (#615).
// Both passed every CI gate, because nothing checked this. These tests pin the check.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { claimsDurabilityFindings, carryClaimsHash } = await import(pathToFileURL(join(REPO_ROOT, 'scripts', 'openwiki-claims.mjs')).href);

const sha = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const PAGE = '---\ntype: Gotcha\ntitle: P\n---\nBody.\n';

/** A bundle directory holding one covered page, consistent unless told otherwise. */
function bundle({ page = PAGE, sidecar = undefined, manifest = undefined } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'claims-'));
  mkdirSync(join(dir, 'gotchas'), { recursive: true });
  mkdirSync(join(dir, '.claims', 'gotchas'), { recursive: true });
  if (page !== null) writeFileSync(join(dir, 'gotchas', 'p.md'), page);
  const sc = sidecar === undefined ? { pageVersion: sha(PAGE), verification: { by: 'openwiki/0.6.0', at: '2026-09-29T00:00:00Z' }, claims: [] } : sidecar;
  if (sc !== null) writeFileSync(join(dir, '.claims', 'gotchas', 'p.json'), `${JSON.stringify(sc, null, 2)}\n`);
  const mf = manifest === undefined ? { schemaVersion: 1, pages: { '/openwiki/gotchas/p.md': { pageVersion: sha(PAGE) } } } : manifest;
  if (mf !== null) writeFileSync(join(dir, '.page-manifest.json'), `${JSON.stringify(mf, null, 2)}\n`);
  return dir;
}

const within = (fn) => (...a) => { const dir = bundle(...a); try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); } };

test('durability: a consistent covered page has no findings', () => {
  within((dir) => assert.deepEqual(claimsDurabilityFindings(dir), []))();
});

test('durability: no manifest at all is not a finding (nothing is covered)', () => {
  within((dir) => assert.deepEqual(claimsDurabilityFindings(dir), []))({ manifest: null });
});

test('durability: a page edited after it was verified is a finding that names it and both fixes', () => {
  within((dir) => {
    const f = claimsDurabilityFindings(dir);
    assert.equal(f.length, 1);
    assert.equal(f[0].page, 'gotchas/p.md');
    assert.match(f[0].message, /sha256/);
    assert.match(f[0].message, /revert/i, 'names the revert fix');
    assert.match(f[0].message, /uncover/i, 'names the uncover fix');
  })({ page: `${PAGE}Hand edit.\n` });
});

test('durability: the #615 shape — front matter changed, sidecar still certifies the old bytes', () => {
  // Only front matter differs from the certified bytes (on #615 a `verified:` block was dropped).
  within((dir) => assert.equal(claimsDurabilityFindings(dir).length, 1))({ page: PAGE.replace('title: P\n', 'title: P\nextra: x\n') });
});

test('durability: a covered page with no sidecar, or a sidecar with no verification, is a finding', () => {
  within((dir) => assert.match(claimsDurabilityFindings(dir)[0].message, /sidecar/))({ sidecar: null });
  within((dir) => assert.match(claimsDurabilityFindings(dir)[0].message, /verification/))({ sidecar: { pageVersion: sha(PAGE), claims: [] } });
});

test('durability: a manifest entry whose page no longer exists is a finding', () => {
  within((dir) => assert.match(claimsDurabilityFindings(dir)[0].message, /does not exist/))({ page: null });
});

test('durability: the uncovered form passes — no manifest entry means OpenWiki leaves the page for full review', () => {
  within((dir) => assert.deepEqual(claimsDurabilityFindings(dir), []))({ page: `${PAGE}Hand edit.\n`, sidecar: null, manifest: { schemaVersion: 1, pages: {} } });
});

test('durability: an unparseable manifest or sidecar is a finding, never a silent pass', () => {
  const dir = bundle();
  try {
    writeFileSync(join(dir, '.page-manifest.json'), '{ not json');
    assert.match(claimsDurabilityFindings(dir)[0].message, /manifest/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('carry: a pure link rewrite of a CONSISTENT page moves the recorded hash with it', () => {
  within((dir) => {
    const after = PAGE.replace('Body.', 'Body [x](../a.md).');
    writeFileSync(join(dir, 'gotchas', 'p.md'), after);
    assert.equal(carryClaimsHash(dir, 'gotchas/p.md', PAGE, after), true);
    assert.deepEqual(claimsDurabilityFindings(dir), [], 'still durable after the harness rewrite');
    assert.match(readFileSync(join(dir, '.page-manifest.json'), 'utf8'), new RegExp(sha(after).slice(7)));
  })();
});

test('carry: an ALREADY-inconsistent page is not laundered by a rewrite', () => {
  within((dir) => {
    const before = `${PAGE}Hand edit.\n`;
    const after = before.replace('Body.', 'Body [x](../a.md).');
    writeFileSync(join(dir, 'gotchas', 'p.md'), after);
    assert.equal(carryClaimsHash(dir, 'gotchas/p.md', before, after), false);
    assert.equal(claimsDurabilityFindings(dir).length, 1, 'the pre-existing break stays visible');
  })({ page: `${PAGE}Hand edit.\n` });
});

test('carry: an uncovered page is left alone', () => {
  within((dir) => assert.equal(carryClaimsHash(dir, 'gotchas/p.md', PAGE, `${PAGE}x`), false))({ manifest: { schemaVersion: 1, pages: {} } });
});
