#!/usr/bin/env node
// The web cold-load budget (feature 077, FR-012; item #558).
//
// WHY A BYTE BUDGET AND A MODULE LIST, not either alone. Item #558's history is a win being spent
// without anyone noticing: the web client reached a single 4,283,369-byte chunk one ordinary feature
// at a time, and the only thing that ever objected was a performance test whose failure presented as
// a locator timeout. Feature 077 took the entry chunk to 1,762,630 B by deferring the assistant
// runtime and splitting the React Native polyfill loader by platform. This gate is what stops that
// being quietly given back.
//
// Four assertions, and the third is scoped wider than the first two on purpose:
//
//   1. COLD-LOAD TOTAL vs budget. Feature 087: the sum of every script the worst page loads, read from
//      the exported HTML, because a split bundle can fit chunk by chunk and still be too big to load.
//      This is the thing users feel. Pages with no HTML, no scripts, or a script missing on disk all
//      fail, because each could otherwise read as clean.
//   2. DEFERRED PACKAGES absent from the ENTRY chunk. Size alone is satisfiable by a change that
//      re-imports the assistant at the root while something else happens to shrink. The byte budget
//      measures the symptom; this measures the cause, and names the package rather than leaving an
//      unexplained size jump.
//   3. SERVER-ONLY CODE absent from EVERY client chunk. Assertions 1-2 are about the cold-load path,
//      so the entry chunk is their subject. Server code shipping to a browser is wrong wherever it
//      lands, so this one reads every chunk's map — a gate reading only the entry chunk would report
//      clean while `src/bff-server/**` shipped inside the deferred chunk.
//
// ASSERTION (3) HAS NO EXEMPTIONS, and that is what item #566 bought. `api-client.ts` used to be one:
// the browser's axios transport TO the BFF, client code sitting in a directory named after what it
// talks to. It moved to the Utils-Layer, and an audit confirmed every remaining `src/bff-server/**`
// module is genuinely server-only (mongodb, node:* builtins, crypto, @/config/env, luxon,
// @ag-ui/client). `src/bff-server/` now means server-only without exception, so this gate has no hole.
//
//   4. INLINE SCRIPTS on the allowlist. Feature 087: every `<script>` without `src` is hashed as a
//      browser hashes it, over the raw body, and compared with `INLINE_SCRIPT_HASHES`, the same list the
//      CSP is built from. A new inline script is a blocked script at runtime, which in the SDK 58 spike
//      meant pages that never hydrated. HTML is fixed at export, so this is exact offline. A regex is
//      enough because `</script>` ends raw text in the HTML grammar.
//
// Usage:
//   node scripts/check-web-bundle-budget.mjs                      # default dist + committed budget
//   node scripts/check-web-bundle-budget.mjs --dist <dir>          # an export's output directory
//   node scripts/check-web-bundle-budget.mjs --budget <bytes>      # override the budget
//   node scripts/check-web-bundle-budget.mjs --require-maps        # a missing map is a FAILURE
//   node scripts/check-web-bundle-budget.mjs --json                # machine-readable report
//   node scripts/check-web-bundle-budget.mjs --selftest            # prove fail and clean paths
//
// Exit codes: 0 within budget / selftest passed · 1 over budget, a forbidden module, a missing or
// ambiguous input, or selftest broken · 2 bad args.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join, dirname, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ArgvError, dieOnArgvError, partitionArgsWithValues, wantsHelp } from './lib/argv-contract.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIST = resolve(HERE, '..', 'frontend', 'mcm-app', 'dist');
const WEB_JS = join('client', '_expo', 'static', 'js', 'web');
const SERVER_HTML = 'server';
const { INLINE_SCRIPT_HASHES } = createRequire(import.meta.url)('../frontend/mcm-app/web-security-headers.js');

/**
 * The committed budget, in bytes.
 *
 * 2,000,000 against a measured 1,762,630 — about 237 KB of room, which is roughly ONE worst-case
 * feature by item #558's own historical measure (+241 KB). Deliberately not generous: enough that an
 * ordinary change does not trip it, little enough that two of them force a conversation.
 *
 * Measured from an export taken WITHOUT local env files, matching what CI does — `EXPO_PUBLIC_*`
 * values are inlined into the bundle, so an export that loaded `.env.local` differs slightly.
 */
export const DEFAULT_BUDGET_BYTES = 2_000_000;

