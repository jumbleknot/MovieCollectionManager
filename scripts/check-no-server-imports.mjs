#!/usr/bin/env node
// Keyless gate for feature 077 (FR-011): no client-side code may import a BFF-server module.
//
// THE CONSTITUTION CLAUSE. Frontend Separation of Concerns, BFF-Layer: it "must run server-side and
// never be included client-side." Nothing enforced that, and the violation is silent — it does not
// break a build, fail a test, or show up in review as anything more than a plausible import.
//
// THE MEASURED COST. `src/components/backups/run-history.tsx` imported five pure formatting helpers
// from `@/bff-server/backup-run-summary`. That module imports `luxon`, so every user downloaded
// 70 KB of date library on every route to render one timestamp — 4.2% of the post-077 entry chunk,
// and its largest non-framework item. Feature 077 moved the helpers to the Utils-Layer, where their
// own header already said they belonged ("every input is an argument"). This gate is what stops the
// next one.
//
// WHAT THE RULE IS, precisely. Not "nothing under src/bff-server/ may be imported by a component"
// — that is broader than the constitution and broader than the truth. Running the first version of
// this gate over the real tree found 18 client files importing `@/bff-server/api-client`, which is
// an axios wrapper that carries the browser's own cookies to the BFF. It is CLIENT code sitting in a
// confusingly-named directory, not server code leaking out. Measured: exactly two bff-server modules
// reach the web bundle — `api-client.ts` (intended) and `backup-run-summary.ts` (the leak).
//
// So a module under `src/bff-server/` may declare itself client-safe with a `@client-safe` marker
// comment plus a reason, and the gate exempts it. The exemption lives IN THE MODULE, deliberately,
// rather than in an allowlist here: an allowlist in the gate rots silently and is invisible to
// anyone reading the module, whereas a marker is in front of every reviewer of the file it excuses,
// and adding one is an edit to the thing being excused. `api-client.ts` carries the only one today.
// The directory itself is misnamed; relocating it is tracked separately (item #566) because it
// touches 18 files and saves zero bytes.
//
// WHAT IS DELIBERATELY NOT FLAGGED, and why each would make the gate worse:
//   - `src/bff-server/**` importing its own siblings — correct by definition.
//   - `src/app/**/*+api.ts` — API routes ARE the sanctioned server-side consumer.
//   - `import type` — erased at compile time, ships nothing. A gate that fires here teaches people
//     to suppress it, and a suppressed gate catches nothing.
//   - test files — they exercise the server module directly, which is the point of them.
//   - a module carrying `@client-safe` — see above.
//
// Usage:
//   node scripts/check-no-server-imports.mjs                 # scan; exit 1 on any violation
//   node scripts/check-no-server-imports.mjs --src <dir>      # scan a different src root (tests)
//   node scripts/check-no-server-imports.mjs --selftest       # prove detection and the clean path
//
// Exit codes: 0 clean / selftest passed · 1 violation found / selftest broken · 2 bad args.
import { readdirSync, readFileSync, statSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, dirname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ArgvError, dieOnArgvError, partitionArgsWithValues, wantsHelp } from './lib/argv-contract.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SRC = resolve(HERE, '..', 'frontend', 'mcm-app', 'src');
const SERVER_DIR = 'bff-server';

export const USAGE = [
  'usage: node scripts/check-no-server-imports.mjs [--src <dir>] [--selftest]',
  '',
  '  --src <dir>   the frontend src root to scan (default: frontend/mcm-app/src)',
  '  --selftest    prove the gate detects a planted violation and passes a clean tree',
  '  --help        print this and exit without scanning',
].join('\n');

const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

/** Every code file under `dir`, as absolute paths. */
export function codeFiles(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '__snapshots__') continue;
        walk(abs);
        continue;
      }
      const dot = e.name.lastIndexOf('.');
      if (dot !== -1 && CODE_EXT.has(e.name.slice(dot))) out.push(abs);
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * Is this file exempt from the rule?
 *
 * `relPath` is POSIX-style and relative to the src root.
 */
