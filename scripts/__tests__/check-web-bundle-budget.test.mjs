// Guards scripts/check-web-bundle-budget.mjs (feature 077, T014 — FR-012; US3-AC1/AC2).
//
// The gate exists because item #558's history is a win being spent without anyone noticing: the web
// bundle reached 4.28 MB one ordinary feature at a time, and the only thing that ever complained was
// a performance test whose failure looked like a timeout. This gate complains in bytes, at the point
// of change.
//
// The cases that matter are the ones where a plausible gate reports CLEAN and shouldn't:
//   - no entry chunk at all (an export that never ran);
//   - two entry chunks (the number it reports is not the number it claims);
//   - a deferred package back in the entry chunk while the byte budget still passes;
//   - server code in the DEFERRED chunk, which a gate reading only the entry chunk cannot see;
//   - a missing source map silently disabling the module assertions.
//
// Feature 087 adds the cold-load total and the inline-script allowlist, read from the exported HTML:
//   - no HTML, a page with no scripts, or a referenced script missing, each of which could read as clean;
//   - two chunks that fit the budget apart but not together, which an entry-only gate cannot see;
//   - an inline script the CSP does not allow, which is a blank page in a browser and invisible offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'check-web-bundle-budget.mjs');
const WEB = 'client/_expo/static/js/web';

const HYDRATE = '<script type="module">globalThis.__EXPO_ROUTER_HYDRATE__=true;</script>';
const scriptTag = (name) => `<script src="/_expo/static/js/web/${name}" defer></script>`;
const sha256 = (body) => `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`;

/**
 * Build a throwaway `dist` and run the gate over it.
 * `chunks` maps a filename to `{ size, sources }`; a map is emitted when `sources` is given.
 * `pages` maps a path under `dist/server` to its HTML. By default one page loads every entry chunk, as
 * an export does, so a case about chunks stays about chunks.
 */