/** Packages the assistant runtime owns. None may reach the ENTRY chunk. */
export const DEFERRED_PACKAGES = [
  'text-encoding',
  'web-streams-polyfill',
  'zod',
  'graphql',
  '@copilotkit/',
  '@ag-ui/',
  'rxjs',
  '@bufbuild/protobuf',
];

/** Server-only code. None may reach ANY client chunk. */
export const SERVER_ONLY = ['src/bff-server/', 'luxon'];

/**
 * Modules on a server-only path that are nevertheless client code.
 *
 * **Empty by design** since item #566 relocated the only entry. Kept as a named constant rather than
 * deleted because the mechanism is the honest way to handle a future genuine case — but an entry here
 * MUST be paired with a `@client-safe: <reason>` marker in the module itself, which
 * `scripts/check-no-server-imports.mjs` reads. The marker is what a reviewer of that file sees; this
 * list is only what the bundle check needs. One without the other is an unexplained hole in whichever
 * gate lacks it.
 */
export const SERVER_ONLY_EXEMPT = [];

export const USAGE = [
  'usage: node scripts/check-web-bundle-budget.mjs [--dist <dir>] [--budget <bytes>] [--json] [--selftest]',
  '',
  '  --dist <dir>       an expo export output directory (default: frontend/mcm-app/dist)',
  '  --budget <bytes>   max cold-load total: every script the worst page loads (default: 2000000)',
  '  --require-maps     treat a missing source map as a failure rather than a visible skip',
  '  --json             emit the report as JSON instead of human text',
  '  --selftest         prove the gate fails over budget and passes under it',
  '  --help             print this and exit without checking',
].join('\n');

const n = (v) => v.toLocaleString('en-US');