export function isExempt(relPath) {
  if (relPath === SERVER_DIR || relPath.startsWith(`${SERVER_DIR}/`)) return true;
  if (/\+api\.[cm]?[jt]sx?$/.test(relPath)) return true;
  if (/(^|\/)(unit-tests|__tests__|integration-tests)\//.test(relPath)) return true;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(relPath)) return true;
  return false;
}

// `from '<specifier>'`, `require('<specifier>')`, `import('<specifier>')`.
//
// `[\s\S]` rather than `.` in the import body, and matched over the WHOLE FILE rather than line by
// line. The first version of this gate was line-based and reported the real tree clean of the one
// import it was written for — `run-history.tsx`'s is spread over five lines, so the `import` keyword
// and the `from '...'` never appeared on the same line. A gate that cannot see the violation it was
// built for is worse than no gate, because it certifies the absence.
const SPECIFIER = /(?:^|[^\w$])(?:(import|export)\s+(type\s+)?[\s\S]*?from|require|import)\s*\(?\s*['"]([^'"]+)['"]/g;

/**
 * Does `specifier`, written inside the file at `relPath`, resolve into the server directory?
 *
 * Both the `@/` alias and a relative walk are checked. A gate that only knew the alias would be
 * bypassed by `../../bff-server/x` — the shape a mechanical refactor produces.
 */
export function resolvesIntoServerDir(specifier, relPath) {
  if (specifier.startsWith('@/')) {
    const rest = specifier.slice(2);
    return rest === SERVER_DIR || rest.startsWith(`${SERVER_DIR}/`);
  }
  if (specifier.startsWith('.')) {
    const joined = resolve('/', dirname(relPath), specifier).slice(1);
    const posix = joined.split(sep).join('/');
    return posix === SERVER_DIR || posix.startsWith(`${SERVER_DIR}/`);
  }
  return false;
}

/** Every violation in one file's text, as `{ line, specifier }`. */
export function scanText(text, relPath) {
  const hits = [];
  SPECIFIER.lastIndex = 0;
  let m;
  while ((m = SPECIFIER.exec(text)) !== null) {
    if (m[2]) continue; // `import type` / `export type` — erased, ships nothing
    const specifier = m[3];
    if (!resolvesIntoServerDir(specifier, relPath)) continue;
    // Line of the SPECIFIER, not of the `import` keyword: for a multi-line import the specifier is
    // where a reader must go to fix it.
    const upto = text.slice(0, m.index + m[0].length);
    hits.push({ line: upto.split('\n').length, specifier });
  }
  return hits;
}

// A module under src/bff-server/ that says, in itself, that it is client code. The reason is
// required: a bare marker is an allowlist entry wearing a different hat.
const CLIENT_SAFE = /@client-safe\b[ \t]*:?[ \t]*(\S[^\n]*)/;

/** Is the bff-server module this specifier names declared client-safe, with a reason? */
export function isClientSafeModule(specifier, srcRoot) {
  const rest = specifier.startsWith('@/') ? specifier.slice(2) : null;
  if (!rest) return false;
  for (const ext of ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx']) {
    const abs = join(srcRoot, `${rest}${ext}`);
    let text;
    try {
      if (!statSync(abs).isFile()) continue;
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const m = CLIENT_SAFE.exec(text);
    return Boolean(m && m[1] && m[1].trim().length >= 10);
  }
  return false;
}

/** Scan a src root. Returns the violations found. */
export function runScan(srcRoot) {
  const violations = [];
  for (const abs of codeFiles(srcRoot)) {
    const relPath = relative(srcRoot, abs).split(sep).join('/');
    if (isExempt(relPath)) continue;
    for (const hit of scanText(readFileSync(abs, 'utf8'), relPath)) {
      if (isClientSafeModule(hit.specifier, srcRoot)) continue;
      violations.push({ file: relPath, ...hit });
    }
  }
  return violations;
}

function report(violations, srcRoot) {
  if (!violations.length) {
    console.log(`no client-side import of src/${SERVER_DIR} found (scanned ${srcRoot})`);
    return 0;
  }
  console.error(`client-side imports of src/${SERVER_DIR} (${violations.length}):`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  imports  ${v.specifier}`);
  }
  console.error('');
  console.error("The BFF-Layer must run server-side and never be included client-side. A server");
  console.error('module reached from a component ships its whole dependency tree to the browser —');
  console.error('this rule exists because one such import shipped 70 KB of `luxon` to every user.');
  console.error('Move the code the component needs into src/utils/ (if it is pure), or fetch the');
  console.error('derived value through the BFF instead of importing the module.');
  console.error('');
  console.error('If the module is genuinely CLIENT code that merely lives in this directory, say so');
  console.error('in the module itself with an `@client-safe: <reason>` comment. The reason is');
  console.error('required, and it belongs in the file so the next reader sees it.');
  return 1;
}

/** Plant a violation, prove it is caught; then prove a clean tree passes. */
function selftest() {
  const root = mkdtempSync(join(tmpdir(), 'no-server-imports-selftest-'));
  const src = join(root, 'src');
  mkdirSync(join(src, 'components'), { recursive: true });
  mkdirSync(join(src, SERVER_DIR), { recursive: true });
  writeFileSync(join(src, SERVER_DIR, 'thing.ts'), "export const x = 1;\n");

  const clean = join(src, 'components', 'clean.tsx');
  writeFileSync(clean, "import { x } from '@/utils/thing';\n");
  if (runScan(src).length !== 0) {
    console.error('SELFTEST BROKEN: a clean tree was flagged');
    return 1;
  }

  writeFileSync(clean, "import { x } from '@/bff-server/thing';\n");
  const aliased = runScan(src);
  if (aliased.length !== 1 || aliased[0].file !== 'components/clean.tsx') {
    console.error('SELFTEST BROKEN: a planted aliased import was not detected');
    return 1;
  }

  writeFileSync(clean, "import { x } from '../bff-server/thing';\n");
  if (runScan(src).length !== 1) {
    console.error('SELFTEST BROKEN: a planted RELATIVE import was not detected');
    return 1;
  }

  writeFileSync(clean, "import type { X } from '@/bff-server/thing';\n");
  if (runScan(src).length !== 0) {
    console.error('SELFTEST BROKEN: a type-only import was flagged');
    return 1;
  }

  // Multi-line: the shape that defeated the first version of this gate.
  writeFileSync(clean, "import {\n  a,\n  b,\n} from '@/bff-server/thing';\n");
  if (runScan(src).length !== 1) {
    console.error('SELFTEST BROKEN: a MULTI-LINE import was not detected');
    return 1;
  }

  // The marker exempts, and only with a reason.
  writeFileSync(join(src, SERVER_DIR, 'thing.ts'), "// @client-safe: runs in the browser, carries the BFF cookies\nexport const x = 1;\n");
  if (runScan(src).length !== 0) {
    console.error('SELFTEST BROKEN: a @client-safe module was still flagged');
    return 1;
  }
  writeFileSync(join(src, SERVER_DIR, 'thing.ts'), "// @client-safe\nexport const x = 1;\n");
  if (runScan(src).length !== 1) {
    console.error('SELFTEST BROKEN: a bare @client-safe marker with no reason was honoured');
    return 1;
  }

  console.log('selftest ok: clean passes; aliased, relative and multi-line violations detected; type-only ignored; @client-safe honoured only with a reason');
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
      accepted: ['--selftest'],
      withValues: ['--src'],
      usage: USAGE,
    });
  } catch (err) {
    dieOnArgvError(err, { hard: false });
    return 2;
  }
  if (parsed.flags.has('--selftest')) return selftest();
  const srcRoot = resolve(parsed.values.get('--src') ?? DEFAULT_SRC);
  return report(runScan(srcRoot), srcRoot);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