function runGate(chunks, args = [], pages = undefined) {
  const root = mkdtempSync(join(tmpdir(), 'bundle-budget-'));
  const dir = join(root, WEB);
  mkdirSync(dir, { recursive: true });
  for (const [name, { size = 100, sources }] of Object.entries(chunks)) {
    writeFileSync(join(dir, name), 'x'.repeat(size));
    if (sources) {
      writeFileSync(join(dir, `${name}.map`), JSON.stringify({ version: 3, sources, mappings: '' }));
    }
  }
  const entries = Object.keys(chunks).filter((name) => name.startsWith('entry-'));
  const html = pages ?? { 'index.html': `<html>${HYDRATE}${entries.map(scriptTag).join('')}</html>` };
  mkdirSync(join(root, 'server'), { recursive: true });
  for (const [page, text] of Object.entries(html)) {
    mkdirSync(dirname(join(root, 'server', page)), { recursive: true });
    writeFileSync(join(root, 'server', page), text);
  }
  const r = spawnSync('node', [GATE, '--dist', root, ...args], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const CLEAN_SOURCES = ['/app/src/screens/home/home-screen.tsx', '/node_modules/expo-router/build/index.js'];

test('under budget passes, reporting measured and budget', () => {
  const { code, out } = runGate(
    { 'entry-abc.js': { size: 500, sources: CLEAN_SOURCES } },
    ['--budget', '1000'],
  );
  assert.equal(code, 0, out);
  assert.match(out, /500/, 'must report the measured size');
  assert.match(out, /1,?000/, 'must report the budget');
});

test('over budget fails, naming measured, budget AND overage', () => {
  const { code, out } = runGate(
    { 'entry-abc.js': { size: 1500, sources: CLEAN_SOURCES } },
    ['--budget', '1000'],
  );
  assert.equal(code, 1, out);
  assert.match(out, /1,?500/, 'measured');
  assert.match(out, /1,?000/, 'budget');
  assert.match(out, /500/, 'overage');
});

test('ZERO entry chunks fails — an export that never ran must not read as clean', () => {
  const { code, out } = runGate({ 'assistant-panel-x.js': { size: 10 } });
  assert.equal(code, 1, out);
  assert.match(out, /entry/i, out);
});

test('TWO entry chunks fails — the reported number would not be the claimed number', () => {
  const { code, out } = runGate({
    'entry-aaa.js': { size: 100, sources: CLEAN_SOURCES },
    'entry-bbb.js': { size: 100, sources: CLEAN_SOURCES },
  });
  assert.equal(code, 1, out);
  assert.match(out, /entry/i, out);
});

test('a deferred package back in the entry chunk fails, naming it, even UNDER budget', () => {
  // The byte budget measures the symptom; the module list measures the cause. A change that
  // re-imports the assistant at the root while something else shrinks would pass on bytes alone.
  const { code, out } = runGate(
    {
      'entry-abc.js': {
        size: 100,
        sources: [...CLEAN_SOURCES, '/node_modules/.pnpm/zod@3.25.76/node_modules/zod/lib/index.js'],
      },
    },
    ['--budget', '100000'],
  );
  assert.equal(code, 1, out);
  assert.match(out, /zod/, 'must name the package that came back');
});

test('text-encoding back in the entry chunk fails', () => {
  const { code, out } = runGate(
    { 'entry-abc.js': { size: 100, sources: [...CLEAN_SOURCES, '/node_modules/text-encoding/index.js'] } },
    ['--budget', '100000'],
  );
  assert.equal(code, 1, out);
  assert.match(out, /text-encoding/, out);
});

test('server code in the DEFERRED chunk fails — every client chunk is in scope', () => {
  // This is the case that distinguishes the server-module assertion from the entry-chunk one.
  // A gate reading only entry-*.js.map reports clean here.
  const { code, out } = runGate(
    {
      'entry-abc.js': { size: 100, sources: CLEAN_SOURCES },
      'assistant-panel-def.js': { size: 100, sources: ['/app/src/bff-server/backup-run-summary.ts'] },
    },
    ['--budget', '100000'],
  );
  assert.equal(code, 1, out);
  assert.match(out, /bff-server/, out);
  assert.match(out, /assistant-panel-def\.js/, 'must name the chunk it was found in');
});

test('luxon in any client chunk fails', () => {
  const { code, out } = runGate(
    {
      'entry-abc.js': { size: 100, sources: CLEAN_SOURCES },
      'assistant-panel-def.js': { size: 100, sources: ['/node_modules/luxon/src/datetime.js'] },
    },
    ['--budget', '100000'],
  );
  assert.equal(code, 1, out);
  assert.match(out, /luxon/, out);
});

test('a bff-server module in a client chunk FAILS — item #566 left no exemptions', () => {
  // `api-client.ts` was exempt while it lived there. Item #566 moved it to the Utils-Layer and an
  // audit confirmed every remaining bff-server module is genuinely server-only, so the exemption list
  // is empty and this path has no hole. A future genuine case gets BOTH a `@client-safe` marker in the
  // module and an entry in SERVER_ONLY_EXEMPT — never one without the other.
  const { code, out } = runGate(
    { 'entry-abc.js': { size: 100, sources: [...CLEAN_SOURCES, '/app/src/bff-server/api-client.ts'] } },
    ['--budget', '100000'],
  );
  assert.equal(code, 1, out);
  assert.match(out, /bff-server/, out);
});

test('the relocated api-client, in the Utils-Layer, is fine', () => {
  const { code, out } = runGate(
    { 'entry-abc.js': { size: 100, sources: [...CLEAN_SOURCES, '/app/src/utils/api-client.ts'] } },
    ['--budget', '100000'],
  );
  assert.equal(code, 0, out);
});

test('a missing source map keeps the size check and reports the SKIP on its own line', () => {
  // A silent skip here would leave the whole module half of the gate proving nothing.
  const { code, out } = runGate({ 'entry-abc.js': { size: 500 } }, ['--budget', '1000']);
  assert.equal(code, 0, out);
  assert.match(out, /skip/i, 'the skip must be visible');
});

test('--json emits machine-readable output', () => {
  const { code, out } = runGate(
    { 'entry-abc.js': { size: 500, sources: CLEAN_SOURCES } },
    ['--budget', '1000', '--json'],
  );
  assert.equal(code, 0, out);
  const parsed = JSON.parse(out);
  assert.equal(parsed.entryBytes, 500);
  assert.equal(parsed.budgetBytes, 1000);
});

test('--selftest exits 0 on a healthy gate', () => {
  const r = spawnSync('node', [GATE, '--selftest'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
});

test('an unknown flag exits 2 without scanning', () => {
  const r = spawnSync('node', [GATE, '--dry_run'], { encoding: 'utf8' });
  assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
});

test('a budget flag with no value exits 2 rather than guessing', () => {
  const r = spawnSync('node', [GATE, '--budget'], { encoding: 'utf8' });
  assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
});

test('--help exits 0 and names every flag', () => {
  const r = spawnSync('node', [GATE, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const out = `${r.stdout}${r.stderr}`;
  for (const flag of ['--dist', '--budget', '--json', '--selftest']) {
    assert.match(out, new RegExp(flag.replace('--', '--')), `usage must name ${flag}`);
  }
});

test('--require-maps turns a map-less export from a skip into a FAILURE', () => {
  // The nx target passes it. Without that, an export that stopped emitting `--source-maps` would
  // leave the byte budget as the only live assertion while the gate still printed OK.
  const bare = { 'entry-abc.js': { size: 100 } };
  assert.equal(runGate(bare, ['--budget', '1000']).code, 0, 'a skip by default');
  const { code, out } = runGate(bare, ['--budget', '1000', '--require-maps']);
  assert.equal(code, 1, out);
  assert.match(out, /source map/i, out);
  assert.match(out, /--source-maps/, 'must name the flag that fixes it');
});

test('--require-maps passes when the maps are there', () => {
  const { code, out } = runGate(
    { 'entry-abc.js': { size: 100, sources: CLEAN_SOURCES } },
    ['--budget', '1000', '--require-maps'],
  );
  assert.equal(code, 0, out);
});

const ENTRY = { 'entry-abc.js': { size: 100, sources: CLEAN_SOURCES } };

test('NO HTML fails, naming the directory — an export without pages must not read as clean', () => {
  const { code, out } = runGate(ENTRY, ['--budget', '1000'], {});
  assert.equal(code, 1, out);
  assert.match(out, /no .*\.html/i, out);
  assert.match(out, /server/, out);
});

test('a page that loads no script fails, naming the page', () => {
  const { code, out } = runGate(ENTRY, ['--budget', '1000'], {
    'index.html': `<html>${HYDRATE}${scriptTag('entry-abc.js')}</html>`,
    '(auth)/login.html': `<html>${HYDRATE}</html>`,
  });
  assert.equal(code, 1, out);
  assert.match(out, /\(auth\)\/login\.html/, out);
  assert.match(out, /no .*script/i, out);
});

test('a referenced script missing on disk fails, naming the page and the file', () => {
  const { code, out } = runGate(ENTRY, ['--budget', '1000'], {
    'index.html': `<html>${HYDRATE}${scriptTag('entry-abc.js')}${scriptTag('gone-123.js')}</html>`,
  });
  assert.equal(code, 1, out);
  assert.match(out, /index\.html/, out);
  assert.match(out, /gone-123\.js/, out);
});

test('two chunks that fit the budget apart but not together fail, naming page, bytes, budget, overage and each script', () => {
  const chunks = {
    'entry-abc.js': { size: 600, sources: CLEAN_SOURCES },
    'route-def.js': { size: 700, sources: CLEAN_SOURCES },
  };
  const pages = { 'collections.html': `<html>${HYDRATE}${scriptTag('entry-abc.js')}${scriptTag('route-def.js')}</html>` };
  const { code, out } = runGate(chunks, ['--budget', '1000'], pages);
  assert.equal(code, 1, out);
  assert.match(out, /collections\.html/, 'page');
  assert.match(out, /1,?300/, 'bytes');
  assert.match(out, /1,?000/, 'budget');
  assert.match(out, /OVER BY 300/, 'overage');
  assert.match(out, /entry-abc\.js/, 'first script');
  assert.match(out, /route-def\.js/, 'second script');
  assert.equal(runGate(chunks, ['--budget', '1300'], pages).code, 0, 'exactly at budget passes');
});

test('the budget is measured on the WORST page, and a deferred chunk no page loads is not counted', () => {
  const chunks = {
    'entry-abc.js': { size: 500, sources: CLEAN_SOURCES },
    'route-def.js': { size: 200, sources: CLEAN_SOURCES },
    'assistant-panel-ghi.js': { size: 5000, sources: CLEAN_SOURCES },
  };
  const { code, out } = runGate(chunks, ['--budget', '1000', '--json'], {
    'a.html': `<html>${HYDRATE}${scriptTag('entry-abc.js')}</html>`,
    'b.html': `<html>${HYDRATE}${scriptTag('entry-abc.js')}${scriptTag('route-def.js')}</html>`,
  });
  assert.equal(code, 0, out);
  const parsed = JSON.parse(out);
  assert.equal(parsed.coldLoad.worstPage, 'b.html');
  assert.equal(parsed.coldLoad.worstBytes, 700);
  assert.deepEqual(parsed.coldLoad.scripts, ['entry-abc.js', 'route-def.js']);
  assert.equal(parsed.coldLoad.pages, 2);
  assert.equal(parsed.overBy, -300);
  assert.equal(parsed.spare, 300);
});

test('an unlisted inline script fails, reporting its page and the exact hash a browser computes', () => {
  const body = 'window.__injected=1;';
  const { code, out } = runGate(ENTRY, ['--budget', '1000'], {
    'index.html': `<html>${HYDRATE}${scriptTag('entry-abc.js')}</html>`,
    'settings.html': `<html>${HYDRATE}<script>${body}</script>${scriptTag('entry-abc.js')}</html>`,
  });
  assert.equal(code, 1, out);
  assert.match(out, /settings\.html/, out);
  assert.ok(out.includes(sha256(body)), out);
});

test('an inline data block is not exempt: one appearing deserves a decision', () => {
  const { code, out } = runGate(ENTRY, ['--budget', '1000'], {
    'index.html': `<html>${HYDRATE}<script type="application/json">{"a":1}</script>${scriptTag('entry-abc.js')}</html>`,
  });
  assert.equal(code, 1, out);
  assert.ok(out.includes(sha256('{"a":1}')), out);
});

test('the allow-listed inline script passes, and is reported with how many pages carry it', () => {
  const { code, out } = runGate(ENTRY, ['--budget', '1000', '--json']);
  assert.equal(code, 0, out);
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed.inlineScripts.seen, [
    { hash: sha256('globalThis.__EXPO_ROUTER_HYDRATE__=true;'), pages: 1 },
  ]);
  assert.deepEqual(parsed.inlineScripts.unlisted, []);
});