/** Every `*.js` chunk in an export's web bundle directory. */
export function chunksIn(distDir) {
  const dir = join(distDir, WEB_JS);
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return { dir, chunks: [], readable: false };
  }
  const chunks = entries
    .filter((f) => f.endsWith('.js'))
    .map((name) => {
      const abs = join(dir, name);
      let mapSources = null;
      try {
        if (statSync(`${abs}.map`).isFile()) {
          mapSources = JSON.parse(readFileSync(`${abs}.map`, 'utf8')).sources ?? [];
        }
      } catch {
        mapSources = null;
      }
      return { name, abs, size: statSync(abs).size, mapSources };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return { dir, chunks, readable: true };
}

const isExemptSource = (src) => SERVER_ONLY_EXEMPT.some((e) => src.includes(e));

/** Which of `needles` appear in `sources`. */
export function matchesIn(sources, needles, { exempt = false } = {}) {
  const hits = new Set();
  for (const src of sources) {
    if (exempt && isExemptSource(src)) continue;
    for (const needle of needles) {
      if (src.includes(needle)) hits.add(needle);
    }
  }
  return [...hits];
}

/** Every `*.html` under a directory, as paths relative to it. A missing directory gives none. */
function htmlFilesIn(root) {
  let entries;
  try {
    entries = readdirSync(root, { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.html'))
    .map((e) => relative(root, join(e.parentPath, e.name)))
    .sort();
}

/** One page's external `/_expo/` scripts and inline script bodies. */
function scriptsIn(html) {
  const external = [];
  const inline = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(m[1])?.[1];
    if (src === undefined) inline.push(m[2]);
    else if (src.startsWith('/_expo/')) external.push(src.split(/[?#]/)[0]);
  }
  return { external, inline };
}

/** The value a CSP needs to allow this inline script. */
const cspHash = (body) => `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`;

/** The cold-load and inline-script assertions, from the exported HTML. */
function checkPages(distDir, budget, allowlist, problems) {
  const serverDir = join(distDir, SERVER_HTML);
  const clientDir = join(distDir, 'client');
  const files = htmlFilesIn(serverDir);
  if (files.length === 0) {
    problems.push(`no *.html under ${serverDir} — an export without pages must not read as clean`);
  }

  let worst = { page: null, bytes: 0, scripts: [] };
  const seen = new Map();
  const unlisted = [];
  for (const page of files) {
    const { external, inline } = scriptsIn(readFileSync(join(serverDir, page), 'utf8'));
    if (external.length === 0) problems.push(`${page}: loads no /_expo/ script, so its cold load cannot be measured`);

    let bytes = 0;
    for (const src of external) {
      const abs = join(clientDir, src);
      if (existsSync(abs)) bytes += statSync(abs).size;
      else problems.push(`${page}: references ${src}, which is missing from ${clientDir}`);
    }
    if (worst.page === null || bytes > worst.bytes) {
      worst = { page, bytes, scripts: external.map((src) => basename(src)) };
    }

    for (const body of inline) {
      const hash = cspHash(body);
      seen.set(hash, (seen.get(hash) ?? 0) + 1);
      if (!allowlist.includes(hash)) unlisted.push({ hash, page });
    }
  }

  const overBy = worst.page === null ? null : worst.bytes - budget;
  if (overBy !== null && overBy > 0) {
    problems.push(
      `cold load of ${worst.page}: ${n(worst.bytes)} B / ${n(budget)} B budget — OVER BY ${n(overBy)} B ` +
        `(${((100 * worst.bytes) / budget).toFixed(1)}%). Scripts: ${worst.scripts.join(', ')}`,
    );
  }
  for (const { hash, page } of unlisted) {
    problems.push(
      `${page}: inline script ${hash} is not on the allowlist, so the browser will block it. ` +
        'INLINE_SCRIPT_HASHES in frontend/mcm-app/web-security-headers.js is a reviewed list: this is the ' +
        'value it would need, not permission to add it',
    );
  }

  return {
    coldLoad: {
      worstPage: worst.page,
      worstBytes: worst.page === null ? null : worst.bytes,
      scripts: worst.scripts,
      pages: files.length,
    },
    inlineScripts: {
      seen: [...seen].map(([hash, pages]) => ({ hash, pages })),
      unlisted,
    },
    overBy,
  };
}

/** Run every assertion. Returns a report; never throws on a bad tree. */
export function check(distDir, budget, { requireMaps = false, allowlist = INLINE_SCRIPT_HASHES } = {}) {
  const { dir, chunks, readable } = chunksIn(distDir);
  const problems = [];
  if (!readable) problems.push(`no web bundle directory at ${dir} — did \`expo export --platform web\` run?`);

  const entries = chunks.filter((c) => c.name.startsWith('entry-'));
  if (readable && entries.length === 0) {
    problems.push(`no entry-*.js in ${dir} — an export that did not produce one must not read as clean`);
  }
  if (entries.length > 1) {
    problems.push(
      `${entries.length} entry-*.js chunks in ${dir} (${entries.map((c) => c.name).join(', ')}) — ` +
        'ambiguous: the size this gate would report is not the size it claims to report',
    );
  }

  const entry = entries.length === 1 ? entries[0] : null;
  const entryBytes = entry ? entry.size : null;

  // (1) and (4): the cold-load total and the inline-script allowlist, from the exported HTML
  const { coldLoad, inlineScripts, overBy } = checkPages(distDir, budget, allowlist, problems);

  // (2) deferred packages must not be in the entry chunk
  let deferredCheck = 'skipped';
  const deferredHits = [];
  if (entry && entry.mapSources) {
    deferredCheck = 'ran';
    deferredHits.push(...matchesIn(entry.mapSources, DEFERRED_PACKAGES));
    for (const hit of deferredHits) {
      problems.push(`\`${hit}\` is back in the ENTRY chunk — the assistant runtime is no longer deferred`);
    }
  }

  // (3) server-only code must not be in ANY client chunk
  let serverCheck = 'skipped';
  const serverHits = [];
  for (const c of chunks) {
    if (!c.mapSources) continue;
    serverCheck = 'ran';
    for (const hit of matchesIn(c.mapSources, SERVER_ONLY, { exempt: true })) {
      serverHits.push({ chunk: c.name, hit });
      problems.push(`\`${hit}\` is in client chunk ${c.name} — server-only code must not ship to a browser`);
    }
  }

  // A missing map disables assertions (2) and (3). The skip is always PRINTED, but in CI that is not
  // enough: an export that quietly stopped emitting maps would leave the byte budget as the only live
  // assertion while the gate still reported OK. `--require-maps` is how the nx target says the
  // artifact must be checkable, so losing `--source-maps` from `export-server` fails loudly instead
  // of narrowing this gate in silence.
  if (requireMaps) {
    if (deferredCheck === 'skipped') {
      problems.push(
        'no entry-chunk source map — the deferred-package assertion could not run. Export with ' +
          '`--source-maps` (the `export-server` nx target does).',
      );
    }
    if (serverCheck === 'skipped') {
      problems.push('no chunk source maps — the server-module assertion could not run.');
    }
  }

  return {
    dir,
    entryBytes,
    budgetBytes: budget,
    coldLoad,
    inlineScripts,
    overBy,
    spare: overBy === null ? null : -overBy,
    chunks: chunks.map((c) => ({ name: c.name, size: c.size, hasMap: Boolean(c.mapSources) })),
    deferredCheck,
    deferredHits,
    serverCheck,
    serverHits,
    requireMaps,
    ok: problems.length === 0,
    problems,
  };
}

function report(r, asJson) {
  if (asJson) {
    console.log(JSON.stringify(r, null, 2));
    return r.ok ? 0 : 1;
  }
  if (r.entryBytes !== null) console.log(`web entry chunk: ${n(r.entryBytes)} B`);
  if (r.coldLoad.worstPage !== null && r.overBy <= 0) {
    const pct = ((100 * r.coldLoad.worstBytes) / r.budgetBytes).toFixed(1);
    console.log(
      `cold load: ${n(r.coldLoad.worstBytes)} B / ${n(r.budgetBytes)} B budget (${pct}%, ${n(r.spare)} B spare), ` +
        `worst page ${r.coldLoad.worstPage} of ${r.coldLoad.pages}, scripts: ${r.coldLoad.scripts.join(', ')}`,
    );
  }
  const inlineTotal = r.inlineScripts.seen.reduce((sum, s) => sum + s.pages, 0);
  console.log(
    `inline scripts: ${r.inlineScripts.seen.length} distinct across ${inlineTotal} occurrence(s), ` +
      `${r.inlineScripts.unlisted.length} not on the allowlist`,
  );
  if (r.deferredCheck === 'ran') {
    console.log(`deferred-package check: ${DEFERRED_PACKAGES.length - r.deferredHits.length}/${DEFERRED_PACKAGES.length} absent from the entry chunk`);
  } else {
    console.log('deferred-package check: SKIPPED — no entry source map (export without --source-maps)');
  }
  if (r.serverCheck === 'ran') {
    console.log(`server-module check:    ${r.serverHits.length} hit(s) across ${r.chunks.filter((c) => c.hasMap).length} client chunk(s)`);
  } else {
    console.log('server-module check:    SKIPPED — no chunk source maps');
  }
  if (r.ok) {
    console.log('OK');
    return 0;
  }
  for (const p of r.problems) console.error(`  ${p}`);
  console.error('');
  console.error('The web cold-load path is what every user waits for before any screen paints.');
  console.error('If this growth is intended, raise DEFAULT_BUDGET_BYTES deliberately and quote the');
  console.error('measured before/after — see specs/087-expo-sdk-58/contracts/web-gates.md.');
  console.error('FAIL');
  return 1;
}

/** Prove the gate fails over budget and passes under it, on synthetic trees. */
function selftest() {
  const root = mkdtempSync(join(tmpdir(), 'bundle-budget-selftest-'));
  const dir = join(root, WEB_JS);
  mkdirSync(dir, { recursive: true });
  const clean = ['/app/src/screens/home/home-screen.tsx'];
  const write = (name, size, sources) => {
    writeFileSync(join(dir, name), 'x'.repeat(size));
    if (sources) writeFileSync(join(dir, `${name}.map`), JSON.stringify({ version: 3, sources, mappings: '' }));
  };
  const tag = (name) => `<script src="/_expo/static/js/web/${name}" defer></script>`;
  const writePage = (tree, name, html) => {
    mkdirSync(join(tree, SERVER_HTML), { recursive: true });
    writeFileSync(join(tree, SERVER_HTML, name), html);
  };
  const pageWithEntry = `<html>${tag('entry-aaa.js')}</html>`;

  write('entry-aaa.js', 500, clean);
  if (check(root, 1000).ok) {
    console.error('SELFTEST BROKEN: a tree with no HTML passed');
    return 1;
  }
  writePage(root, 'index.html', pageWithEntry);
  if (!check(root, 1000).ok) {
    console.error('SELFTEST BROKEN: a clean under-budget tree failed');
    return 1;
  }
  if (check(root, 100).ok) {
    console.error('SELFTEST BROKEN: an over-budget chunk passed');
    return 1;
  }

  write('entry-aaa.js', 500, [...clean, '/node_modules/zod/lib/index.js']);
  if (check(root, 1000).ok) {
    console.error('SELFTEST BROKEN: a deferred package in the entry chunk passed');
    return 1;
  }

  write('entry-aaa.js', 500, clean);
  write('assistant-panel-bbb.js', 10, ['/app/src/bff-server/backup-run-summary.ts']);
  if (check(root, 1000).ok) {
    console.error('SELFTEST BROKEN: server code in the DEFERRED chunk passed');
    return 1;
  }

  // The Utils-Layer transport is fine; anything still under src/bff-server/ is not, because #566
  // emptied the exemption list after confirming every remaining module there is server-only.
  write('assistant-panel-bbb.js', 10, ['/app/src/utils/api-client.ts']);
  if (!check(root, 1000).ok) {
    console.error('SELFTEST BROKEN: the Utils-Layer api-client was flagged');
    return 1;
  }
  write('assistant-panel-bbb.js', 10, ['/app/src/bff-server/api-client.ts']);
  if (check(root, 1000).ok) {
    console.error('SELFTEST BROKEN: a bff-server module passed with an empty exemption list');
    return 1;
  }
  write('assistant-panel-bbb.js', 10, ['/app/src/utils/api-client.ts']);

  // Two chunks that fit the budget apart but not together, which an entry-only gate cannot see.
  write('route-ccc.js', 600, clean);
  writePage(root, 'split.html', `<html>${tag('entry-aaa.js')}${tag('route-ccc.js')}</html>`);
  if (check(root, 1000).ok) {
    console.error('SELFTEST BROKEN: two chunks over budget together passed');
    return 1;
  }
  if (!check(root, 1100).ok) {
    console.error('SELFTEST BROKEN: two chunks exactly at budget failed');
    return 1;
  }

  writePage(root, 'split.html', `<html>${tag('entry-aaa.js')}${tag('gone-ddd.js')}</html>`);
  if (check(root, 1000).ok) {
    console.error('SELFTEST BROKEN: a page referencing a missing file passed');
    return 1;
  }

  writePage(root, 'split.html', '<html></html>');
  if (check(root, 1000).ok) {
    console.error('SELFTEST BROKEN: a page with no scripts passed');
    return 1;
  }

  writePage(root, 'split.html', `<html><script>window.x=1</script>${tag('entry-aaa.js')}</html>`);
  if (check(root, 1000).ok) {
    console.error('SELFTEST BROKEN: an unlisted inline script passed');
    return 1;
  }
  const hash = cspHash('window.x=1');
  if (!check(root, 1000, { allowlist: [hash] }).ok) {
    console.error('SELFTEST BROKEN: an allow-listed inline script failed');
    return 1;
  }
  writePage(root, 'split.html', pageWithEntry);

  // A map-less tree: a visible skip by default, a FAILURE under --require-maps.
  const bare = mkdtempSync(join(tmpdir(), 'bundle-budget-selftest-nomap-'));
  mkdirSync(join(bare, WEB_JS), { recursive: true });
  writeFileSync(join(bare, WEB_JS, 'entry-aaa.js'), 'x'.repeat(10));
  writePage(bare, 'index.html', pageWithEntry);
  if (!check(bare, 1000).ok) {
    console.error('SELFTEST BROKEN: a map-less tree failed without --require-maps');
    return 1;
  }
  if (check(bare, 1000, { requireMaps: true }).ok) {
    console.error('SELFTEST BROKEN: a map-less tree passed WITH --require-maps');
    return 1;
  }

  console.log('selftest ok: under budget passes; over budget, a deferred package in entry, and server code in any chunk all fail; the Utils-Layer transport passes while any bff-server module fails; --require-maps rejects a map-less export; no HTML, a page with no scripts, a missing script, two chunks over budget together and an unlisted inline script all fail, while an allow-listed one passes');
  return 0;
}

function main(argv) {
  if (wantsHelp(argv)) {
    console.log(USAGE);
    return 0;
  }
  let parsed;
  try {
    parsed = partitionArgsWithValues(argv, {
      accepted: ['--json', '--selftest', '--require-maps'],
      withValues: ['--dist', '--budget'],
      usage: USAGE,
    });
  } catch (err) {
    dieOnArgvError(err, { hard: false });
    return 2;
  }
  if (parsed.flags.has('--selftest')) return selftest();

  const distDir = resolve(parsed.values.get('--dist') ?? DEFAULT_DIST);
  const rawBudget = parsed.values.get('--budget');
  const budget = rawBudget === undefined ? DEFAULT_BUDGET_BYTES : Number(rawBudget);
  if (!Number.isFinite(budget) || budget <= 0) {
    console.error(`--budget must be a positive number of bytes, got: ${rawBudget}\n\n${USAGE}`);
    return 2;
  }
  return report(check(distDir, budget, { requireMaps: parsed.flags.has('--require-maps') }), parsed.flags.has('--json'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
